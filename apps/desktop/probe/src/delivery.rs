//! Probe-owned upload jobs and durable delivery state.
//!
//! Records come from `ai-hist`'s change feed. A job's position is a feed
//! revision: an all-sources job drains every change of its kinds from the
//! feed's start, which is its bootstrap, and then follows the feed from where
//! it stopped. A selected-sessions job follows the feed for its members only,
//! and each member added to it is backfilled with a drain of that session from
//! the feed's start to the head at the time it was added. Nothing is copied
//! out of the evidence tables until a batch is prepared from them.
//!
//! A job's unresolved batches are immutable; their records and optional
//! destination bodies survive crashes. A worker delivering one batch at a time
//! keeps at most one; a pipelined worker keeps up to its window, each covering
//! the next stretch of the feed, and claims them oldest first under one job
//! lease. The job's acknowledged position only moves through a contiguous run
//! of acknowledged batches, so a batch that failed holds it back while later
//! ones that were acknowledged stay delivered. Batches are claimed by their
//! feed end (`journal_end`), then by preparation order; a session job's backfill batches share one
//! end, and the position passes an end only once every batch ending there has
//! resolved. Acknowledgment requires every revision
//! and a durable remote acceptance level. Delivery is at least once; receiver
//! idempotency and stale-revision rejection are necessary to prevent duplicate
//! effects after uncertain outcomes. Consent — the job's kinds, its members
//! and `delivery_exclusions` — is checked when a batch is prepared and again
//! when it is claimed and dispatched. Deletes are sent as tombstones. Pausing
//! preserves the job's position; cancellation is an explicit discard.
//!
//! A record's revision is the feed revision plus this origin's
//! `revision_base`, which keeps every revision above the highest this origin
//! has sent, including across a replaced database.

mod feed;
mod schema;
mod sessions;
use feed::record_from_change;
pub use feed::{SessionStates, StatusCache, UploadPositions};
pub use sessions::{
    adopt_session_job, create_session_job, delegating_session, include_job_session, is_session_job,
    job_delegated_sessions, job_selected_sessions, job_session_included, job_sessions,
    native_grok_subagent, set_job_session, sync_delegated_members,
};

pub mod worker;
use anyhow::{ensure, Context, Result};
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

/// The upload record format version.
pub const EXPORT_SCHEMA_VERSION: u32 = 1;
/// Every evidence kind a job may select: the change feed's kind names.
pub const SUPPORTED_KINDS: &[&str] = &[
    "history",
    "session_event",
    "tool_call",
    "file_edit",
    "session",
    "presence",
    "relationship",
    "commit_link",
    "source_observation",
    "observation_evidence",
    "session_marker",
];
/// Evidence kinds the probe no longer selects or drains. A job stored, or a
/// configuration sent, by an older build may still list one: it is dropped
/// on load and on receipt instead of failing the job, since the store this
/// build reads may no longer carry that kind at all.
pub const RETIRED_KINDS: &[&str] = &["trajectory"];

/// `selection` without the [`RETIRED_KINDS`] an older build selected.
fn drop_retired_kinds(selection: &mut ExportSelection) {
    selection
        .kinds
        .retain(|kind| !RETIRED_KINDS.contains(&kind.as_str()));
}

/// One session, as the store names it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct SessionIdentity {
    pub source: String,
    pub session_id: String,
}

/// A nonempty explicit selection. Sources and sessions form a union. Empty
/// lists select nothing unless all_sources is true; kinds must be explicit.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExportSelection {
    pub all_sources: bool,
    pub sources: Vec<String>,
    pub sessions: Vec<SessionIdentity>,
    pub kinds: Vec<String>,
    pub excluded_sessions: Vec<SessionIdentity>,
    /// Records that name no session — a prompt logged without one — are
    /// shared. No exclusion can withhold such a record, so only a job that
    /// shares everything selects them.
    #[serde(default)]
    pub sessionless: bool,
}

/// One upload record: a revision of one stored evidence row.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HistoryExportRecord {
    pub schema_version: u32,
    pub origin_id: String,
    pub record_id: String,
    pub revision_id: String,
    pub revision: i64,
    pub kind: String,
    pub source: String,
    pub session_id: Option<String>,
    pub operation: String,
    /// The row's stored columns under their own names, raw JSON strings
    /// kept as strings. A tombstone has a null payload and retains its
    /// logical record identity.
    pub payload: serde_json::Value,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DeliveryLimits {
    pub max_batch_records: usize,
    pub max_batch_bytes: usize,
    /// Bounds the feed changes one preparation examines, including
    /// excluded and unselected ones.
    pub max_scan_records: usize,
    /// Bounds the destination body as retained: the JSON envelope around it,
    /// not the body's own length.
    pub max_prepared_bytes: usize,
}
/// The receiver's request cap, 2 MiB, less room for the request envelope
/// around the batch (`{"protocolVersion":1,"batch":…}`) and the wire repair
/// of a body prepared by an older build.
const DEFAULT_BATCH_BYTES: usize = 2_097_152 - REQUEST_ROOM;
/// Room a batch leaves below the receiver's request cap.
const REQUEST_ROOM: usize = 65_536;
/// A retained body is the request escaped as a JSON string, which can double
/// it, inside a small envelope. This cap lets every body the receiver's 2 MiB
/// request cap admits be retained; that cap itself is enforced on the body.
const DEFAULT_PREPARED_BYTES: usize = 2 * 2_097_152 + 65_536;
impl Default for DeliveryLimits {
    fn default() -> Self {
        Self {
            max_batch_records: DEFAULT_BATCH_RECORDS,
            max_batch_bytes: DEFAULT_BATCH_BYTES,
            max_scan_records: 400,
            max_prepared_bytes: DEFAULT_PREPARED_BYTES,
        }
    }
}
impl DeliveryLimits {
    /// The defaults of builds before batches grew toward the receiver's
    /// request cap: 1 MiB batches, 2 MiB retained bodies.
    const FORMER_DEFAULT: Self = Self {
        max_batch_records: 100,
        max_batch_bytes: 1_048_576,
        max_scan_records: 400,
        max_prepared_bytes: 2_097_152,
    };
    /// The limits a stored generation runs with. A generation created with a
    /// former build's defaults never chose them, so it runs with the current
    /// defaults, which every body it already holds also fits; the stored row
    /// is left as written, so an older build reading it sees what it wrote.
    /// Limits anyone set explicitly are kept.
    fn effective(self) -> Self {
        if self == Self::FORMER_DEFAULT {
            Self::default()
        } else {
            self
        }
    }
}
/// A stored job configuration, with the limits it runs under.
fn stored_config(text: &str) -> Result<DeliveryJobConfig> {
    let mut config: DeliveryJobConfig = serde_json::from_str(text)?;
    config.limits = config.limits.effective();
    drop_retired_kinds(&mut config.selection);
    Ok(config)
}

/// The protocol's record cap per batch, which a job uses until its
/// destination publishes another.
pub const DEFAULT_BATCH_RECORDS: usize = 100;
/// The most records per batch a destination's published limit can raise the
/// cap to, whatever it publishes.
pub const MAX_PUBLISHED_BATCH_RECORDS: usize = 500;

/// Feed changes the default limits examine per record they admit.
const SCAN_PER_RECORD: usize = 4;
/// The most feed changes one preparation may examine.
const MAX_SCAN_RECORDS: usize = 10_000;

/// Batch limits a destination published with its last receipt. They size the
/// batches prepared next, never one already prepared: a batch is immutable.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PublishedLimits {
    /// The most records the destination accepts in one batch.
    pub max_records: Option<usize>,
    /// The most bytes the destination accepts in one request.
    pub max_request_bytes: Option<usize>,
}
impl DeliveryLimits {
    /// These limits as a destination's published ones adjust them. A
    /// published record limit replaces the protocol default, up to
    /// [`MAX_PUBLISHED_BATCH_RECORDS`], and lowers any other cap a job was
    /// configured with but never raises it. The scan budget grows with a
    /// raised record cap, keeping the default's four changes examined per
    /// record admitted, so a raised cap can actually be filled. A published
    /// request size only ever lowers the byte cap, keeping the default's room
    /// for the request envelope. Nothing published leaves them unchanged.
    pub fn with_published(mut self, published: PublishedLimits) -> Self {
        if let Some(records) = published.max_records {
            let records = records.max(1);
            self.max_batch_records = if self.max_batch_records == DEFAULT_BATCH_RECORDS {
                records.min(MAX_PUBLISHED_BATCH_RECORDS)
            } else {
                self.max_batch_records.min(records)
            };
            self.max_scan_records = self
                .max_scan_records
                .max(self.max_batch_records * SCAN_PER_RECORD)
                .min(MAX_SCAN_RECORDS);
        }
        if let Some(bytes) = published.max_request_bytes {
            self.max_batch_bytes = self
                .max_batch_bytes
                .min(bytes.saturating_sub(REQUEST_ROOM).max(512));
        }
        self
    }
}

/// All identifiers are non-secret application labels. Never put authentication
/// material in configuration. A new selection/mapping/account requires a new
/// generation after the old job is explicitly cancelled, not cursor reuse.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DeliveryJobConfig {
    pub destination_id: String,
    pub instance_id: String,
    pub account_id: String,
    pub mapping_version: String,
    pub selection: ExportSelection,
    pub limits: DeliveryLimits,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HistoryExportBatch {
    pub schema_version: u32,
    pub origin_id: String,
    pub batch_id: String,
    pub job_id: String,
    pub generation: i64,
    pub destination_id: String,
    pub instance_id: String,
    pub account_id: String,
    pub mapping_version: String,
    pub records: Vec<HistoryExportRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DeliveryLease {
    pub job_id: String,
    pub batch_id: String,
    pub worker_id: String,
    pub fence: i64,
    pub expires_at_ms: i64,
}

/// The build identity [`PreparedPayload::prepared_by`] records: the probe's
/// version and the Git revision it was built from.
pub const THIS_BUILD: &str = concat!(
    env!("RELAY_DESKTOP_VERSION"),
    "@",
    env!("RELAY_DESKTOP_REVISION")
);

/// Destination body only, without authorization headers or credentials.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PreparedPayload {
    pub mapping_version: String,
    pub content_type: String,
    pub body: String,
    pub sha256: String,
    /// The build whose receiver produced `body` with [`Receiver::prepare`]:
    /// the worker records it when it stores that body. A receiver that sees
    /// its own build here, with `sha256` matching `body`, holds exactly the
    /// bytes its own `prepare` returned. None for a body stored otherwise.
    ///
    /// [`Receiver::prepare`]: worker::Receiver::prepare
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prepared_by: Option<String>,
}
impl PreparedPayload {
    /// The destination body as it is retained: a JSON envelope whose escaping
    /// of the body can far exceed the body's own length.
    pub fn stored(
        mapping_version: &str,
        content_type: &str,
        body: &str,
        prepared_by: Option<&str>,
    ) -> Self {
        Self {
            mapping_version: mapping_version.into(),
            content_type: content_type.into(),
            body: body.into(),
            sha256: hash(body),
            prepared_by: prepared_by.map(str::to_owned),
        }
    }
    /// Whether this build's receiver produced `body`. It holds those exact
    /// bytes only while `sha256` matches `body`, which the caller checks.
    pub fn prepared_by_this_build(&self) -> bool {
        self.prepared_by.as_deref() == Some(THIS_BUILD)
    }
    /// The exact bytes the batch row holds for this payload, which is what
    /// `max_prepared_bytes` bounds.
    pub fn retained_bytes(&self) -> Result<usize> {
        serialized_len(self)
    }
}
/// A payload with the exact text its batch row retains, hashed and serialized
/// once, before the journal's write lock is taken: a pipelined drain builds it
/// on a sender thread.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RetainedPayload {
    payload: PreparedPayload,
    text: String,
}
impl RetainedPayload {
    pub(crate) fn new(payload: PreparedPayload) -> Result<Self> {
        let text = serde_json::to_string(&payload)?;
        Ok(Self { payload, text })
    }
    /// [`PreparedPayload::retained_bytes`], which `max_prepared_bytes` bounds.
    pub(crate) fn len(&self) -> usize {
        self.text.len()
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ClaimedBatch {
    pub lease: DeliveryLease,
    pub batch: HistoryExportBatch,
    pub prepared: Option<PreparedPayload>,
    /// Durable receiver progress for a partially isolated immutable batch.
    pub accepted_revision_ids: Vec<String>,
    pub suppressed_revision_ids: Vec<String>,
    /// Singleton rejections found before any accepted sibling proves that the
    /// receiver accepts this schema. These are isolation progress, not skips.
    pub rejected_revision_ids: Vec<String>,
    pub isolation_frontier: Vec<IsolationTask>,
}

/// A receiver-proven conflict with the exact submitted body. Only this
/// allowlisted identity and digest data crosses the transport boundary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConflictRecord {
    pub record_id: String,
    pub revision_id: String,
    pub revision: i64,
    pub submitted_digest: String,
    pub current_digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConflictRecovery {
    pub parent_batch_id: String,
    pub submitted_digest: String,
    pub quarantined: Vec<ConflictRecord>,
    pub child_batch_id: String,
}

/// Why a receiver-proven conflict could not be committed. The worker treats
/// these classes differently: an invalid plan is a truthful permanent
/// conflict, local storage trouble is retryable, and lost ownership must
/// remain a fence rather than mutate another worker's claim.
#[derive(Debug)]
pub(crate) enum ConflictRecoveryError {
    Rejected(anyhow::Error),
    Fenced,
    Storage(anyhow::Error),
}
impl std::fmt::Display for ConflictRecoveryError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Rejected(_) => "delivery conflict recovery plan was rejected",
            Self::Fenced => "delivery conflict recovery lease was fenced",
            Self::Storage(_) => "delivery conflict recovery storage failed",
        })
    }
}
impl std::error::Error for ConflictRecoveryError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Rejected(error) | Self::Storage(error) => Some(error.as_ref()),
            Self::Fenced => None,
        }
    }
}

/// A durable node in a destination's rejected-batch isolation search.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct IsolationTask {
    pub revision_ids: Vec<String>,
    /// True when the receiver already rejected this exact subset. Such a node
    /// can be split locally before another request is needed.
    pub rejected: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AcceptanceLevel {
    Durable,
    Indexed,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DeliveryAcknowledgment {
    pub batch_id: String,
    /// Exact revision_ids, not bare record IDs or a remote high-water mark.
    pub accepted_revision_ids: Vec<String>,
    /// Revisions the receiver cannot handle under the current protocol. These
    /// block the job so a receiver upgrade can accept them later.
    pub unsupported_revision_ids: Vec<String>,
    /// Revisions proven, by transport isolation, to be individually rejected
    /// while sibling revisions are accepted. This is an internal adapter
    /// result and is never populated directly from a receiver receipt.
    #[serde(default)]
    pub suppressed_revision_ids: Vec<String>,
    /// Provisional singleton rejections. Core persists these so an interrupted
    /// isolation resumes, but never advances or counts them as skipped.
    #[serde(default)]
    pub rejected_revision_ids: Vec<String>,
    /// Unfinished isolation search nodes. Core persists the snapshot without
    /// interpreting it as acceptance or suppression.
    #[serde(default)]
    pub isolation_frontier: Vec<IsolationTask>,
    pub acceptance_level: AcceptanceLevel,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryFailure {
    Transient,
    RateLimited,
    AuthenticationRequired,
    PermissionDenied,
    InvalidPayload,
    ReceiverRejected,
    UnsupportedEvidence,
    MappingVersionMismatch,
    DeliveryConflict,
}
impl DeliveryFailure {
    fn retryable(self) -> bool {
        matches!(self, Self::Transient | Self::RateLimited)
    }
    fn code(self) -> &'static str {
        match self {
            Self::Transient => "transient",
            Self::RateLimited => "rate_limited",
            Self::AuthenticationRequired => "authentication_required",
            Self::PermissionDenied => "permission_denied",
            Self::InvalidPayload => "invalid_payload",
            Self::ReceiverRejected => "receiver_rejected",
            Self::UnsupportedEvidence => "unsupported_evidence",
            Self::MappingVersionMismatch => "mapping_version_mismatch",
            Self::DeliveryConflict => "delivery_conflict",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DeliveryStatus {
    pub job_id: String,
    pub config: DeliveryJobConfig,
    pub generation: i64,
    pub state: String,
    /// An all-sources job has drained the feed to its head once; a session
    /// job has backfilled every member.
    pub bootstrap_complete: bool,
    /// The feed revision the job has accounted for.
    pub journal_cursor: i64,
    /// The feed revision its acknowledged batches account for: the end of
    /// the longest run of acknowledged batches with no unacknowledged batch
    /// before it, so a batch that failed holds it back even while later
    /// batches are acknowledged.
    pub acknowledged_cursor: i64,
    pub pending_records: i64,
    pub pending_bytes: i64,
    pub oldest_pending_ms: Option<i64>,
    pub unqueued_changes: i64,
    pub next_attempt_ms: i64,
    pub last_attempt_ms: Option<i64>,
    /// Consecutive claims since the last fully successful delivery window.
    pub attempts: i64,
    pub last_acknowledged_ms: Option<i64>,
    pub acceptance_level: Option<String>,
    pub failure: Option<String>,
    /// Records suppressed only after receiver-side isolation proved a sibling
    /// record was accepted. Policy exclusions remain in `suppressed_records`.
    pub skipped_records: i64,
    /// Receiver-proven record revisions retained for inspection and repair.
    #[serde(default)]
    pub quarantined_records: i64,
    pub suppressed_records: i64,
    pub acknowledged_records: i64,
}

/// A retryable transport failure becomes user-actionable only after it has
/// persisted across several attempts and delivery has made no recent progress.
pub const SUSTAINED_FAILURE_MS: i64 = 5 * 60 * 1_000;
pub const SUSTAINED_FAILURE_ATTEMPTS: i64 = 3;

pub fn retry_failure_is_sustained(
    attempts: i64,
    last_acknowledged_ms: Option<i64>,
    oldest_pending_ms: Option<i64>,
    now_ms: i64,
) -> bool {
    attempts >= SUSTAINED_FAILURE_ATTEMPTS
        && without_progress(last_acknowledged_ms, oldest_pending_ms, now_ms)
}

/// Queued records have had no acknowledgement for `SUSTAINED_FAILURE_MS`,
/// whatever the failure, or with none reported.
pub fn delivery_is_stalled(
    pending_records: i64,
    last_acknowledged_ms: Option<i64>,
    oldest_pending_ms: Option<i64>,
    now_ms: i64,
) -> bool {
    pending_records > 0 && without_progress(last_acknowledged_ms, oldest_pending_ms, now_ms)
}

/// No acknowledgement for `SUSTAINED_FAILURE_MS`. Idle time before new work
/// was queued is not stalled delivery, so when both exist this measures from
/// whichever happened later.
fn without_progress(
    last_acknowledged_ms: Option<i64>,
    oldest_pending_ms: Option<i64>,
    now_ms: i64,
) -> bool {
    let progress_at = [last_acknowledged_ms, oldest_pending_ms]
        .into_iter()
        .flatten()
        .max();
    progress_at.is_some_and(|at| now_ms.saturating_sub(at) >= SUSTAINED_FAILURE_MS)
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PrepareResult {
    pub batch_id: Option<String>,
    pub scanned_records: usize,
    pub bootstrap_complete: bool,
}

#[derive(Debug)]
struct Job {
    id: String,
    config: DeliveryJobConfig,
    generation: i64,
    state: String,
    /// The feed revision this job has accounted for: every change at or below
    /// it is in a batch or was not eligible.
    cursor: i64,
    /// An all-sources job has drained the feed to its head at least once.
    caught_up: bool,
}
fn job(conn: &Connection, id: &str) -> Result<Job> {
    let value = conn
        .query_row(
            "SELECT config_json,generation,state,journal_cursor,bootstrap_done FROM delivery_jobs WHERE id=?",
            [id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get::<_, bool>(4)?,
                ))
            },
        )
        .optional()?
        .context("delivery job not found")?;
    Ok(Job {
        id: id.into(),
        config: stored_config(&value.0)?,
        generation: value.1,
        state: value.2,
        cursor: value.3,
        caught_up: value.4,
    })
}
fn write_transaction(conn: &Connection) -> Result<Transaction<'_>> {
    ensure!(
        conn.is_autocommit(),
        "delivery operations require their own short transaction"
    );
    Ok(Transaction::new_unchecked(
        conn,
        TransactionBehavior::Immediate,
    )?)
}
fn hash(value: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(value.as_ref()))
}
fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 200
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.:/@".contains(&b))
}
fn validate(config: &DeliveryJobConfig) -> Result<()> {
    for value in [
        &config.destination_id,
        &config.instance_id,
        &config.account_id,
        &config.mapping_version,
    ] {
        ensure!(
            identifier(value),
            "delivery identifiers must be nonempty non-secret labels (maximum 200 characters)"
        );
    }
    let selection = &config.selection;
    ensure!(
        selection.all_sources || !selection.sources.is_empty() || !selection.sessions.is_empty(),
        "explicit export source/session selection required"
    );
    ensure!(
        !selection.kinds.is_empty()
            && selection
                .kinds
                .iter()
                .all(|kind| SUPPORTED_KINDS.contains(&kind.as_str())),
        "unsupported or empty export evidence selection"
    );
    ensure!(
        serde_json::to_vec(config)?.len() <= 65_536,
        "delivery configuration too large"
    );
    let limits = &config.limits;
    ensure!(
        (1..=10_000).contains(&limits.max_batch_records),
        "invalid batch record limit"
    );
    ensure!(
        (512..=16_777_216).contains(&limits.max_batch_bytes),
        "invalid batch byte limit"
    );
    ensure!(
        (1..=10_000).contains(&limits.max_scan_records),
        "invalid scan record limit"
    );
    ensure!(
        (1..=33_554_432).contains(&limits.max_prepared_bytes),
        "invalid prepared payload limit"
    );
    Ok(())
}

/// Explicitly enables delivery. Repeating an identical configuration is
/// idempotent. Existing credentials or plugin installation never create jobs.
pub fn create_job(
    conn: &Connection,
    config: &DeliveryJobConfig,
    now_ms: i64,
) -> Result<DeliveryStatus> {
    create_job_inner(conn, config, now_ms, false)
}

fn create_job_inner(
    conn: &Connection,
    config: &DeliveryJobConfig,
    now_ms: i64,
    scoped: bool,
) -> Result<DeliveryStatus> {
    let mut config = config.clone();
    drop_retired_kinds(&mut config.selection);
    let config = &config;
    validate(config)?;
    ensure!(now_ms >= 0, "invalid clock");
    let tx = write_transaction(conn)?;
    // A session job follows the feed from its head: its members' history
    // arrives through their own backfills.
    let head = if scoped {
        feed::head(conn)?.revision
    } else {
        0
    };
    let existing: Option<String> = tx.query_row("SELECT id FROM delivery_jobs WHERE destination_id=? AND instance_id=? AND account_id=? AND state <> 'cancelled'", params![config.destination_id,config.instance_id,config.account_id], |row| row.get(0)).optional()?;
    if let Some(id) = existing {
        ensure!(
            is_session_job(&tx, &id)? == scoped,
            "delivery selection mode changed; cancel the old generation first"
        );
        ensure!(job(&tx,&id)?.config == *config, "delivery configuration changed; explicitly cancel the old generation before creating a new one");
        tx.commit()?;
        return status(conn, &id);
    }
    let count: i64 = tx.query_row(
        "SELECT COUNT(*) FROM delivery_jobs WHERE state <> 'cancelled'",
        [],
        |row| row.get(0),
    )?;
    ensure!(count < 32, "maximum active delivery jobs reached");
    let id: String = tx.query_row("SELECT lower(hex(randomblob(16)))", [], |row| row.get(0))?;
    let generation: i64 = tx.query_row("SELECT COALESCE(MAX(generation),0)+1 FROM delivery_jobs WHERE destination_id=? AND instance_id=? AND account_id=?", params![config.destination_id,config.instance_id,config.account_id], |row| row.get(0))?;
    tx.execute("INSERT INTO delivery_jobs(id,destination_id,instance_id,account_id,generation,config_json,state,created_ms,journal_cursor,bootstrap_done) VALUES (?,?,?,?,?,?,'active',?,?,?)", params![id,config.destination_id,config.instance_id,config.account_id,generation,serde_json::to_string(config)?,now_ms,head,scoped])?;
    if scoped {
        tx.execute(
            "INSERT INTO delivery_session_jobs(job_id) VALUES (?)",
            [&id],
        )?;
    }
    tx.commit()?;
    status(conn, &id)
}

pub fn status(conn: &Connection, job_id: &str) -> Result<DeliveryStatus> {
    status_counting(conn, job_id, true)
}

/// [`status`] for a progress report, which reads `unqueued_changes` only to
/// tell whether a job that finished its bootstrap has work left. Before the
/// bootstrap completes the feed is not scanned and `unqueued_changes` is 0,
/// so a report every few seconds during a backlog does not read hundreds of
/// changes each time.
pub fn progress_status(conn: &Connection, job_id: &str) -> Result<DeliveryStatus> {
    status_counting(conn, job_id, false)
}

fn status_counting(conn: &Connection, job_id: &str, always: bool) -> Result<DeliveryStatus> {
    let mut job = job(conn, job_id)?;
    let scoped = is_session_job(conn, job_id)?;
    if scoped {
        job.caught_up = !conn.query_row("SELECT EXISTS(SELECT 1 FROM delivery_session_members WHERE job_id=? AND bootstrap_done=0)", [job_id], |r| r.get::<_, bool>(0))?;
    }
    let (pending_records,pending_bytes,oldest_pending_ms): (i64,i64,Option<i64>) = conn.query_row("SELECT COALESCE(SUM(records),0),COALESCE(SUM(bytes+COALESCE(length(CAST(prepared AS BLOB)),0)),0),MIN(created_ms) FROM delivery_batches WHERE job_id=? AND state IN ('pending','leased','retry_wait','blocked')", [job_id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)))?;
    let quarantined_records: i64 = if conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='delivery_quarantine')", [], |row| row.get::<_, bool>(0))? {
        conn.query_row("SELECT COUNT(*) FROM delivery_quarantine WHERE job_id=?", [job_id], |row| row.get(0))?
    } else { 0 };
    // Status never fails on the feed, so an unreadable feed reads as none.
    let unqueued_changes = if always || job.caught_up {
        feed::unqueued(conn, &job.config.selection, job_id, job.cursor, scoped).unwrap_or(0)
    } else {
        0
    };
    // Read-only status can run beside an older collector before this build is
    // allowed to migrate its store. That legacy schema has no skip counter.
    let skipped = if schema::column_exists(conn, "delivery_jobs", "skipped_records")? {
        "skipped_records"
    } else {
        "0"
    };
    let query = format!("SELECT acknowledged_cursor,next_attempt_ms,last_attempt_ms,attempts,last_acknowledged_ms,acceptance_level,failure,{skipped},suppressed_records,acknowledged_records FROM delivery_jobs WHERE id=?");
    conn.query_row(&query, [job_id], |row| {
        Ok(DeliveryStatus {
            job_id: job.id.clone(),
            config: job.config.clone(),
            generation: job.generation,
            state: job.state.clone(),
            bootstrap_complete: job.caught_up,
            journal_cursor: job.cursor,
            acknowledged_cursor: row.get(0)?,
            pending_records,
            pending_bytes,
            oldest_pending_ms,
            unqueued_changes,
            next_attempt_ms: row.get(1)?,
            last_attempt_ms: row.get(2)?,
            attempts: row.get(3)?,
            last_acknowledged_ms: row.get(4)?,
            acceptance_level: row.get(5)?,
            failure: row.get(6)?,
            skipped_records: row.get(7)?,
            quarantined_records,
            suppressed_records: row.get(8)?,
            acknowledged_records: row.get(9)?,
        })
    })
    .map_err(Into::into)
}

/// What a worker needs to decide whether to step a job: its state, when it
/// may next be attempted, and its configuration. Unlike [`status`], it reads
/// no feed.
pub(crate) struct Schedule {
    pub state: String,
    pub next_attempt_ms: i64,
    pub config: DeliveryJobConfig,
}
pub(crate) fn schedule(conn: &Connection, job_id: &str) -> Result<Schedule> {
    let (state, next_attempt_ms, config): (String, i64, String) = conn.query_row(
        "SELECT state,next_attempt_ms,config_json FROM delivery_jobs WHERE id=?",
        [job_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    Ok(Schedule {
        state,
        next_attempt_ms,
        config: stored_config(&config)?,
    })
}

pub fn list_jobs(conn: &Connection) -> Result<Vec<DeliveryStatus>> {
    job_ids(conn)?.iter().map(|id| status(conn, id)).collect()
}
/// Every job's id, in [`list_jobs`] order, without reading its status.
pub(crate) fn job_ids(conn: &Connection) -> Result<Vec<String>> {
    Ok(conn
        .prepare("SELECT id FROM delivery_jobs ORDER BY created_ms,id")?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?)
}

fn excluded(
    conn: &Connection,
    selection: &ExportSelection,
    source: &str,
    session: Option<&str>,
) -> Result<bool> {
    let Some(session_id) = session else {
        return Ok(!selection.sessionless);
    };
    if selection
        .excluded_sessions
        .iter()
        .any(|id| id.source == source && id.session_id == session_id)
    {
        return Ok(true);
    }
    Ok(!is_shareable(
        conn,
        &SessionIdentity {
            source: source.into(),
            session_id: session_id.into(),
        },
    )?)
}

/// A Claude session whose transcript is in a Claude Code config folder the
/// person stopped sharing (`relay::claude_dirs`) is never uploaded, whatever
/// the upload policy or selection says.
fn in_unshared_folder(conn: &Connection, source: &str, session_id: &str) -> Result<bool> {
    // A claude.ai cloud session has no folder: it follows its login's.
    if source != "claude" || crate::relay::claude_dirs::is_cloud_session(session_id) {
        return Ok(source == "claude" && !crate::relay::claude_dirs::cloud_sessions_shared_here());
    }
    let folders = crate::relay::claude_dirs::unshared_folders();
    if folders.is_empty() {
        return Ok(false);
    }
    let raw_path: Option<String> = conn
        .prepare_cached("SELECT raw_path FROM sessions WHERE source = 'claude' AND session_id = ?")?
        .query_row([session_id], |row| row.get(0))
        .optional()?
        .flatten();
    // Fails closed: while any folder is unshared, a Claude session whose
    // transcript the catalog cannot place is not uploaded either.
    Ok(raw_path.is_none_or(|path| {
        crate::relay::claude_dirs::in_folders(std::path::Path::new(&path), &folders)
    }))
}
fn selected(selection: &ExportSelection, kind: &str, source: &str, session: Option<&str>) -> bool {
    selection.kinds.iter().any(|value| value == kind)
        && (selection.all_sources
            || selection.sources.iter().any(|value| value == source)
            || selection
                .sessions
                .iter()
                .any(|id| id.source == source && Some(id.session_id.as_str()) == session))
}

/// Exclusions are persistent and source-scoped. They are rechecked when a batch
/// is claimed/prepared. This cannot revoke a request already sent to a server.
/// Removing an existing exclusion requires cancelling affected jobs first and
/// creating new generations afterward, so previously skipped history receives
/// a fresh baseline. Jobs permanently excluding this session are unaffected.
pub fn set_session_excluded(
    conn: &Connection,
    session: &SessionIdentity,
    value: bool,
) -> Result<()> {
    let tx = write_transaction(conn)?;
    set_session_excluded_in_transaction(&tx, session, value, None)?;
    tx.commit()?;
    Ok(())
}

fn set_session_excluded_in_transaction(
    conn: &Connection,
    session: &SessionIdentity,
    value: bool,
    fresh_session_job: Option<&str>,
) -> Result<()> {
    let current: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM delivery_exclusions WHERE source=? AND session_id=?)",
        params![session.source, session.session_id],
        |r| r.get(0),
    )?;
    if current == value {
        return Ok(());
    }
    if value {
        conn.execute(
            "INSERT OR IGNORE INTO delivery_exclusions(source,session_id) VALUES (?,?)",
            params![session.source, session.session_id],
        )?;
        // Conflict archives retain exact submitted content for repair. Once a
        // session is excluded, drop any archive that could disclose it; the
        // active child is independently narrowed by the normal claim check.
        let mut statement =
            conn.prepare("SELECT parent_batch_id,job_id,payload FROM delivery_conflict_attempts")?;
        let archives = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(statement);
        for (parent_id, job_id, payload) in archives {
            let batch: StoredBatch = serde_json::from_str(&payload)?;
            let config = job(conn, &job_id)?.config;
            if !Consent::new(conn, &job_id, &config.selection)?.admits_all(&batch.records)? {
                conn.execute(
                    "DELETE FROM delivery_conflict_attempts WHERE parent_batch_id=?",
                    [&parent_id],
                )?;
                conn.execute(
                    "DELETE FROM delivery_quarantine WHERE parent_batch_id=?",
                    [&parent_id],
                )?;
            }
        }
    } else {
        if conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM delivery_exclusions WHERE source=? AND session_id=?)",
            params![session.source, session.session_id],
            |row| row.get::<_, bool>(0),
        )? {
            let mut statement = conn
                .prepare("SELECT id,config_json FROM delivery_jobs WHERE state <> 'cancelled'")?;
            let configs = statement.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            for config in configs {
                let (id, config) = config?;
                // The caller establishes a fresh member cutoff in this same
                // transaction. Every other affected job must still be guarded.
                if fresh_session_job == Some(id.as_str()) {
                    continue;
                }
                let config = stored_config(&config)?;
                if is_session_job(conn,&id)? && !conn.query_row("SELECT EXISTS(SELECT 1 FROM delivery_session_members WHERE job_id=? AND source=? AND (session_id=? OR ?))",params![id,session.source,session.session_id,config.selection.kinds.iter().any(|k|k=="relationship")],|r|r.get::<_,bool>(0))? { continue; }
                let selection = &config.selection;
                // A child exclusion also suppresses relationship records selected
                // through a parent. Conservatively include same-source parent
                // selections even if that relationship has since been deleted.
                let affected = !selection.excluded_sessions.contains(session)
                    && (selection.all_sources
                        || selection.sources.contains(&session.source)
                        || selection.sessions.contains(session)
                        || (selection.kinds.iter().any(|kind| kind == "relationship")
                            && selection
                                .sessions
                                .iter()
                                .any(|parent| parent.source == session.source)));
                ensure!(!affected, "DELIVERY_GENERATION_REQUIRED: cancel affected delivery jobs before removing an exclusion, then create new jobs to backfill skipped history");
            }
        }
        conn.execute(
            "DELETE FROM delivery_exclusions WHERE source=? AND session_id=?",
            params![session.source, session.session_id],
        )?;
    }
    // Fence all active claims. A worker must re-claim and recheck before dispatch.
    conn.execute("UPDATE delivery_jobs SET fence=fence+1,worker_id=NULL,lease_until_ms=NULL WHERE state <> 'cancelled'", [])?;
    conn.execute(
        "UPDATE delivery_batches SET state='pending' WHERE state='leased'",
        [],
    )?;
    Ok(())
}

fn batch_template(conn: &Connection, job: &Job) -> Result<HistoryExportBatch> {
    let origin_id = feed::Origin::read(conn)?.origin_id;
    let batch_id = conn.query_row("SELECT lower(hex(randomblob(16)))", [], |row| row.get(0))?;
    Ok(HistoryExportBatch {
        schema_version: EXPORT_SCHEMA_VERSION,
        origin_id,
        batch_id,
        job_id: job.id.clone(),
        generation: job.generation,
        destination_id: job.config.destination_id.clone(),
        instance_id: job.config.instance_id.clone(),
        account_id: job.config.account_id.clone(),
        mapping_version: job.config.mapping_version.clone(),
        records: Vec::new(),
    })
}
/// Persist a batch whose records account for the feed up to `feed_end`, and
/// raise the origin's highest issued revision to cover it.
fn insert_batch(
    conn: &Connection,
    batch: &HistoryExportBatch,
    feed_end: i64,
    now: i64,
) -> Result<()> {
    let payload = serde_json::to_string(batch)?;
    conn.execute("INSERT INTO delivery_batches(id,job_id,state,payload,records,bytes,journal_end,created_ms) VALUES (?,?,'pending',?,?,?,?,?)",params![batch.batch_id,batch.job_id,payload,batch.records.len() as i64,payload.len() as i64,feed_end,now])?;
    if let Some(highest) = batch.records.iter().map(|record| record.revision).max() {
        feed::Origin::issued(conn, highest)?;
    }
    Ok(())
}

/// A batch being filled, with the length it serializes to kept current.
/// Serialized, a batch is its envelope with an empty `records` array, plus
/// each record, plus a comma between records, so admitting a record costs
/// that record's serialization rather than the whole batch's again.
struct Filling {
    batch: HistoryExportBatch,
    bytes: usize,
}
impl Filling {
    fn new(batch: HistoryExportBatch) -> Result<Self> {
        ensure!(batch.records.is_empty(), "a batch is filled from empty");
        let bytes = serialized_len(&batch)?;
        Ok(Self { batch, bytes })
    }
    /// The batch's serialized length with a record of `record` bytes added.
    fn with(&self, record: usize) -> usize {
        self.bytes + record + usize::from(!self.batch.records.is_empty())
    }
}

/// The length of `value`'s compact JSON, without keeping the bytes.
fn serialized_len(value: &impl Serialize) -> Result<usize> {
    struct Count(usize);
    impl std::io::Write for Count {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0 += bytes.len();
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut count = Count(0);
    serde_json::to_writer(&mut count, value)?;
    Ok(count.0)
}

/// What became of a record offered to a batch.
#[derive(Debug, PartialEq, Eq)]
enum Admitted {
    /// The record is in the batch.
    Added,
    /// The batch has no room left; the record starts the next one.
    Full,
    /// The record cannot fit even an empty batch and never will: it is not
    /// sent, and the job moves past it like any other withheld record.
    Suppressed,
}

/// Ends a string field shortened to fit the batch limit. Plain ASCII with no
/// character JSON escapes, so its serialized length is its length.
const TRUNCATION_MARKER: &str = " [truncated by Agent Relay to fit the upload limit]";

/// Add `record` to `batch` unless it would take the batch over its byte
/// limit. A record that alone exceeds the limit — a tool result that printed
/// megabytes — would stop the job for good, so it is shortened to fit: one
/// content column at a time, longest first, is cut to end with
/// [`TRUNCATION_MARKER`], the batch is measured again, and a row that records
/// truncation says so. `identity` is the change's key: a column holding one of
/// its values is never cut, nor is one that describes the original row, so
/// the record keeps its identity and revision. A record whose bulk is in no
/// column it may cut is suppressed instead.
fn push_record(
    filling: &mut Filling,
    mut record: HistoryExportRecord,
    identity: &[serde_json::Value],
    limits: &DeliveryLimits,
) -> Result<Admitted> {
    // Normalize nested JSON text before measuring the record. In particular,
    // making malformed JSON opaque can expand backslashes; the ordinary
    // oversized-record path below must see those final bytes so it can shorten
    // and mark the row instead of leaving `prepare` to fail later.
    let sanitized = crate::destination::sanitize_payload(&mut record.payload)?;
    if sanitized.altered_json_fields > 0 {
        eprintln!(
            "receiver payload sanitized batch_ref={} json_text_fields={}",
            hash(filling.batch.batch_id.as_bytes()),
            sanitized.altered_json_fields
        );
    }
    let mut size = filling.with(serialized_len(&record)?);
    if size > limits.max_batch_bytes && !filling.batch.records.is_empty() {
        return Ok(Admitted::Full);
    }
    while size > limits.max_batch_bytes {
        if !shorten(&mut record.payload, identity, size - limits.max_batch_bytes) {
            return Ok(Admitted::Suppressed);
        }
        size = filling.with(serialized_len(&record)?);
    }
    filling.batch.records.push(record);
    filling.bytes = size;
    Ok(Admitted::Added)
}

/// Whether a column may be cut: text that is not part of the row's identity
/// and does not describe the original row.
fn cuttable(name: &str, value: &serde_json::Value, identity: &[serde_json::Value]) -> bool {
    value.is_string()
        && !identity.contains(value)
        // `payload_json` is content; the other `payload_*` columns describe it.
        && (name == "payload_json" || !name.starts_with("payload_"))
        && !name.ends_with("_id")
        && !name.ends_with("_uid")
        && !name.ends_with("_hash")
        && name != "source"
}

/// Cut the longest column of `payload` that can still be cut by at least
/// `excess` bytes, or as far as it goes, and mark the row truncated. A column
/// holding a JSON object or array stays valid JSON: its longest strings are
/// cut instead. Removing a character saves at least its UTF-8 length once
/// serialized, so cutting `excess` bytes of text saves at least `excess`
/// bytes of batch. Returns whether anything was cut; the caller measures the
/// batch again.
fn shorten(payload: &mut serde_json::Value, identity: &[serde_json::Value], excess: usize) -> bool {
    let Some(columns) = payload.as_object_mut() else {
        return false;
    };
    let mut candidates: Vec<(String, usize)> = columns
        .iter()
        .filter(|(name, value)| cuttable(name, value, identity))
        // Ranked by what the column costs in the batch, escaped as text, so
        // a field of quotes is cut before a slightly longer plain one.
        .map(|(name, value)| (name.clone(), value.to_string().len()))
        .collect();
    candidates.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    for (name, _) in candidates {
        let text = columns[&name].as_str().expect("a text column");
        let parsed = serde_json::from_str::<serde_json::Value>(text).ok();
        // A document first loses its insignificant whitespace, which changes
        // nothing it says: the batch is measured again before any content is
        // cut. The text no longer matches the stored bytes and hash, so the
        // row is still marked.
        if parsed.is_some() {
            let compact = without_whitespace(text);
            if compact.len() < text.len() {
                columns.insert(name, compact.into());
                mark_truncated(columns);
                return true;
            }
        }
        let shortened = match parsed {
            // A document stays valid JSON: its strings are cut, including a
            // top-level string, and it is serialized again.
            Some(mut document)
                if document.is_object() || document.is_array() || document.is_string() =>
            {
                cut_leaves(&mut document, excess).then(|| document.to_string())
            }
            // Anything else in a JSON column (a number, boolean or null, or
            // text this parser cannot read) cannot be cut and stay valid JSON,
            // so it is left whole.
            _ if name.ends_with("_json") => continue,
            _ => cut_text(text, excess, 1),
        };
        // Kept only when the column costs less in the batch. Its decoded text
        // can grow: a few escaped quotes swapped for the plain marker.
        let carried = |text: &str| serde_json::Value::String(text.into()).to_string().len();
        let Some(shortened) = shortened.filter(|shortened| carried(shortened) < carried(text))
        else {
            continue;
        };
        columns.insert(name, shortened.into());
        mark_truncated(columns);
        return true;
    }
    false
}

/// Record on a row that has one that its uploaded text is not the stored text.
fn mark_truncated(columns: &mut serde_json::Map<String, serde_json::Value>) {
    if let Some(flag) = columns.get_mut("payload_truncated") {
        *flag = if flag.is_boolean() {
            true.into()
        } else {
            1.into()
        };
    }
}

/// `text` cut by at least `excess` bytes and ending with the marker once, or
/// `None` when nothing is left to cut. Text not yet marked also gives up room
/// for the marker it gains, so even a small excess shortens it.
///
/// `excess` is counted in batch bytes, where the text is escaped `depth` times
/// (once as a column, twice as a string of a document in a column), so the
/// cut removes characters from the end until what they cost as carried covers
/// it: an escaped quote frees more than one byte, and no more is cut than that.
fn cut_text(text: &str, excess: usize, depth: usize) -> Option<String> {
    let (body, gained) = match text.strip_suffix(TRUNCATION_MARKER) {
        Some(body) => (body, 0),
        None => (text, TRUNCATION_MARKER.len()),
    };
    if body.is_empty() {
        return None;
    }
    let need = excess + gained;
    let mut freed = 0;
    let mut keep = body.len();
    for (index, character) in body.char_indices().rev() {
        if freed >= need {
            break;
        }
        freed += carried_char_len(character, depth);
        keep = index;
    }
    Some(format!("{}{TRUNCATION_MARKER}", &body[..keep]))
}

/// Valid JSON `text` without the whitespace between its tokens. Strings are
/// copied as written, escapes and all, so nothing the document says changes.
fn without_whitespace(text: &str) -> String {
    let mut compact = String::with_capacity(text.len());
    let (mut in_string, mut escaped) = (false, false);
    for character in text.chars() {
        if in_string {
            compact.push(character);
            if escaped {
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == '"' {
                in_string = false;
            }
        } else if character == '"' {
            in_string = true;
            compact.push(character);
        } else if !matches!(character, ' ' | '\t' | '\n' | '\r') {
            compact.push(character);
        }
    }
    compact
}

/// The bytes `character` occupies once escaped as a JSON string `depth` times.
fn carried_char_len(character: char, depth: usize) -> usize {
    if character.is_ascii()
        && !character.is_ascii_control()
        && character != '"'
        && character != '\\'
    {
        return 1;
    }
    let mut text = character.to_string();
    for _ in 0..depth {
        let quoted = serde_json::Value::String(text).to_string();
        text = quoted[1..quoted.len() - 1].to_string();
    }
    text.len()
}

/// The bytes `text` occupies in a batch as a string of a JSON document that is
/// itself a column's text.
fn carried_len(text: &str) -> usize {
    let document = serde_json::Value::String(text.into()).to_string();
    serde_json::Value::String(document).to_string().len()
}

/// Cut the strings of a JSON document, longest first, until at least
/// `excess` bytes are gone or none is left to cut. Each string is visited
/// once. Returns whether anything was cut.
fn cut_leaves(document: &mut serde_json::Value, excess: usize) -> bool {
    fn collect<'a>(value: &'a mut serde_json::Value, leaves: &mut Vec<&'a mut String>) {
        match value {
            serde_json::Value::String(text) => leaves.push(text),
            serde_json::Value::Array(items) => {
                items.iter_mut().for_each(|item| collect(item, leaves))
            }
            serde_json::Value::Object(fields) => {
                fields.values_mut().for_each(|item| collect(item, leaves))
            }
            _ => {}
        }
    }
    let mut leaves = Vec::new();
    collect(document, &mut leaves);
    // What a leaf costs, and what a cut saves, is measured as the batch
    // carries the string: escaped once inside the document and again as the
    // column's text. A short leaf of quotes can cost more than a long plain
    // one.
    let mut leaves: Vec<(usize, &mut String)> = leaves
        .into_iter()
        .map(|leaf| (carried_len(leaf), leaf))
        .collect();
    leaves.sort_by_key(|(before, _)| std::cmp::Reverse(*before));
    let marker = carried_len(TRUNCATION_MARKER);
    let mut remaining = excess;
    let mut cut = false;
    for (before, leaf) in leaves {
        if remaining == 0 || before <= marker {
            break;
        }
        let Some(shortened) = cut_text(leaf, remaining, 2) else {
            continue;
        };
        let after = carried_len(&shortened);
        if after >= before {
            continue;
        }
        remaining = remaining.saturating_sub(before - after);
        *leaf = shortened;
        cut = true;
    }
    cut
}

/// Prepare at most one bounded batch; no network operation occurs. Calls that
/// scan only excluded or unselected changes can return no batch while making
/// progress. The host repeats this call until caught up, respecting its own
/// run budget.
pub fn prepare_batch(conn: &Connection, job_id: &str, now_ms: i64) -> Result<PrepareResult> {
    feed::store(conn)
        .and_then(|store| prepare(conn, &store, job_id, now_ms, 1, PublishedLimits::default()))
        .context(PreparationFailed)
}

/// [`prepare_batch`] reading the feed through `store`, an open read-only
/// handle on `conn`'s database, so a drain opens the store once rather than
/// once per batch. An all-sources job prepares a new batch while it holds
/// fewer than `window` unresolved ones. `published` adjusts the job's limits
/// for the batch it prepares.
pub(crate) fn prepare_batch_from(
    conn: &Connection,
    store: &ai_hist::SessionStore,
    job_id: &str,
    now_ms: i64,
    window: usize,
    published: PublishedLimits,
) -> Result<PrepareResult> {
    prepare(conn, store, job_id, now_ms, window, published).context(PreparationFailed)
}

/// Marks a failure to prepare a batch from local history, so one that
/// repeats is reported as such rather than as a sync that is offline. A
/// typed cause below it, such as SQLite reporting the database busy, still
/// classifies the failure first.
#[derive(Debug)]
pub struct PreparationFailed;
impl std::fmt::Display for PreparationFailed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("preparing an upload batch failed")
    }
}

fn prepare(
    conn: &Connection,
    store: &ai_hist::SessionStore,
    job_id: &str,
    now_ms: i64,
    window: usize,
    published: PublishedLimits,
) -> Result<PrepareResult> {
    let tx = write_transaction(conn)?;
    let origin = feed::Origin::align(&tx, store)?;
    let mut job = job(&tx, job_id)?;
    ensure!(job.state == "active", "delivery job is not active");
    job.config.limits = job.config.limits.clone().with_published(published);
    let scoped = is_session_job(&tx, job_id)?;
    // The oldest unresolved batch, and how many the job holds: a full window
    // prepares nothing more until one of them resolves.
    let (existing, unresolved): (Option<String>, usize) = tx.query_row(
        &format!("SELECT (SELECT id FROM delivery_batches WHERE job_id=?1 AND state IN ('pending','leased','retry_wait','blocked') ORDER BY journal_end,{CLAIM_SEQ},seq LIMIT 1),(SELECT COUNT(*) FROM delivery_batches WHERE job_id=?1 AND state IN ('pending','leased','retry_wait','blocked'))"),
        [job_id],
        |row| Ok((row.get(0)?, row.get::<_, i64>(1)? as usize)),
    )?;
    if unresolved >= window.max(1) {
        let bootstrap_complete = if scoped {
            sessions::backfilled(&tx, job_id)?
        } else {
            job.caught_up
        };
        tx.commit()?;
        return Ok(PrepareResult {
            batch_id: existing,
            scanned_records: 0,
            bootstrap_complete,
        });
    }
    if scoped {
        let result = sessions::prepare(&tx, store, &origin, &job, now_ms)?;
        tx.commit()?;
        return Ok(result);
    }
    let limits = job.config.limits.clone();
    let mut filling = Filling::new(batch_template(&tx, &job)?)?;
    let mut consent = Consent::new(&tx, &job.id, &job.config.selection)?;
    let mut changes = store.changes_since(
        origin.position(job.cursor),
        feed::query(&job.config.selection)?.batch(limits.max_scan_records),
    )?;
    let mut scanned = 0;
    let mut suppressed = 0;
    while scanned < limits.max_scan_records
        && filling.batch.records.len() < limits.max_batch_records
    {
        let Some(change) = changes.next().transpose()? else {
            job.cursor = feed::revision(changes.head().revision)?;
            job.caught_up = true;
            break;
        };
        let record = record_from_change(&origin, &change)?;
        let eligible = selected(
            &job.config.selection,
            &record.kind,
            &record.source,
            record.session_id.as_deref(),
        );
        let private = eligible && consent.record_excluded(&record)?;
        if eligible && !private {
            match push_record(&mut filling, record, &change.key, &limits)? {
                Admitted::Added => {}
                Admitted::Full => break,
                Admitted::Suppressed => suppressed += 1,
            }
        }
        if private {
            suppressed += 1;
        }
        scanned += 1;
        job.cursor = feed::revision(change.revision)?;
    }
    drop(consent);
    let batch = filling.batch;
    tx.execute("UPDATE delivery_jobs SET journal_cursor=?,bootstrap_done=?,suppressed_records=suppressed_records+? WHERE id=?",params![job.cursor,job.caught_up,suppressed,job_id])?;
    let batch_id = if batch.records.is_empty() {
        None
    } else {
        insert_batch(&tx, &batch, job.cursor, now_ms)?;
        Some(batch.batch_id)
    };
    tx.commit()?;
    Ok(PrepareResult {
        batch_id,
        scanned_records: scanned,
        bootstrap_complete: job.caught_up,
    })
}

/// What a lease check has to prove before a write may proceed.
///
/// `claim_batch` bumps `fence` and rewrites `worker_id` on every claim, so a
/// takeover is always visible as a fence or worker mismatch; the job state and
/// the batch's `leased` state close the rest. That is *ownership*, and it is
/// all a write made **after** transport needs: `acknowledge` and
/// `record_failure` report an outcome that already happened, and refusing
/// them because the deadline passed while the receiver ran does not undo the
/// send. It only loses the record of it — before this distinction, "the claim
/// is gone" meant a drain whose 100 ms lease lapsed while its receiver
/// panicked could not even record the resulting transient failure: the write
/// was refused with "lease expired or was fenced" when nothing had been
/// fenced, the retry backoff was never applied, and a clean retryable outcome
/// was escalated into a job-level state error.
///
/// A write made **before** transport is different. The fence proves nobody
/// else held the batch when the check ran, but that proof expires with the
/// transaction: `validate_dispatch` commits and only then does the receiver
/// send, and an expired lease that was still unclaimed at validation is
/// claimable by another worker in that gap, so both would send. The
/// pre-transport gates therefore also require the lease to be live —
/// `lease_until_ms > now` — which is the promise that no other worker can
/// claim until the send is past the point of `claim_batch` letting them.
///
/// Renewal is [`Owned`](LeaseCheck::Owned) on purpose: a keepalive that was
/// blocked past the deadline finds its lease expired but, by the fence,
/// unclaimed, and renewing it inside one write transaction makes it live
/// again before any other worker can act on the expiry. Refusing that would
/// turn a slow lock into a lost batch. Every caller runs the check inside the
/// same write transaction as the write it guards, which is what makes either
/// form a proof rather than a race.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LeaseCheck {
    /// Ownership only: the fence and worker still match. Enough for a write
    /// that reports an outcome already produced, and for renewal.
    Owned,
    /// Ownership and a deadline still in the future. Required before any
    /// step that commits and then hands the batch to transport.
    Live,
}

fn check_lease(
    conn: &Connection,
    lease: &DeliveryLease,
    now_ms: i64,
    check: LeaseCheck,
) -> Result<()> {
    // A job blocked under this very lease is still this worker's to report
    // on: only a sibling batch of its own window can have blocked it, since
    // blocking a job releases its lease once no other batch is in flight. The
    // outcomes of the other batches it already sent are still recorded.
    let owned: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM delivery_jobs j JOIN delivery_batches b ON b.job_id=j.id WHERE j.id=? AND j.state IN ('active','blocked') AND j.worker_id=? AND j.fence=? AND b.id=? AND b.state='leased')",params![lease.job_id,lease.worker_id,lease.fence,lease.batch_id],|row| row.get(0))?;
    ensure!(owned, "delivery lease was fenced by another worker");
    if check == LeaseCheck::Live {
        let live: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM delivery_jobs WHERE id=? AND state='active' AND lease_until_ms>?)",
            params![lease.job_id, now_ms],
            |row| row.get(0),
        )?;
        ensure!(
            live,
            "delivery lease expired before dispatch; another worker may claim the batch"
        );
    }
    Ok(())
}
/// The job's oldest unresolved batch in `states`: the one covering the
/// earliest stretch of the feed.
fn pending_batch(
    conn: &Connection,
    id: &str,
    states: &str,
) -> Result<Option<(HistoryExportBatch, Option<PreparedPayload>, i64)>> {
    let value = conn.query_row(&format!("SELECT payload,prepared,journal_end FROM delivery_batches WHERE job_id=? AND state IN {states} ORDER BY journal_end,{CLAIM_SEQ},seq LIMIT 1"),[id],|row| Ok((row.get::<_,String>(0)?,row.get::<_,Option<String>>(1)?,row.get(2)?))).optional()?;
    value
        .map(|(payload, prepared, end)| {
            Ok((
                serde_json::from_str(&payload)?,
                prepared
                    .map(|value| serde_json::from_str(&value))
                    .transpose()?,
                end,
            ))
        })
        .transpose()
}

struct BatchProgress {
    accepted: Vec<String>,
    suppressed: Vec<String>,
    rejected: Vec<String>,
    isolation_frontier: Vec<IsolationTask>,
}
impl BatchProgress {
    /// A build predating `isolation_frontier` can advance one of its revisions
    /// without updating the frontier. Preserve that confirmed outcome, remove
    /// the stale overlap, and re-test any remainder whose rejected-subset proof
    /// no longer describes the exact same records.
    fn reconcile_legacy_writer(&mut self) -> bool {
        let resolved: HashSet<_> = self
            .accepted
            .iter()
            .chain(&self.suppressed)
            .chain(&self.rejected)
            .map(String::as_str)
            .collect();
        let mut changed = false;
        self.isolation_frontier.retain_mut(|task| {
            let before = task.revision_ids.len();
            task.revision_ids
                .retain(|revision| !resolved.contains(revision.as_str()));
            if task.revision_ids.len() != before {
                task.rejected = false;
                changed = true;
            }
            !task.revision_ids.is_empty()
        });
        changed
    }
}

fn batch_progress(conn: &Connection, batch_id: &str) -> Result<BatchProgress> {
    let (accepted, suppressed, rejected, frontier): (String, String, String, String) = conn.query_row(
        "SELECT accepted_revision_ids,suppressed_revision_ids,rejected_revision_ids,isolation_frontier FROM delivery_batches WHERE id=?",
        [batch_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    )?;
    Ok(BatchProgress {
        accepted: serde_json::from_str(&accepted)?,
        suppressed: serde_json::from_str(&suppressed)?,
        rejected: serde_json::from_str(&rejected)?,
        isolation_frontier: serde_json::from_str(&frontier)?,
    })
}

/// Claims an already persisted batch. Lease expiry permits redelivery with the
/// same batch ID and body. No database transaction remains open during I/O.
/// Claim the pending batch, dating the lease from *inside* the write
/// transaction.
///
/// `clock` is read after the lock is acquired. A claim can wait in the native
/// boundary's blocking queue, on opening the database, or on SQLite's write
/// lock, and a deadline computed from a timestamp taken before that wait is
/// short by exactly the wait: for any wait longer than the lease it is
/// already in the past when it commits. The claim then reports success, the
/// pre-transport liveness checks refuse the lease, and another worker
/// reclaims the batch at once — a lease that was never usable, handed out as
/// though it were.
pub fn claim_batch(
    conn: &Connection,
    job_id: &str,
    worker_id: &str,
    lease_ms: i64,
    clock: &dyn Fn() -> i64,
) -> Result<Option<ClaimedBatch>> {
    ensure!(identifier(worker_id), "invalid delivery worker id");
    ensure!(
        (1..=86_400_000).contains(&lease_ms),
        "invalid delivery lease duration"
    );
    let tx = write_transaction(conn)?;
    let now_ms = clock();
    ensure!(now_ms >= 0, "invalid delivery clock");
    let expires_at_ms = now_ms
        .checked_add(lease_ms)
        .context("delivery clock overflow")?;
    let job = job(&tx, job_id)?;
    if job.state != "active" {
        return Ok(None);
    }
    let unavailable: bool = tx.query_row(
        "SELECT next_attempt_ms>? OR COALESCE(lease_until_ms>?,0) FROM delivery_jobs WHERE id=?",
        params![now_ms, now_ms, job_id],
        |row| row.get(0),
    )?;
    if unavailable {
        return Ok(None);
    }
    let Some((batch, prepared, end)) = pending_batch(&tx, job_id, UNRESOLVED)? else {
        return Ok(None);
    };
    // Nobody holds the job, so a batch still marked leased was left by an
    // attempt that ended without recording it: it is pending again.
    tx.execute(
        "UPDATE delivery_batches SET state='pending' WHERE job_id=? AND state='leased' AND id<>?",
        params![job_id, batch.batch_id],
    )?;
    let (batch, prepared) = match consented(&tx, &job, batch, prepared, end, now_ms)? {
        Consented::Unchanged(batch, prepared) => (batch, prepared),
        consented => {
            tx.execute("UPDATE delivery_jobs SET fence=fence+1,worker_id=NULL,lease_until_ms=NULL WHERE id=?",[job_id])?;
            match consented {
                Consented::Narrowed(batch) => (batch, None),
                _ => {
                    tx.commit()?;
                    return Ok(None);
                }
            }
        }
    };
    tx.execute("UPDATE delivery_jobs SET fence=fence+1,worker_id=?,lease_until_ms=?,last_attempt_ms=?,attempts=attempts+1 WHERE id=?",params![worker_id,expires_at_ms,now_ms,job_id])?;
    let fence = tx.query_row(
        "SELECT fence FROM delivery_jobs WHERE id=?",
        [job_id],
        |row| row.get(0),
    )?;
    let lease = DeliveryLease {
        job_id: job_id.into(),
        batch_id: batch.batch_id.clone(),
        worker_id: worker_id.into(),
        fence,
        expires_at_ms,
    };
    let claimed = lease_claimed(&tx, lease, batch, prepared)?;
    tx.commit()?;
    Ok(Some(claimed))
}

/// Unresolved batch states.
const UNRESOLVED: &str = "('pending','leased','retry_wait','blocked')";
/// A batch's place in claim order within its feed end: its `seq`, or for a
/// batch that replaces another (a consent-narrowed remainder or a conflict
/// recovery child) the place of the batch it replaces. Batches are claimed
/// in `(journal_end, CLAIM_SEQ, seq)` order.
pub(super) const CLAIM_SEQ: &str = "COALESCE(claim_seq,seq)";

/// Give batch `id`, which replaces `parent` and holds what is left of its
/// records, `parent`'s place in claim order.
fn take_claim_place(conn: &Connection, id: &str, parent: &str) -> Result<()> {
    conn.execute(
        &format!("UPDATE delivery_batches SET claim_seq=(SELECT {CLAIM_SEQ} FROM delivery_batches WHERE id=?2) WHERE id=?1"),
        params![id, parent],
    )?;
    Ok(())
}

/// What consent left of a batch about to be claimed.
enum Consented {
    /// Every record is still admitted.
    Unchanged(HistoryExportBatch, Option<PreparedPayload>),
    /// Some records were withdrawn: the rest goes out as a new batch.
    Narrowed(HistoryExportBatch),
    /// No record is admitted any more.
    Withdrawn,
}

/// Recheck consent for a batch about to be claimed. A payload never changes
/// beneath an idempotency key that may have been used, so a batch that lost
/// records is suppressed and what remains is persisted as a new batch with
/// the same feed end.
fn consented(
    tx: &Connection,
    job: &Job,
    mut batch: HistoryExportBatch,
    prepared: Option<PreparedPayload>,
    end: i64,
    now_ms: i64,
) -> Result<Consented> {
    let mut allowed = Vec::new();
    let mut consent = Consent::new(tx, &job.id, &job.config.selection)?;
    for record in &batch.records {
        if consent.admits(&RecordScope::of(record))? {
            allowed.push(record.clone());
        }
    }
    drop(consent);
    let removed = batch.records.len() - allowed.len();
    if removed == 0 {
        return Ok(Consented::Unchanged(batch, prepared));
    }
    tx.execute(
        "UPDATE delivery_batches SET state='suppressed',payload=NULL,prepared=NULL WHERE id=?",
        [&batch.batch_id],
    )?;
    tx.execute(
        "UPDATE delivery_jobs SET suppressed_records=suppressed_records+? WHERE id=?",
        params![removed as i64, job.id],
    )?;
    if allowed.is_empty() {
        return Ok(Consented::Withdrawn);
    }
    let parent = std::mem::replace(
        &mut batch.batch_id,
        tx.query_row("SELECT lower(hex(randomblob(16)))", [], |row| row.get(0))?,
    );
    batch.records = allowed;
    insert_batch(tx, &batch, end, now_ms)?;
    take_claim_place(tx, &batch.batch_id, &parent)?;
    Ok(Consented::Narrowed(batch))
}

/// Mark a batch leased under `lease` and read back its isolation progress.
fn lease_claimed(
    tx: &Connection,
    lease: DeliveryLease,
    batch: HistoryExportBatch,
    prepared: Option<PreparedPayload>,
) -> Result<ClaimedBatch> {
    tx.execute(
        "UPDATE delivery_batches SET state='leased' WHERE id=?",
        [&batch.batch_id],
    )?;
    let mut progress = batch_progress(tx, &batch.batch_id)?;
    if progress.reconcile_legacy_writer() {
        tx.execute(
            "UPDATE delivery_batches SET isolation_frontier=? WHERE id=?",
            params![
                serde_json::to_string(&progress.isolation_frontier)?,
                &batch.batch_id
            ],
        )?;
    }
    Ok(ClaimedBatch {
        lease,
        batch,
        prepared,
        accepted_revision_ids: progress.accepted,
        suppressed_revision_ids: progress.suppressed,
        rejected_revision_ids: progress.rejected,
        isolation_frontier: progress.isolation_frontier,
    })
}

/// What [`claim_next`] found.
#[derive(Debug)]
pub(crate) enum NextClaim {
    /// The next batch, leased under the same job lease.
    Claimed(Box<ClaimedBatch>),
    /// The lease is still held and current, but no batch waits to be claimed.
    Empty,
    /// The worker no longer holds the job, or the job may not be attempted
    /// now: it was fenced, paused, blocked or set to wait out a retry.
    Lost,
}

/// Claim the job's next pending batch under a job lease the worker already
/// holds, which `held` names (its batch is any one claimed under it), without
/// taking the lease again: the batches of one window share a fence. The lease
/// must be live and the job due, so a failure recorded in the window, which
/// sets a retry deadline, stops further claims until that deadline. A batch
/// waiting out a retry is claimed only once that deadline has passed.
pub(crate) fn claim_next(
    conn: &Connection,
    held: &DeliveryLease,
    clock: &dyn Fn() -> i64,
) -> Result<NextClaim> {
    let tx = write_transaction(conn)?;
    let now_ms = clock();
    let expires_at_ms: Option<i64> = tx
        .query_row(
            "SELECT lease_until_ms FROM delivery_jobs WHERE id=? AND state='active' AND worker_id=? AND fence=? AND lease_until_ms>? AND next_attempt_ms<=?",
            params![held.job_id, held.worker_id, held.fence, now_ms, now_ms],
            |row| row.get(0),
        )
        .optional()?;
    let Some(expires_at_ms) = expires_at_ms else {
        return Ok(NextClaim::Lost);
    };
    let job = job(&tx, &held.job_id)?;
    loop {
        let Some((batch, prepared, end)) =
            pending_batch(&tx, &held.job_id, "('pending','retry_wait')")?
        else {
            tx.commit()?;
            return Ok(NextClaim::Empty);
        };
        let (batch, prepared) = match consented(&tx, &job, batch, prepared, end, now_ms)? {
            Consented::Unchanged(batch, prepared) => (batch, prepared),
            Consented::Narrowed(batch) => (batch, None),
            Consented::Withdrawn => continue,
        };
        tx.execute(
            "UPDATE delivery_jobs SET last_attempt_ms=? WHERE id=?",
            params![now_ms, held.job_id],
        )?;
        let lease = DeliveryLease {
            batch_id: batch.batch_id.clone(),
            expires_at_ms,
            ..held.clone()
        };
        let claimed = lease_claimed(&tx, lease, batch, prepared)?;
        tx.commit()?;
        return Ok(NextClaim::Claimed(Box::new(claimed)));
    }
}

/// Extend a job lease for every batch claimed under it, as [`renew_lease`]
/// does for one: the batch named in `lease` may already have resolved while
/// its siblings are still in flight. Ownership is the job's fence and worker.
pub(crate) fn renew_window(
    conn: &Connection,
    lease: &DeliveryLease,
    lease_ms: i64,
    clock: &dyn Fn() -> i64,
) -> Result<DeliveryLease> {
    ensure!(
        (1..=86_400_000).contains(&lease_ms),
        "invalid lease duration"
    );
    let tx = write_transaction(conn)?;
    let now_ms = clock();
    let expires_at_ms = now_ms
        .checked_add(lease_ms)
        .context("delivery clock overflow")?;
    let renewed = tx.execute(
        "UPDATE delivery_jobs SET lease_until_ms=? WHERE id=? AND state IN ('active','blocked') AND worker_id=? AND fence=?",
        params![expires_at_ms, lease.job_id, lease.worker_id, lease.fence],
    )?;
    ensure!(renewed == 1, "delivery lease was fenced by another worker");
    tx.commit()?;
    Ok(DeliveryLease {
        expires_at_ms,
        ..lease.clone()
    })
}

/// End one claim of a job lease: the lease itself is released, and the job
/// fenced, once no other batch claimed under it is still in flight.
fn end_claim(conn: &Connection, lease: &DeliveryLease) -> Result<bool> {
    let siblings: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM delivery_batches WHERE job_id=? AND id<>? AND state='leased')",
        params![lease.job_id, lease.batch_id],
        |row| row.get(0),
    )?;
    if !siblings {
        conn.execute(
            "UPDATE delivery_jobs SET fence=fence+1,worker_id=NULL,lease_until_ms=NULL WHERE id=?",
            [&lease.job_id],
        )?;
    }
    Ok(!siblings)
}

/// Whether a batch of the job waits out a retry or is blocked: a failure
/// recorded in the current window that a sibling's acknowledgment must not
/// clear.
const FAILED_IN_WINDOW: &str =
    "EXISTS(SELECT 1 FROM delivery_batches WHERE job_id=?1 AND state IN ('retry_wait','blocked'))";
/// Whether an acknowledgment must leave the job's retry state alone: a
/// failure is recorded in the window, or a batch claimed before the
/// acknowledged one is still unresolved. Later batches are routinely
/// acknowledged while the oldest is still in flight; clearing `attempts`
/// then would let that oldest batch fail again and again from a backoff
/// that never grows. The comparison is claim order (see [`CLAIM_SEQ`]), and
/// the acknowledged batch's place in it is `(end, place, seq)`: a session
/// job's backfill batches share a feed end.
fn backoff_stands(end: &str, batch: &str) -> String {
    format!("({FAILED_IN_WINDOW} OR EXISTS(SELECT 1 FROM delivery_batches u, delivery_batches a WHERE a.id={batch} AND u.job_id=?1 AND u.state IN {UNRESOLVED} AND (u.journal_end,COALESCE(u.claim_seq,u.seq),u.seq)<({end},COALESCE(a.claim_seq,a.seq),a.seq)))")
}

/// Return a host-interrupted attempt to pending without treating shutdown as a
/// receiver failure. Keep its immutable payload for idempotent redelivery and
/// undo only this claim's contribution to the retry counter. Ownership is
/// checked inside the write transaction so an old worker cannot release a new
/// worker's claim or reverse a concurrent pause/exclusion.
fn release_stopped_claim(
    conn: &Connection,
    lease: &DeliveryLease,
    clock: &dyn Fn() -> i64,
) -> Result<()> {
    let tx = write_transaction(conn)?;
    check_lease(&tx, lease, clock(), LeaseCheck::Owned)?;
    tx.execute(
        "UPDATE delivery_batches SET state='pending' WHERE id=?",
        [&lease.batch_id],
    )?;
    // The last claim of a window to stop undoes the window's attempt, unless
    // a sibling failed in it and its backoff stands.
    if end_claim(&tx, lease)? {
        tx.execute(&format!("UPDATE delivery_jobs SET attempts=CASE WHEN {FAILED_IN_WINDOW} THEN attempts ELSE MAX(attempts-1,0) END,next_attempt_ms=CASE WHEN {FAILED_IN_WINDOW} THEN next_attempt_ms ELSE 0 END WHERE id=?1"), [&lease.job_id])?;
    }
    tx.commit()?;
    Ok(())
}

/// Extend a claim, dating the extension from *inside* the write transaction.
///
/// `clock` is read after the lock is acquired, not before the call. Acquiring
/// the write lock can block for as long as the connection's busy policy
/// allows, and a timestamp taken beforehand is stale by exactly that much: the
/// renewal would then commit `stale_now + lease_ms`, which for any wait longer
/// than the lease is a deadline already in the past. The call returns `Ok`, the
/// keepalive records a renewed lease it does not have, and another worker is
/// free to reclaim and dispatch the same batch while this one is still
/// sending. Reading the clock after the lock makes the extension mean what it
/// says.
pub fn renew_lease(
    conn: &Connection,
    lease: &DeliveryLease,
    lease_ms: i64,
    clock: &dyn Fn() -> i64,
) -> Result<DeliveryLease> {
    ensure!(
        (1..=86_400_000).contains(&lease_ms),
        "invalid lease duration"
    );
    let tx = write_transaction(conn)?;
    let now_ms = clock();
    let expires_at_ms = now_ms
        .checked_add(lease_ms)
        .context("delivery clock overflow")?;
    check_lease(&tx, lease, now_ms, LeaseCheck::Owned)?;
    tx.execute(
        "UPDATE delivery_jobs SET lease_until_ms=? WHERE id=?",
        params![expires_at_ms, lease.job_id],
    )?;
    tx.commit()?;
    Ok(DeliveryLease {
        expires_at_ms,
        ..lease.clone()
    })
}

/// Persist exact destination wire bytes before sending. An adapter upgrade must
/// handle this stored mapping_version/body, or block the job. Calling again with
/// different bytes is rejected; rotating auth headers are deliberately separate.
/// The payload records no preparing build: see [`PreparedPayload::prepared_by`].
pub fn store_prepared_payload(
    conn: &Connection,
    lease: &DeliveryLease,
    mapping_version: &str,
    content_type: &str,
    body: &str,
    clock: &dyn Fn() -> i64,
) -> Result<PreparedPayload> {
    store_payload(
        conn,
        lease,
        RetainedPayload::new(PreparedPayload::stored(
            mapping_version,
            content_type,
            body,
            None,
        ))?,
        clock,
    )
}

/// [`store_prepared_payload`] for a payload already hashed and serialized:
/// the worker's, for a body this build's receiver returned from `prepare`.
pub(crate) fn store_payload(
    conn: &Connection,
    lease: &DeliveryLease,
    retained: RetainedPayload,
    clock: &dyn Fn() -> i64,
) -> Result<PreparedPayload> {
    let RetainedPayload {
        payload,
        text: retained,
    } = retained;
    let content_type = &payload.content_type;
    ensure!(
        !content_type.is_empty()
            && content_type.len() <= 200
            && !content_type.contains(['\r', '\n']),
        "invalid content type"
    );
    let tx = write_transaction(conn)?;
    let now_ms = clock();
    check_lease(&tx, lease, now_ms, LeaseCheck::Live)?;
    let job = job(&tx, &lease.job_id)?;
    ensure!(
        payload.mapping_version == job.config.mapping_version,
        "destination mapping version mismatch"
    );
    ensure!(
        retained.len() <= job.config.limits.max_prepared_bytes,
        "prepared delivery payload too large"
    );
    let (batch, stored) = pending_scope(&tx, lease)?.context("delivery batch missing")?;
    ensure!(
        Consent::new(&tx, &job.id, &job.config.selection)?.admits_all(&batch.records)?,
        "delivery batch is now excluded"
    );
    if let Some(stored) = stored {
        // The same bytes are the same payload; anything else is compared
        // as a payload, so a body persisted by another build is not refused
        // for how it was encoded or which build recorded it.
        if stored != retained {
            let stored: PreparedPayload = serde_json::from_str(&stored)?;
            ensure!(
                stored.mapping_version == payload.mapping_version
                    && stored.content_type == payload.content_type
                    && stored.body == payload.body
                    && stored.sha256 == payload.sha256,
                "cannot replace persisted destination payload"
            );
            return Ok(stored);
        }
        return Ok(payload);
    }
    tx.execute(
        "UPDATE delivery_batches SET prepared=? WHERE id=?",
        params![retained, lease.batch_id],
    )?;
    tx.commit()?;
    Ok(payload)
}

/// Validate an acknowledgment against every exact revision in this batch.
/// Partial acceptance keeps the entire immutable batch retryable; the receiver
/// must deduplicate accepted revisions. Unsupported records block the job.
/// Only records independently isolated by the adapter may be suppressed.
/// Async receipt-only acceptance must be polled by the adapter until durable;
/// it is intentionally not representable as a successful acknowledgment here.
fn isolation_frontier_ids(
    frontier: &[IsolationTask],
    expected: &HashSet<String>,
) -> Result<HashSet<String>> {
    let mut ids = HashSet::new();
    for task in frontier {
        ensure!(!task.revision_ids.is_empty(), "empty isolation task");
        for revision in &task.revision_ids {
            ensure!(
                expected.contains(revision) && ids.insert(revision.clone()),
                "invalid isolation task revision"
            );
        }
    }
    Ok(ids)
}

pub fn acknowledge(
    conn: &Connection,
    lease: &DeliveryLease,
    ack: &DeliveryAcknowledgment,
    clock: &dyn Fn() -> i64,
) -> Result<DeliveryStatus> {
    settle(conn, lease, ack, clock)?;
    status(conn, &lease.job_id)
}

/// What recording an acknowledgment did to its batch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Settled {
    /// Every revision of the batch is accounted for: it left the queue.
    pub complete: bool,
    /// Revisions the receiver has accepted from this batch, over all attempts.
    pub accepted: usize,
    /// When the batch was prepared, in epoch milliseconds.
    pub created_ms: i64,
}

/// [`acknowledge`] without reading the job's status afterwards, which scans
/// the change feed: the worker records every batch through this.
pub(crate) fn settle(
    conn: &Connection,
    lease: &DeliveryLease,
    ack: &DeliveryAcknowledgment,
    clock: &dyn Fn() -> i64,
) -> Result<Settled> {
    let tx = write_transaction(conn)?;
    let now_ms = clock();
    check_lease(&tx, lease, now_ms, LeaseCheck::Owned)?;
    ensure!(
        ack.batch_id == lease.batch_id,
        "acknowledgment batch mismatch"
    );
    let (payload, prepared, created_ms, end): (String, bool, i64, i64) = tx
        .query_row("SELECT payload,prepared IS NOT NULL,created_ms,journal_end FROM delivery_batches WHERE id=? AND job_id=? AND state IN ('pending','leased','retry_wait','blocked')", params![lease.batch_id, lease.job_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))
        .optional()?
        .context("delivery batch missing")?;
    let batch: StoredBatch = serde_json::from_str(&payload)?;
    ensure!(
        prepared,
        "destination payload must be persisted before acknowledgment"
    );
    let expected: HashSet<String> = batch
        .records
        .iter()
        .map(|r| r.revision_id.clone())
        .collect();
    let accepted: HashSet<String> = ack.accepted_revision_ids.iter().cloned().collect();
    let unsupported: HashSet<String> = ack.unsupported_revision_ids.iter().cloned().collect();
    let suppressed: HashSet<String> = ack.suppressed_revision_ids.iter().cloned().collect();
    let rejected: HashSet<String> = ack.rejected_revision_ids.iter().cloned().collect();
    let frontier = isolation_frontier_ids(&ack.isolation_frontier, &expected)?;
    ensure!(
        accepted.len() == ack.accepted_revision_ids.len()
            && unsupported.len() == ack.unsupported_revision_ids.len()
            && suppressed.len() == ack.suppressed_revision_ids.len()
            && rejected.len() == ack.rejected_revision_ids.len(),
        "duplicate acknowledgment revision"
    );
    ensure!(
        accepted.is_subset(&expected)
            && unsupported.is_subset(&expected)
            && suppressed.is_subset(&expected)
            && rejected.is_subset(&expected)
            && accepted.is_disjoint(&unsupported),
        "invalid acknowledgment revision"
    );
    ensure!(
        accepted.is_disjoint(&suppressed)
            && unsupported.is_disjoint(&suppressed)
            && accepted.is_disjoint(&rejected)
            && unsupported.is_disjoint(&rejected)
            && suppressed.is_disjoint(&rejected),
        "invalid acknowledgment revision"
    );
    ensure!(
        frontier.is_disjoint(&accepted)
            && frontier.is_disjoint(&unsupported)
            && frontier.is_disjoint(&suppressed)
            && frontier.is_disjoint(&rejected),
        "isolation task overlaps acknowledged revision"
    );
    let stored = batch_progress(&tx, &lease.batch_id)?;
    let mut all_accepted: HashSet<String> = stored.accepted.into_iter().collect();
    let mut all_suppressed: HashSet<String> = stored.suppressed.into_iter().collect();
    let mut all_rejected: HashSet<String> = stored.rejected.into_iter().collect();
    let stored_frontier_ids = isolation_frontier_ids(&stored.isolation_frontier, &expected)?;
    ensure!(
        all_accepted.is_subset(&expected)
            && all_suppressed.is_subset(&expected)
            && all_rejected.is_subset(&expected)
            && all_accepted.is_disjoint(&all_suppressed)
            && all_accepted.is_disjoint(&all_rejected)
            && all_suppressed.is_disjoint(&all_rejected)
            && stored_frontier_ids.is_disjoint(&all_accepted)
            && stored_frontier_ids.is_disjoint(&all_suppressed)
            && stored_frontier_ids.is_disjoint(&all_rejected)
            && accepted.is_disjoint(&all_suppressed)
            && suppressed.is_disjoint(&all_accepted),
        "invalid stored acknowledgment revision"
    );
    all_accepted.extend(accepted.iter().cloned());
    all_suppressed.extend(suppressed.iter().cloned());
    // Once an accepted sibling exists, the adapter promotes its provisional
    // singleton rejections to suppressions. Permit that one-way transition.
    all_rejected.retain(|revision| !all_suppressed.contains(revision));
    all_rejected.extend(rejected.iter().cloned());
    ensure!(
        all_accepted.is_disjoint(&all_rejected) && all_suppressed.is_disjoint(&all_rejected),
        "invalid stored acknowledgment revision"
    );
    let resolved: HashSet<String> = accepted
        .iter()
        .chain(&unsupported)
        .chain(&suppressed)
        .chain(&rejected)
        .cloned()
        .collect();
    let retained_or_resolved: HashSet<String> = frontier.union(&resolved).cloned().collect();
    ensure!(
        stored_frontier_ids.is_subset(&retained_or_resolved),
        "isolation progress was discarded"
    );
    let accounted: HashSet<String> = all_accepted.union(&all_suppressed).cloned().collect();
    let ordered_accepted = batch
        .records
        .iter()
        .filter(|record| all_accepted.contains(&record.revision_id))
        .map(|record| record.revision_id.clone())
        .collect::<Vec<_>>();
    let ordered_suppressed = batch
        .records
        .iter()
        .filter(|record| all_suppressed.contains(&record.revision_id))
        .map(|record| record.revision_id.clone())
        .collect::<Vec<_>>();
    let ordered_rejected = batch
        .records
        .iter()
        .filter(|record| all_rejected.contains(&record.revision_id))
        .map(|record| record.revision_id.clone())
        .collect::<Vec<_>>();
    if !unsupported.is_empty() {
        apply_failure(
            &tx,
            lease,
            DeliveryFailure::UnsupportedEvidence,
            None,
            now_ms,
        )?;
    } else if accounted != expected {
        tx.execute(
            "UPDATE delivery_batches SET accepted_revision_ids=?,suppressed_revision_ids=?,rejected_revision_ids=?,isolation_frontier=?,accepted_records=? WHERE id=?",
            params![serde_json::to_string(&ordered_accepted)?,serde_json::to_string(&ordered_suppressed)?,serde_json::to_string(&ordered_rejected)?,serde_json::to_string(&ack.isolation_frontier)?,ordered_accepted.len() as i64,&lease.batch_id],
        )?;
        apply_failure(&tx, lease, DeliveryFailure::Transient, None, now_ms)?;
    } else {
        ensure!(
            frontier.is_empty(),
            "completed batch retains isolation work"
        );
        tx.execute("UPDATE delivery_batches SET state='acknowledged',accepted_records=?,payload=NULL,prepared=NULL,accepted_revision_ids='[]',suppressed_revision_ids='[]',rejected_revision_ids='[]',isolation_frontier='[]' WHERE id=?",params![ordered_accepted.len() as i64,&lease.batch_id])?;
        // The acknowledged position follows acknowledged batches only as far
        // as the first one still unresolved: a batch acknowledged beyond a
        // failed one is kept as delivered, and counts once the gap before it
        // is acknowledged too. A sibling's failure in the same window keeps
        // its backoff and verdict, and so does an older batch still in
        // flight, which may yet fail.
        let stands = backoff_stands("?6", "?7");
        tx.execute(&format!("UPDATE delivery_jobs SET acknowledged_cursor=MAX(acknowledged_cursor,COALESCE((SELECT MAX(journal_end) FROM delivery_batches WHERE job_id=?1 AND state='acknowledged' AND journal_end<COALESCE((SELECT MIN(journal_end) FROM delivery_batches WHERE job_id=?1 AND state IN {UNRESOLVED}),9223372036854775807)),0)),last_acknowledged_ms=?2,acceptance_level=?3,acknowledged_records=acknowledged_records+?4,suppressed_records=suppressed_records+?5,skipped_records=skipped_records+?5,attempts=CASE WHEN {stands} THEN attempts ELSE 0 END,next_attempt_ms=CASE WHEN {stands} THEN next_attempt_ms ELSE 0 END,failure=CASE WHEN {stands} THEN failure ELSE NULL END WHERE id=?1"),params![lease.job_id,now_ms,match ack.acceptance_level {AcceptanceLevel::Durable=>"durable",AcceptanceLevel::Indexed=>"indexed"},ordered_accepted.len() as i64,ordered_suppressed.len() as i64,end,&lease.batch_id])?;
        end_claim(&tx, lease)?;
    }
    let complete = unsupported.is_empty() && accounted == expected;
    if !complete {
        tx.execute(
            "UPDATE delivery_batches SET accepted_records=MAX(accepted_records,?) WHERE id=?",
            params![ordered_accepted.len() as i64, lease.batch_id],
        )?;
    }
    tx.commit()?;
    Ok(Settled {
        complete,
        accepted: ordered_accepted.len(),
        created_ms,
    })
}

fn apply_failure(
    conn: &Connection,
    lease: &DeliveryLease,
    failure: DeliveryFailure,
    retry_after_ms: Option<i64>,
    now_ms: i64,
) -> Result<()> {
    let attempts: i64 = conn.query_row(
        "SELECT attempts FROM delivery_jobs WHERE id=?",
        [&lease.job_id],
        |row| row.get(0),
    )?;
    let backoff = 1_000_i64
        .saturating_mul(1_i64 << attempts.clamp(0, 12))
        .min(3_600_000);
    let digest = Sha256::digest(format!("{}:{attempts}", lease.batch_id));
    let jitter = (u16::from_be_bytes([digest[0], digest[1]]) as i64) * backoff / 327_675;
    let next = now_ms
        .saturating_add(backoff + jitter)
        .max(retry_after_ms.unwrap_or(0));
    let retryable = failure.retryable();
    // Several batches of one window can fail. The latest retry deadline
    // stands, and a job one of them blocked stays blocked under the verdict
    // that blocked it.
    conn.execute("UPDATE delivery_jobs SET state=CASE WHEN ?1 AND state<>'blocked' THEN 'active' ELSE 'blocked' END,failure=CASE WHEN state='blocked' AND failure IS NOT NULL THEN failure ELSE ?2 END,next_attempt_ms=MAX(next_attempt_ms,?3) WHERE id=?4",params![retryable,failure.code(),next,lease.job_id])?;
    conn.execute(
        "UPDATE delivery_batches SET state=? WHERE id=?",
        params![
            if retryable { "retry_wait" } else { "blocked" },
            lease.batch_id
        ],
    )?;
    end_claim(conn, lease)?;
    Ok(())
}

/// Record a receiver outcome, dating the retry from *inside* the write
/// transaction.
///
/// Ownership is fence-only here (`LeaseCheck::Owned`), so an expired but
/// unclaimed worker may still record its own outcome. That is precisely why
/// the clock must be read after the lock: acquiring it can block for as long
/// as the busy policy allows, and `apply_failure` schedules the next attempt
/// from `now_ms`. Dated from before the wait, a two-second backoff committed
/// after a thirty-second wait is already twenty-eight seconds overdue, and the
/// batch is claimable the moment the transaction commits — contention is the
/// one situation backoff exists for, and it was the one situation that
/// defeated it. `acknowledge` reads its clock the same way, because partial
/// and unsupported acceptance schedule a retry through the same path.
pub fn record_failure(
    conn: &Connection,
    lease: &DeliveryLease,
    failure: DeliveryFailure,
    retry_after_ms: Option<i64>,
    clock: &dyn Fn() -> i64,
) -> Result<DeliveryStatus> {
    let tx = write_transaction(conn)?;
    let now_ms = clock();
    check_lease(&tx, lease, now_ms, LeaseCheck::Owned)?;
    apply_failure(&tx, lease, failure, retry_after_ms, now_ms)?;
    tx.commit()?;
    status(conn, &lease.job_id)
}

/// Commit a typed receiver conflict as one fenced queue transition. The
/// prepared request and quarantined records remain inspectable after receipt
/// compaction. A child retains the exact submitted semantic records and gets
/// a deterministic ID, so a crash or a lost response cannot create a new
/// identity for the same recovery attempt.
pub fn recover_conflict(
    conn: &Connection,
    lease: &DeliveryLease,
    recovery: &ConflictRecovery,
    clock: &dyn Fn() -> i64,
) -> Result<DeliveryStatus> {
    recover_conflict_classified(conn, lease, recovery, clock).map_err(anyhow::Error::new)?;
    status(conn, &lease.job_id)
}

pub(crate) fn recover_conflict_classified(
    conn: &Connection,
    lease: &DeliveryLease,
    recovery: &ConflictRecovery,
    clock: &dyn Fn() -> i64,
) -> std::result::Result<(), ConflictRecoveryError> {
    let storage = ConflictRecoveryError::Storage;
    let rejected = ConflictRecoveryError::Rejected;
    let tx = write_transaction(conn).map_err(|error| storage(error.into()))?;
    let now_ms = clock();
    let owned: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM delivery_jobs j JOIN delivery_batches b ON b.job_id=j.id WHERE j.id=? AND j.state IN ('active','blocked') AND j.worker_id=? AND j.fence=? AND b.id=? AND b.state='leased')",
            params![lease.job_id, lease.worker_id, lease.fence, lease.batch_id],
            |row| row.get(0),
        )
        .map_err(|error| storage(error.into()))?;
    if !owned {
        return Err(ConflictRecoveryError::Fenced);
    }
    let (payload, retained, end, created_ms): (String, String, i64, i64) = tx.query_row(
        "SELECT payload,prepared,journal_end,created_ms FROM delivery_batches WHERE id=? AND job_id=? AND state='leased'",
        params![lease.batch_id, lease.job_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    ).map_err(|error| storage(error.into()))?;
    let parent: HistoryExportBatch =
        serde_json::from_str(&payload).map_err(|error| rejected(error.into()))?;
    let prepared: PreparedPayload =
        serde_json::from_str(&retained).map_err(|error| rejected(error.into()))?;
    let (child, child_prepared, submitted_records) =
        crate::destination::conflict::verify(&prepared, &parent, recovery).map_err(rejected)?;
    let kind = if recovery.quarantined.is_empty() {
        "batch_id"
    } else {
        "record_revision"
    };
    tx.execute(
        "INSERT INTO delivery_conflict_attempts(parent_batch_id,job_id,child_batch_id,kind,submitted_digest,payload,prepared,created_ms) VALUES (?,?,?,?,?,?,?,?)",
        params![lease.batch_id,lease.job_id,(!child.records.is_empty()).then_some(&child.batch_id),kind,recovery.submitted_digest,payload,retained,now_ms],
    ).map_err(|error| storage(error.into()))?;
    for item in &recovery.quarantined {
        let record = submitted_records
            .iter()
            .find(|record| record.revision_id == item.revision_id)
            .ok_or_else(|| {
                rejected(anyhow::anyhow!(
                    "conflicting revision missing from prepared request"
                ))
            })?;
        let record_json = serde_json::to_string(record).map_err(|error| rejected(error.into()))?;
        tx.execute(
            "INSERT INTO delivery_quarantine(job_id,parent_batch_id,revision_id,record_id,record_json,submitted_digest,current_digest,created_ms) VALUES (?,?,?,?,?,?,?,?)",
            params![lease.job_id,lease.batch_id,item.revision_id,item.record_id,record_json,item.submitted_digest,item.current_digest,now_ms],
        ).map_err(|error| storage(error.into()))?;
    }
    if !child.records.is_empty() {
        insert_batch(&tx, &child, end, created_ms).map_err(|error| storage(error.into()))?;
        take_claim_place(&tx, &child.batch_id, &lease.batch_id).map_err(storage)?;
        let child_prepared =
            serde_json::to_string(&child_prepared).map_err(|error| rejected(error.into()))?;
        tx.execute(
            "UPDATE delivery_batches SET prepared=? WHERE id=?",
            params![child_prepared, child.batch_id],
        )
        .map_err(|error| storage(error.into()))?;
    }
    tx.execute(
        "UPDATE delivery_batches SET state=?,payload=NULL,prepared=NULL WHERE id=?",
        params![
            if child.records.is_empty() {
                "acknowledged"
            } else {
                "suppressed"
            },
            lease.batch_id
        ],
    )
    .map_err(|error| storage(error.into()))?;
    let stands = backoff_stands("?4", "?5");
    tx.execute(&format!("UPDATE delivery_jobs SET suppressed_records=suppressed_records+?2,acknowledged_cursor=CASE WHEN ?3 THEN MAX(acknowledged_cursor,COALESCE((SELECT MAX(journal_end) FROM delivery_batches WHERE job_id=?1 AND state='acknowledged' AND journal_end<COALESCE((SELECT MIN(journal_end) FROM delivery_batches WHERE job_id=?1 AND state IN {UNRESOLVED}),9223372036854775807)),0)) ELSE acknowledged_cursor END,attempts=CASE WHEN {stands} THEN attempts ELSE 0 END,next_attempt_ms=CASE WHEN {stands} THEN next_attempt_ms ELSE 0 END,failure=CASE WHEN {stands} THEN failure ELSE NULL END WHERE id=?1"),
        params![lease.job_id,recovery.quarantined.len() as i64,child.records.is_empty(),end,&lease.batch_id]).map_err(|error| storage(error.into()))?;
    end_claim(&tx, lease).map_err(|error| storage(error.into()))?;
    tx.commit().map_err(|error| storage(error.into()))?;
    Ok(())
}
enum JobTransition {
    Pause,
    Resume,
}
fn change_state(
    conn: &Connection,
    job_id: &str,
    transition: JobTransition,
) -> Result<DeliveryStatus> {
    let tx = write_transaction(conn)?;
    let existing = job(&tx, job_id)?;
    ensure!(existing.state != "cancelled", "delivery job is cancelled");
    // Older versions allowed blocked -> paused. Preserve that recorded failure
    // as well as the current state until an explicit retry clears it.
    let permanent_failure: bool = tx.query_row(
        "SELECT failure IS NOT NULL AND failure NOT IN ('transient','rate_limited') FROM delivery_jobs WHERE id=?",
        [job_id], |row| row.get(0),
    )?;
    ensure!(
        !permanent_failure,
        "delivery job is blocked; retry explicitly"
    );
    let state = match transition {
        JobTransition::Pause => {
            ensure!(
                matches!(existing.state.as_str(), "active" | "paused"),
                "only active or paused jobs can pause; retry blocked jobs explicitly"
            );
            "paused"
        }
        JobTransition::Resume => {
            ensure!(
                existing.state == "paused",
                "only a paused job can resume; retry blocked jobs explicitly"
            );
            "active"
        }
    };
    tx.execute("UPDATE delivery_jobs SET state=?,fence=fence+1,worker_id=NULL,lease_until_ms=NULL WHERE id=?",params![state,job_id])?;
    tx.execute(
        "UPDATE delivery_batches SET state='pending' WHERE job_id=? AND state='leased'",
        [job_id],
    )?;
    tx.commit()?;
    status(conn, job_id)
}
/// A job's state (`active`, `paused`, `blocked` or `cancelled`) and nothing
/// else: one indexed row, for a loop that checks it every second or so,
/// where [`status`] also counts the job's queue and unexamined changes.
pub fn job_state(conn: &Connection, job_id: &str) -> Result<String> {
    conn.query_row(
        "SELECT state FROM delivery_jobs WHERE id=?",
        [job_id],
        |row| row.get(0),
    )
    .optional()?
    .context("delivery job not found")
}
/// What a host checks before it drains a job: its state, failure and stored
/// configuration, from one indexed row. [`status`] also counts the job's
/// queue and scans the feed, which a check run before every pass does not
/// need; the drain reads the full status when it ends.
#[derive(Debug, Clone)]
pub struct JobCheck {
    pub state: String,
    pub failure: Option<String>,
    pub config: DeliveryJobConfig,
}
pub fn job_check(conn: &Connection, job_id: &str) -> Result<JobCheck> {
    let (state, failure, config): (String, Option<String>, String) = conn
        .query_row(
            "SELECT state,failure,config_json FROM delivery_jobs WHERE id=?",
            [job_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?
        .context("delivery job not found")?;
    Ok(JobCheck {
        state,
        failure,
        config: stored_config(&config)?,
    })
}
/// Pause an active job without clearing failures. Blocked jobs require explicit retry.
pub fn pause_job(conn: &Connection, job_id: &str) -> Result<DeliveryStatus> {
    change_state(conn, job_id, JobTransition::Pause)
}
/// Resume only a paused job. State and failure checks share the write transaction.
pub fn resume_job(conn: &Connection, job_id: &str) -> Result<DeliveryStatus> {
    change_state(conn, job_id, JobTransition::Resume)
}
pub fn retry_job(conn: &Connection, job_id: &str) -> Result<DeliveryStatus> {
    let tx = write_transaction(conn)?;
    reset_job_retry(&tx, job_id)?;
    tx.commit()?;
    status(conn, job_id)
}

/// Retry a blocked verdict once per build, atomically recording the build with
/// the job transition. History retains every build, including after rollbacks.
/// A legacy file marker may be imported only when it explicitly names this job.
/// Active, paused and cancelled jobs record the build without changing state.
pub fn retry_job_for_build(
    conn: &Connection,
    job_id: &str,
    build: &str,
    legacy_build: Option<&str>,
) -> Result<()> {
    let tx = write_transaction(conn)?;
    let current = job(&tx, job_id)?;
    let recorded: Option<String> = tx.query_row(
        "SELECT retry_build FROM delivery_jobs WHERE id=?",
        [job_id],
        |row| row.get(0),
    )?;
    // Keep the former single-build column for older probes. Import it here as
    // well as during migration in case an older probe has run since migration.
    for previous in recorded.as_deref().into_iter().chain(legacy_build) {
        tx.execute(
            "INSERT OR IGNORE INTO delivery_job_builds(job_id,build) VALUES (?,?)",
            params![job_id, previous],
        )?;
    }
    let first_run = tx.execute(
        "INSERT OR IGNORE INTO delivery_job_builds(job_id,build) VALUES (?,?)",
        params![job_id, build],
    )? == 1;
    if first_run && current.state == "blocked" {
        reset_job_retry(&tx, job_id)?;
    }
    tx.execute(
        "UPDATE delivery_jobs SET retry_build=?1 WHERE id=?2 AND retry_build IS NOT ?1",
        params![build, job_id],
    )?;
    tx.commit()?;
    Ok(())
}

fn reset_job_retry(conn: &Connection, job_id: &str) -> Result<()> {
    ensure!(
        job(conn, job_id)?.state != "cancelled",
        "delivery job is cancelled"
    );
    conn.execute("UPDATE delivery_jobs SET state='active',failure=NULL,next_attempt_ms=0,fence=fence+1,worker_id=NULL,lease_until_ms=NULL WHERE id=?",[job_id])?;
    conn.execute("UPDATE delivery_batches SET state='pending' WHERE job_id=? AND state IN ('leased','blocked','retry_wait')",[job_id])?;
    // Provisional singleton rejections may all have come from a receiver-wide
    // or schema failure. An explicit/build retry re-tests them after the
    // receiver or probe changes; accepted and proven-suppressed progress stays.
    conn.execute(
        "UPDATE delivery_batches SET rejected_revision_ids='[]',isolation_frontier='[]' WHERE job_id=?",
        [job_id],
    )?;
    Ok(())
}
/// Explicit discard, separate from pause. Already accepted remote data is not
/// deleted. A later create_job starts a new generation and historical backfill.
pub fn cancel_job(conn: &Connection, job_id: &str) -> Result<DeliveryStatus> {
    let tx = write_transaction(conn)?;
    job(&tx, job_id)?;
    tx.execute("UPDATE delivery_jobs SET state='cancelled',fence=fence+1,worker_id=NULL,lease_until_ms=NULL WHERE id=?",[job_id])?;
    tx.execute("UPDATE delivery_batches SET state='cancelled',payload=NULL,prepared=NULL WHERE job_id=? AND state IN ('pending','leased','retry_wait','blocked')",[job_id])?;
    tx.execute(
        "DELETE FROM delivery_conflict_attempts WHERE job_id=?",
        [job_id],
    )?;
    tx.execute("DELETE FROM delivery_quarantine WHERE job_id=?", [job_id])?;
    sessions::cancel(&tx, job_id)?;
    tx.commit()?;
    status(conn, job_id)
}

/// Recheck immediately before dispatch, after async mapping or lease renewal.
/// Returns only the exact persisted body. Local fencing cannot retract a socket
/// request already sent; destinations still need idempotency/revision ordering.
pub fn validate_dispatch(
    conn: &Connection,
    lease: &DeliveryLease,
    clock: &dyn Fn() -> i64,
) -> Result<PreparedPayload> {
    let tx = write_transaction(conn)?;
    // Dated from inside the lock: a wait for it longer than the lease must
    // not validate against a timestamp from before the wait.
    let now_ms = clock();
    check_lease(&tx, lease, now_ms, LeaseCheck::Live)?;
    let job = job(&tx, &lease.job_id)?;
    let (batch, prepared) = pending_scope(&tx, lease)?.context("delivery batch missing")?;
    ensure!(
        Consent::new(&tx, &job.id, &job.config.selection)?.admits_all(&batch.records)?,
        "delivery batch is now excluded"
    );
    let prepared = prepared.context("destination payload must be persisted before dispatch")?;
    Ok(serde_json::from_str(&prepared)?)
}

/// What consent reads of one record: its kind, source and session, and for a
/// relationship the child session it discloses.
struct RecordScope<'a> {
    kind: &'a str,
    source: &'a str,
    session_id: Option<&'a str>,
    child_session_id: Option<&'a str>,
}
impl<'a> RecordScope<'a> {
    fn of(record: &'a HistoryExportRecord) -> Self {
        Self {
            kind: &record.kind,
            source: &record.source,
            session_id: record.session_id.as_deref(),
            child_session_id: record
                .payload
                .get("child_session_id")
                .and_then(|v| v.as_str()),
        }
    }
}

/// Consent for the records of one batch, read inside one transaction: the
/// job's mode once, and each session's stored exclusion and membership once,
/// however many of the batch's records name it. It lives no longer than the
/// transaction that built it, so it answers exactly as a point query per
/// record in that transaction would, including the recheck immediately
/// before dispatch.
struct Consent<'a> {
    conn: &'a Connection,
    job_id: &'a str,
    selection: &'a ExportSelection,
    scoped: bool,
    excluded: HashMap<(String, String), bool>,
    members: HashMap<(String, String), bool>,
}
impl<'a> Consent<'a> {
    fn new(conn: &'a Connection, job_id: &'a str, selection: &'a ExportSelection) -> Result<Self> {
        Ok(Self {
            conn,
            job_id,
            selection,
            scoped: is_session_job(conn, job_id)?,
            excluded: HashMap::new(),
            members: HashMap::new(),
        })
    }
    /// [`excluded`], remembered per session.
    fn excluded(&mut self, source: &str, session: Option<&str>) -> Result<bool> {
        let Some(session_id) = session else {
            return Ok(!self.selection.sessionless);
        };
        if self
            .selection
            .excluded_sessions
            .iter()
            .any(|id| id.source == source && id.session_id == session_id)
        {
            return Ok(true);
        }
        let key = (source.to_owned(), session_id.to_owned());
        if let Some(&excluded) = self.excluded.get(&key) {
            return Ok(excluded);
        }
        let excluded = self
            .conn
            .prepare_cached(
                "SELECT EXISTS(SELECT 1 FROM delivery_exclusions WHERE source=? AND session_id=?)",
            )?
            .query_row(params![source, session_id], |row| row.get::<_, bool>(0))?
            || in_unshared_folder(self.conn, source, session_id)?;
        self.excluded.insert(key, excluded);
        Ok(excluded)
    }
    /// Whether the stored exclusions or the job's own selection withhold the
    /// record, or the child session a relationship discloses.
    fn record_excluded(&mut self, record: &HistoryExportRecord) -> Result<bool> {
        self.scope_excluded(&RecordScope::of(record))
    }
    fn scope_excluded(&mut self, record: &RecordScope<'_>) -> Result<bool> {
        if self.excluded(record.source, record.session_id)? {
            return Ok(true);
        }
        if record.kind == "relationship" {
            if let Some(child) = record.child_session_id {
                return self.excluded(record.source, Some(child));
            }
        }
        Ok(false)
    }
    /// Whether `session` is a member of this session job.
    fn member(&mut self, source: &str, session: Option<&str>) -> Result<bool> {
        let Some(session_id) = session else {
            return Ok(false);
        };
        let key = (source.to_owned(), session_id.to_owned());
        if let Some(&member) = self.members.get(&key) {
            return Ok(member);
        }
        let member = self
            .conn
            .prepare_cached("SELECT EXISTS(SELECT 1 FROM delivery_session_members WHERE job_id=? AND source=? AND session_id=?)")?
            .query_row(params![self.job_id, source, session_id], |row| row.get::<_, bool>(0))?;
        self.members.insert(key, member);
        Ok(member)
    }
    /// A session job sends only its members' records, and a relationship
    /// only when its child is a member too, so it cannot disclose a private
    /// child through a public parent. Every record of any other job is allowed.
    fn allowed(&mut self, record: &RecordScope<'_>) -> Result<bool> {
        if !self.scoped {
            return Ok(true);
        }
        if !self.member(record.source, record.session_id)? {
            return Ok(false);
        }
        if record.kind == "relationship" {
            if let Some(child) = record.child_session_id {
                return self.member(record.source, Some(child));
            }
        }
        Ok(true)
    }
    fn admits(&mut self, record: &RecordScope<'_>) -> Result<bool> {
        Ok(!self.scope_excluded(record)? && self.allowed(record)?)
    }
    fn admits_all(&mut self, records: &[StoredRecord]) -> Result<bool> {
        for record in records {
            if !self.admits(&record.scope())? {
                return Ok(false);
            }
        }
        Ok(true)
    }
}

/// The parts of a stored batch record that consent and acknowledgment read.
/// A batch row holds up to the batch byte cap of JSON and is read on every
/// attempt, so its payloads are skipped rather than materialized: only a
/// relationship's `child_session_id` is kept.
#[derive(Deserialize)]
struct StoredRecord {
    revision_id: String,
    kind: String,
    source: String,
    session_id: Option<String>,
    #[serde(default, deserialize_with = "child_session")]
    payload: Option<String>,
}
impl StoredRecord {
    fn scope(&self) -> RecordScope<'_> {
        RecordScope {
            kind: &self.kind,
            source: &self.source,
            session_id: self.session_id.as_deref(),
            child_session_id: self.payload.as_deref(),
        }
    }
}
#[derive(Deserialize)]
struct StoredBatch {
    records: Vec<StoredRecord>,
}

/// A payload's `child_session_id` when the payload is an object holding a
/// string there, read the way `serde_json::Value::get` would (the last of
/// repeated keys wins); everything else in the payload is skipped.
fn child_session<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<String>, D::Error> {
    use serde::de::{IgnoredAny, MapAccess, SeqAccess, Visitor};
    struct Child;
    impl<'de> Visitor<'de> for Child {
        type Value = Option<String>;
        fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
            formatter.write_str("a record payload")
        }
        fn visit_map<A: MapAccess<'de>>(
            self,
            mut map: A,
        ) -> std::result::Result<Self::Value, A::Error> {
            let mut child = None;
            while let Some(key) = map.next_key::<std::borrow::Cow<'de, str>>()? {
                if key == "child_session_id" {
                    child = map
                        .next_value::<serde_json::Value>()?
                        .as_str()
                        .map(str::to_owned);
                } else {
                    map.next_value::<IgnoredAny>()?;
                }
            }
            Ok(child)
        }
        fn visit_seq<A: SeqAccess<'de>>(
            self,
            mut seq: A,
        ) -> std::result::Result<Self::Value, A::Error> {
            while seq.next_element::<IgnoredAny>()?.is_some() {}
            Ok(None)
        }
        fn visit_unit<E>(self) -> std::result::Result<Self::Value, E> {
            Ok(None)
        }
        fn visit_none<E>(self) -> std::result::Result<Self::Value, E> {
            Ok(None)
        }
        fn visit_bool<E>(self, _: bool) -> std::result::Result<Self::Value, E> {
            Ok(None)
        }
        fn visit_i64<E>(self, _: i64) -> std::result::Result<Self::Value, E> {
            Ok(None)
        }
        fn visit_u64<E>(self, _: u64) -> std::result::Result<Self::Value, E> {
            Ok(None)
        }
        fn visit_f64<E>(self, _: f64) -> std::result::Result<Self::Value, E> {
            Ok(None)
        }
        fn visit_str<E>(self, _: &str) -> std::result::Result<Self::Value, E> {
            Ok(None)
        }
    }
    deserializer.deserialize_any(Child)
}

/// The leased batch as consent and acknowledgment read it, and its retained
/// destination body as stored.
fn pending_scope(
    conn: &Connection,
    lease: &DeliveryLease,
) -> Result<Option<(StoredBatch, Option<String>)>> {
    let value = conn.query_row("SELECT payload,prepared FROM delivery_batches WHERE id=? AND job_id=? AND state IN ('pending','leased','retry_wait','blocked')",params![lease.batch_id,lease.job_id],|row| Ok((row.get::<_,String>(0)?,row.get::<_,Option<String>>(1)?))).optional()?;
    value
        .map(|(payload, prepared)| Ok((serde_json::from_str(&payload)?, prepared)))
        .transpose()
}

/// Release settled batch receipts, at most `limit` per call. Pending batches,
/// aggregate job counters and generation identities remain intact, and so
/// does an acknowledged batch beyond one of its job's unresolved batches,
/// which the job's acknowledged position still has to move through.
pub fn compact_receipts(conn: &Connection, limit: usize) -> Result<usize> {
    ensure!(
        (1..=10_000).contains(&limit),
        "invalid receipt compaction limit"
    );
    let tx = write_transaction(conn)?;
    // An acknowledged batch beyond one of its job's unresolved batches still
    // decides where the job's acknowledged position moves once that batch
    // resolves, so it stays until then.
    let removed=tx.execute(&format!("DELETE FROM delivery_batches WHERE seq IN (SELECT seq FROM delivery_batches b WHERE state IN ('acknowledged','suppressed','cancelled') AND NOT (state='acknowledged' AND journal_end>COALESCE((SELECT MIN(u.journal_end) FROM delivery_batches u WHERE u.job_id=b.job_id AND u.state IN {UNRESOLVED}),9223372036854775807)) ORDER BY seq LIMIT ?)"),[limit as i64])?;
    tx.commit()?;
    Ok(removed)
}

/// Release every upload row once no job can consume it: with every job
/// cancelled, nothing dispatches a batch, advances a member's backfill or
/// matches a receipt, so batches, members and session scopes are dead weight.
/// Returns whether the install had no live job and was released.
///
/// Job rows, the origin and the exclusions stay. The origin keeps a reconnect
/// numbering revisions above everything this origin sent, and exclusions are
/// the person's consent, which outlives any one job.
pub fn release_decommissioned(conn: &Connection) -> Result<bool> {
    let tx = write_transaction(conn)?;
    let live: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM delivery_jobs WHERE state<>'cancelled')",
        [],
        |r| r.get(0),
    )?;
    if live {
        return Ok(false);
    }
    tx.execute("DELETE FROM delivery_batches", [])?;
    tx.execute("DELETE FROM delivery_conflict_attempts", [])?;
    tx.execute("DELETE FROM delivery_quarantine", [])?;
    tx.execute("DELETE FROM delivery_session_members", [])?;
    tx.execute("DELETE FROM delivery_session_jobs", [])?;
    tx.commit()?;
    Ok(true)
}

/// Every session identity the store holds evidence for — catalog rows,
/// prompts, events and every other evidence table, including sessions not yet
/// catalogued — so a consent baseline cannot miss partially read data.
pub fn session_identities(conn: &Connection) -> Result<Vec<SessionIdentity>> {
    let store = feed::store(conn)?;
    let mut identities = Vec::new();
    let mut query = ai_hist::IdentityQuery::default().limit(10_000);
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
/// Whether the store holds evidence for `identity`, by the same rule as
/// [`session_identities`], so every session it counts is one a user can
/// select.
pub fn has_session(conn: &Connection, identity: &SessionIdentity) -> Result<bool> {
    Ok(
        feed::store(conn)?.has_session(&ai_hist::SessionIdentity::new(
            identity.source.as_str(),
            identity.session_id.as_str(),
        ))?,
    )
}
/// Where a job stands, read before a session listing reads its pending
/// batches; see [`feed::UploadPositions`].
pub fn upload_positions(conn: &Connection, job_id: &str) -> Result<UploadPositions> {
    feed::upload_positions(conn, job_id)
}
/// Which of `sessions` the job may still send something for, as of
/// `positions`; see [`feed::unsent_sessions`]. A session outside this set,
/// and in no batch pending since `positions` was read, has had everything the
/// job sends acknowledged.
pub fn unsent_sessions(
    conn: &Connection,
    positions: &UploadPositions,
    sessions: &[SessionIdentity],
) -> Result<HashSet<SessionIdentity>> {
    feed::unsent_sessions(conn, positions, sessions)
}
/// The upload state of `sessions`, none in a batch pending since `positions`
/// was read, reusing `cache`'s proofs; see [`feed::session_states`].
pub fn session_states(
    conn: &Connection,
    positions: &UploadPositions,
    sessions: &[SessionIdentity],
    cache: StatusCache,
) -> Result<SessionStates> {
    feed::session_states(conn, positions, sessions, cache)
}
/// [`session_states`] within `budget`, for a caller that must bound it more
/// tightly than a listing does.
pub fn session_states_within(
    conn: &Connection,
    positions: &UploadPositions,
    sessions: &[SessionIdentity],
    cache: StatusCache,
    budget: std::time::Duration,
) -> Result<SessionStates> {
    feed::session_states_within(conn, positions, sessions, cache, budget)
}
/// How long a session listing may spend deciding upload states.
pub const SESSION_STATUS_BUDGET: std::time::Duration = feed::UNSENT_BUDGET;
/// Whether the stored exclusions let `identity` be shared at all: the one
/// consent rule for an identity leaving the machine.
pub fn is_shareable(conn: &Connection, identity: &SessionIdentity) -> Result<bool> {
    Ok(!conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM delivery_exclusions WHERE source=? AND session_id=?)",
        params![identity.source, identity.session_id],
        |row| row.get::<_, bool>(0),
    )? && !in_unshared_folder(conn, &identity.source, &identity.session_id)?)
}

/// How long a delivery write waits for another writer before failing: long
/// enough to outlast a capture transaction, as every writer of the store does.
const BUSY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

fn open_connection(path: &std::path::Path) -> Result<Connection> {
    let conn = Connection::open(path)?;
    conn.busy_timeout(BUSY_TIMEOUT)?;
    // The store's own writers enable this so a REPLACE fires the change
    // feed's delete stamping; any write through this connection must too.
    conn.pragma_update(None, "recursive_triggers", true)?;
    Ok(conn)
}

/// Local history predates the schema this build reads, and the migration is
/// waiting for the collector. On a large store it runs for minutes, so only
/// the collector lock's holder, which no caller's timeout can kill, runs it:
/// a killed migration rolls back, and every other process that tried it would
/// hold the writer lock just long enough to starve the one that could finish.
#[derive(Debug)]
pub struct UpgradePending;
impl std::fmt::Display for UpgradePending {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("local history is waiting for the collector to upgrade it")
    }
}
impl std::error::Error for UpgradePending {}
/// Whether `error` is local history waiting for its upgrade: [`UpgradePending`]
/// or the store refusing a read the upgrade has not reached yet.
pub fn is_upgrade_pending(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause.is::<UpgradePending>()
            || cause
                .downcast_ref::<ai_hist::Error>()
                .is_some_and(ai_hist::Error::is_stale_schema)
    })
}

/// Refuse, as [`UpgradePending`], a store the collector has not yet upgraded
/// to the schema this build reads, including one that predates only the
/// change feed, which opens and lists sessions as before.
pub fn ensure_current(path: &std::path::Path) -> Result<()> {
    feed::ensure_current(path)
}

/// Open evidence and upload state as the install's owner: the caller holds
/// the collector lock. Migrates the evidence store, creates the upload tables,
/// and rebuilds an install whose uploads still ran on the export journal.
pub fn open_db(path: &std::path::Path) -> Result<Connection> {
    create_parent(path)?;
    let mut options = ai_hist::StoreOptions::default();
    options.db_path = Some(path.to_path_buf());
    ai_hist::SessionStore::open(options)?;
    let conn = open_upload_state(path)?;
    // The feed is opened only when there is an install to rebuild: the
    // writable open above has just migrated the store, so the read-only
    // check the feed's open makes cannot fail here.
    schema::rebuild(&conn, || feed::store(&conn))?;
    Ok(conn)
}
/// Open evidence and upload state for a control action that may run beside a
/// collector: pause, resume, compaction. Creates missing tables but never
/// rebuilds or migrates, which only the collector lock's holder may do: a
/// store written by an older build is [`UpgradePending`] until it has.
pub fn open_control_db(path: &std::path::Path) -> Result<Connection> {
    create_parent(path)?;
    if path.exists() {
        feed::ensure_current(path)?;
    } else {
        // A new store has nothing to migrate, so creating it is quick.
        let mut options = ai_hist::StoreOptions::default();
        options.db_path = Some(path.to_path_buf());
        ai_hist::SessionStore::open(options)?;
    }
    open_upload_state(path)
}
fn create_parent(path: &std::path::Path) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    Ok(())
}
fn open_upload_state(path: &std::path::Path) -> Result<Connection> {
    let conn = open_connection(path)?;
    schema::init(&conn)?;
    Ok(conn)
}
/// Read upload state without writing, for status and listings.
pub fn open_db_readonly(path: &std::path::Path) -> Result<Connection> {
    let conn = Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY
            | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX
            | rusqlite::OpenFlags::SQLITE_OPEN_URI,
    )
    .with_context(|| format!("opening {} read-only", path.display()))?;
    conn.busy_timeout(BUSY_TIMEOUT)?;
    Ok(conn)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A claude.ai cloud session has no folder of its own: its consent is
    /// its login's (`claude_dirs::cloud_sessions_shared`), never a place in
    /// the catalog. This connection has no catalog to read.
    #[test]
    fn a_claude_cloud_session_follows_its_login_not_the_catalog() {
        let conn = Connection::open_in_memory().unwrap();
        let shared = crate::relay::claude_dirs::cloud_sessions_shared_here();
        for id in ["cse_01abc", "session_01abc"] {
            assert_eq!(in_unshared_folder(&conn, "claude", id).unwrap(), !shared);
        }
        assert!(!in_unshared_folder(&conn, "devin", "cse_01abc").unwrap());
    }

    fn template() -> HistoryExportBatch {
        HistoryExportBatch {
            schema_version: EXPORT_SCHEMA_VERSION,
            origin_id: "origin".into(),
            batch_id: "batch".into(),
            job_id: "job".into(),
            generation: 1,
            destination_id: "relayhistory".into(),
            instance_id: "teams-probe".into(),
            account_id: "relayhistory:account".into(),
            mapping_version: "relayhistory-delivery-v1".into(),
            records: vec![],
        }
    }
    fn record(n: usize, text: &str) -> HistoryExportRecord {
        HistoryExportRecord {
            schema_version: 1,
            origin_id: "origin".into(),
            record_id: format!("record-{n}"),
            revision_id: format!("revision-{n}"),
            revision: n as i64 + 1,
            kind: "session_event".into(),
            source: "claude".into(),
            session_id: Some("session".into()),
            operation: "upsert".into(),
            payload: serde_json::json!({"event_uid": format!("event-{n}"), "text": text}),
        }
    }

    /// The running size is the batch's serialized length after every
    /// admission, including a full batch and a record shortened to fit.
    #[test]
    fn a_filling_batch_knows_its_serialized_length() {
        let limits = DeliveryLimits {
            max_batch_bytes: 4_096,
            ..DeliveryLimits::default()
        };
        let mut filling = Filling::new(template()).unwrap();
        assert_eq!(
            filling.bytes,
            serde_json::to_vec(&filling.batch).unwrap().len()
        );
        let mut outcomes = Vec::new();
        for n in 0..40 {
            let text = "quote\" and \\ unicode \u{e9} ".repeat(n % 7);
            let identity = [serde_json::json!(format!("event-{n}"))];
            outcomes.push(push_record(&mut filling, record(n, &text), &identity, &limits).unwrap());
            assert_eq!(
                filling.bytes,
                serde_json::to_vec(&filling.batch).unwrap().len()
            );
            assert!(filling.bytes <= limits.max_batch_bytes);
        }
        assert!(outcomes.contains(&Admitted::Full));

        let mut alone = Filling::new(template()).unwrap();
        let identity = [serde_json::json!("event-0")];
        let admitted = push_record(
            &mut alone,
            record(0, &"x".repeat(10_000)),
            &identity,
            &limits,
        )
        .unwrap();
        assert_eq!(admitted, Admitted::Added);
        assert_eq!(alone.bytes, serde_json::to_vec(&alone.batch).unwrap().len());
        assert!(alone.bytes <= limits.max_batch_bytes);
    }

    /// A stored record's consent scope reads the same child session as the
    /// full record does, whatever its payload holds.
    #[test]
    fn a_stored_record_reads_the_child_session_as_the_full_record_does() {
        for payload in [
            serde_json::json!({"child_session_id": "child", "text": "x"}),
            serde_json::json!({"nested": {"child_session_id": "deep"}, "child_session_id": 7}),
            serde_json::json!({"parent": "p"}),
            serde_json::json!(null),
            serde_json::json!([{"child_session_id": "in-array"}]),
            serde_json::json!("child"),
        ] {
            let mut full = record(0, "");
            full.kind = "relationship".into();
            full.payload = payload.clone();
            let stored: StoredBatch = serde_json::from_str(
                &serde_json::to_string(&serde_json::json!({ "records": [full] })).unwrap(),
            )
            .unwrap();
            assert_eq!(
                stored.records[0].scope().child_session_id,
                RecordScope::of(&full).child_session_id,
                "{payload}"
            );
        }
        // A repeated key keeps the last value, as a parsed payload does.
        let text = r#"{"records":[{"revision_id":"r","kind":"relationship","source":"s","session_id":"p","payload":{"child_session_id":"first","child_session_id":"last"}}]}"#;
        let stored: StoredBatch = serde_json::from_str(text).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(text).unwrap();
        assert_eq!(
            stored.records[0].payload.as_deref(),
            parsed["records"][0]["payload"]["child_session_id"].as_str()
        );
    }

    /// A generation created with a former build's default limits runs with
    /// the current defaults; limits set explicitly are kept.
    #[test]
    fn former_default_limits_run_as_the_current_defaults() {
        assert_eq!(
            DeliveryLimits::FORMER_DEFAULT.effective(),
            DeliveryLimits::default()
        );
        let explicit = DeliveryLimits {
            max_batch_bytes: 4_096,
            ..DeliveryLimits::FORMER_DEFAULT
        };
        assert_eq!(explicit.clone().effective(), explicit);
        // The current defaults fit the receiver: a full batch, wrapped in the
        // request envelope, stays under its 2 MiB request cap, and the
        // retained form of any such body fits the prepared cap.
        let limits = DeliveryLimits::default();
        assert!(limits.max_batch_bytes + 1_024 <= crate::destination::MAX_BODY_BYTES);
        assert!(2 * crate::destination::MAX_BODY_BYTES + 1_024 <= limits.max_prepared_bytes);
        assert_eq!(
            limits.max_batch_records,
            crate::destination::MAX_BATCH_RECORDS
        );
    }

    /// A job with `events` session events and batches of two records, in a
    /// fresh store.
    fn windowed_job(events: usize) -> (tempfile::TempDir, Connection, String) {
        job_with(
            events,
            DeliveryLimits {
                max_batch_records: 2,
                ..DeliveryLimits::default()
            },
        )
    }
    /// A job with `events` session events under `limits`, in a fresh store.
    fn job_with(events: usize, limits: DeliveryLimits) -> (tempfile::TempDir, Connection, String) {
        let directory = tempfile::tempdir().unwrap();
        let conn = open_db(&directory.path().join("history.db")).unwrap();
        for n in 0..events {
            conn.execute("INSERT INTO session_events(source,session_id,event_uid,ts_ms,role,kind,text) VALUES ('claude','session',?1,42,'user','text','window')", [format!("event-{n}")]).unwrap();
        }
        let config = DeliveryJobConfig {
            destination_id: "fixture".into(),
            instance_id: "window".into(),
            account_id: "fixture-account".into(),
            mapping_version: "1".into(),
            selection: ExportSelection {
                all_sources: true,
                kinds: vec!["session_event".into()],
                ..ExportSelection::default()
            },
            limits,
        };
        let job = create_job(&conn, &config, 0).unwrap().job_id;
        (directory, conn, job)
    }
    fn persisted(conn: &Connection, claim: &ClaimedBatch, clock: &dyn Fn() -> i64) {
        store_prepared_payload(conn, &claim.lease, "1", "application/json", "{}", clock).unwrap();
    }
    fn accepted(claim: &ClaimedBatch) -> DeliveryAcknowledgment {
        DeliveryAcknowledgment {
            batch_id: claim.batch.batch_id.clone(),
            accepted_revision_ids: claim
                .batch
                .records
                .iter()
                .map(|record| record.revision_id.clone())
                .collect(),
            unsupported_revision_ids: vec![],
            suppressed_revision_ids: vec![],
            rejected_revision_ids: vec![],
            isolation_frontier: vec![],
            acceptance_level: AcceptanceLevel::Durable,
        }
    }
    fn claimed(next: NextClaim) -> ClaimedBatch {
        match next {
            NextClaim::Claimed(claim) => *claim,
            other => panic!("expected a claim, found {other:?}"),
        }
    }
    fn end_of(conn: &Connection, batch_id: &str) -> i64 {
        conn.query_row(
            "SELECT journal_end FROM delivery_batches WHERE id=?",
            [batch_id],
            |r| r.get(0),
        )
        .unwrap()
    }
    fn holder(conn: &Connection, job_id: &str) -> Option<String> {
        conn.query_row(
            "SELECT worker_id FROM delivery_jobs WHERE id=?",
            [job_id],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// A window prepares batches over consecutive stretches of the feed and
    /// claims them oldest first under one lease. The acknowledged position
    /// moves only through acknowledged batches with nothing unresolved before
    /// them: batches acknowledged beyond one that failed stay delivered, are
    /// not compacted away, and count once the failed one is retried.
    #[test]
    fn a_window_acknowledges_through_a_failed_batch_only_once_it_is_retried() {
        let (_directory, conn, job_id) = windowed_job(6);
        let store = feed::store(&conn).unwrap();
        let none = PublishedLimits::default();
        let ids: Vec<String> = (0..3)
            .map(|_| {
                prepare_batch_from(&conn, &store, &job_id, 0, 3, none)
                    .unwrap()
                    .batch_id
                    .unwrap()
            })
            .collect();
        assert_eq!(ids.iter().collect::<HashSet<_>>().len(), 3);
        assert!(end_of(&conn, &ids[0]) < end_of(&conn, &ids[1]));
        assert!(end_of(&conn, &ids[1]) < end_of(&conn, &ids[2]));
        // A full window prepares nothing more; one batch at a time neither.
        let full = prepare_batch_from(&conn, &store, &job_id, 0, 3, none).unwrap();
        assert_eq!(full.batch_id.as_ref(), Some(&ids[0]));
        assert_eq!(full.scanned_records, 0);
        assert_eq!(
            prepare_batch(&conn, &job_id, 0).unwrap().batch_id.as_ref(),
            Some(&ids[0])
        );

        let clock = || 1_000;
        let first = claim_batch(&conn, &job_id, "worker", 30_000, &clock)
            .unwrap()
            .unwrap();
        let second = claimed(claim_next(&conn, &first.lease, &clock).unwrap());
        let third = claimed(claim_next(&conn, &first.lease, &clock).unwrap());
        assert_eq!(
            [&first, &second, &third].map(|claim| claim.batch.batch_id.clone()),
            [ids[0].clone(), ids[1].clone(), ids[2].clone()]
        );
        assert_eq!(second.lease.fence, first.lease.fence);
        assert!(matches!(
            claim_next(&conn, &first.lease, &clock).unwrap(),
            NextClaim::Empty
        ));
        for claim in [&first, &second, &third] {
            persisted(&conn, claim, &clock);
        }

        // The later batches are acknowledged first.
        assert!(
            settle(&conn, &third.lease, &accepted(&third), &clock)
                .unwrap()
                .complete
        );
        assert!(
            settle(&conn, &second.lease, &accepted(&second), &clock)
                .unwrap()
                .complete
        );
        assert_eq!(status(&conn, &job_id).unwrap().acknowledged_cursor, 0);
        assert_eq!(holder(&conn, &job_id).as_deref(), Some("worker"));
        // The oldest fails: its failure releases the lease, as the last of
        // the window, and holds the acknowledged position back.
        record_failure(
            &conn,
            &first.lease,
            DeliveryFailure::Transient,
            None,
            &clock,
        )
        .unwrap();
        let failed = status(&conn, &job_id).unwrap();
        assert_eq!(failed.state, "active");
        assert_eq!(failed.failure.as_deref(), Some("transient"));
        assert!(failed.next_attempt_ms > 1_000);
        assert_eq!(failed.acknowledged_cursor, 0);
        assert_eq!(failed.acknowledged_records, 4);
        assert_eq!(failed.pending_records, 2);
        assert_eq!(holder(&conn, &job_id), None);
        // Compaction keeps the receipts the position still has to pass.
        while compact_receipts(&conn, 10).unwrap() == 10 {}
        let kept: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM delivery_batches WHERE job_id=? AND state='acknowledged'",
                [&job_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(kept, 2);

        // Only the failed batch is attempted again, once its deadline passed.
        let later = move || failed.next_attempt_ms;
        let retried = claim_batch(&conn, &job_id, "worker", 30_000, &later)
            .unwrap()
            .unwrap();
        assert_eq!(retried.batch.batch_id, ids[0]);
        assert!(retried.prepared.is_some());
        assert!(matches!(
            claim_next(&conn, &retried.lease, &later).unwrap(),
            NextClaim::Empty
        ));
        assert!(
            settle(&conn, &retried.lease, &accepted(&retried), &later)
                .unwrap()
                .complete
        );
        let caught_up = status(&conn, &job_id).unwrap();
        assert_eq!(caught_up.acknowledged_cursor, end_of(&conn, &ids[2]));
        assert_eq!(caught_up.acknowledged_records, 6);
        assert_eq!(caught_up.failure, None);
        assert_eq!(caught_up.next_attempt_ms, 0);
        while compact_receipts(&conn, 10).unwrap() == 10 {}
        let left: i64 = conn
            .query_row("SELECT COUNT(*) FROM delivery_batches", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 0);
    }

    /// A failure inside a window stops further claims until its retry
    /// deadline, and a sibling's acknowledgment keeps that failure's backoff;
    /// a sibling that blocks the job leaves the others' outcomes recordable
    /// and the block standing.
    #[test]
    fn a_failure_in_a_window_stops_claims_and_survives_its_siblings() {
        let (_directory, conn, job_id) = windowed_job(6);
        let store = feed::store(&conn).unwrap();
        for _ in 0..3 {
            prepare_batch_from(&conn, &store, &job_id, 0, 3, PublishedLimits::default()).unwrap();
        }
        let clock = || 1_000;
        let first = claim_batch(&conn, &job_id, "worker", 30_000, &clock)
            .unwrap()
            .unwrap();
        let second = claimed(claim_next(&conn, &first.lease, &clock).unwrap());
        for claim in [&first, &second] {
            persisted(&conn, claim, &clock);
        }
        record_failure(
            &conn,
            &first.lease,
            DeliveryFailure::RateLimited,
            Some(90_000),
            &clock,
        )
        .unwrap();
        assert!(matches!(
            claim_next(&conn, &first.lease, &clock).unwrap(),
            NextClaim::Lost
        ));
        assert!(
            settle(&conn, &second.lease, &accepted(&second), &clock)
                .unwrap()
                .complete
        );
        let waiting = status(&conn, &job_id).unwrap();
        assert_eq!(waiting.failure.as_deref(), Some("rate_limited"));
        assert_eq!(waiting.next_attempt_ms, 90_000);
        assert_eq!(waiting.acknowledged_cursor, 0);
        assert_eq!(holder(&conn, &job_id), None);

        // A blocking verdict: the sibling sent alongside it is still
        // acknowledged, and the job stays blocked under that verdict.
        let later = || 90_000;
        let retried = claim_batch(&conn, &job_id, "worker", 30_000, &later)
            .unwrap()
            .unwrap();
        let sibling = claimed(claim_next(&conn, &retried.lease, &later).unwrap());
        persisted(&conn, &sibling, &later);
        record_failure(
            &conn,
            &retried.lease,
            DeliveryFailure::PermissionDenied,
            None,
            &later,
        )
        .unwrap();
        record_failure(
            &conn,
            &sibling.lease,
            DeliveryFailure::Transient,
            None,
            &later,
        )
        .unwrap();
        let blocked = status(&conn, &job_id).unwrap();
        assert_eq!(blocked.state, "blocked");
        assert_eq!(blocked.failure.as_deref(), Some("permission_denied"));
        assert_eq!(holder(&conn, &job_id), None);

        retry_job(&conn, &job_id).unwrap();
        let again = || 200_000;
        let first = claim_batch(&conn, &job_id, "worker", 30_000, &again)
            .unwrap()
            .unwrap();
        let second = claimed(claim_next(&conn, &first.lease, &again).unwrap());
        persisted(&conn, &second, &again);
        record_failure(
            &conn,
            &first.lease,
            DeliveryFailure::PermissionDenied,
            None,
            &again,
        )
        .unwrap();
        assert!(
            settle(&conn, &second.lease, &accepted(&second), &again)
                .unwrap()
                .complete
        );
        let blocked = status(&conn, &job_id).unwrap();
        assert_eq!(blocked.state, "blocked");
        assert_eq!(blocked.failure.as_deref(), Some("permission_denied"));
        assert_eq!(blocked.acknowledged_records, 4);
        assert_eq!(holder(&conn, &job_id), None);
    }

    /// A stop releases each claim of a window; the last one releases the
    /// lease and undoes the window's attempt, so the job resumes at once.
    #[test]
    fn a_stopped_window_releases_its_lease_with_its_last_claim() {
        let (_directory, conn, job_id) = windowed_job(4);
        let store = feed::store(&conn).unwrap();
        for _ in 0..2 {
            prepare_batch_from(&conn, &store, &job_id, 0, 2, PublishedLimits::default()).unwrap();
        }
        let clock = || 1_000;
        let first = claim_batch(&conn, &job_id, "worker", 30_000, &clock)
            .unwrap()
            .unwrap();
        let second = claimed(claim_next(&conn, &first.lease, &clock).unwrap());
        release_stopped_claim(&conn, &first.lease, &clock).unwrap();
        assert_eq!(holder(&conn, &job_id).as_deref(), Some("worker"));
        release_stopped_claim(&conn, &second.lease, &clock).unwrap();
        assert_eq!(holder(&conn, &job_id), None);
        let attempts: i64 = conn
            .query_row(
                "SELECT attempts FROM delivery_jobs WHERE id=?",
                [&job_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(attempts, 0);
        // Both are pending again and the next window claims them in order.
        let resumed = claim_batch(&conn, &job_id, "worker", 30_000, &clock)
            .unwrap()
            .unwrap();
        assert_eq!(resumed.batch.batch_id, first.batch.batch_id);
    }

    /// Batches a crashed window left leased are pending again when the next
    /// window opens, oldest first.
    #[test]
    fn a_new_window_reclaims_batches_an_ended_one_left_leased() {
        let (_directory, conn, job_id) = windowed_job(6);
        let store = feed::store(&conn).unwrap();
        for _ in 0..3 {
            prepare_batch_from(&conn, &store, &job_id, 0, 3, PublishedLimits::default()).unwrap();
        }
        let clock = || 1_000;
        let first = claim_batch(&conn, &job_id, "crashed", 30_000, &clock)
            .unwrap()
            .unwrap();
        let second = claimed(claim_next(&conn, &first.lease, &clock).unwrap());
        // The lease runs out with both still leased.
        let expired = || 40_000;
        let reopened = claim_batch(&conn, &job_id, "worker", 30_000, &expired)
            .unwrap()
            .unwrap();
        assert_eq!(reopened.batch.batch_id, first.batch.batch_id);
        let next = claimed(claim_next(&conn, &reopened.lease, &expired).unwrap());
        assert_eq!(next.batch.batch_id, second.batch.batch_id);
        // The ended window's leases are fenced.
        assert!(settle(&conn, &second.lease, &accepted(&second), &expired).is_err());
    }

    /// Published limits replace the protocol's record cap up to the local
    /// ceiling, never raise a cap a job chose itself, and only ever lower
    /// the byte cap; with nothing published the limits stand.
    #[test]
    fn published_limits_adjust_only_what_they_may() {
        let defaults = DeliveryLimits::default();
        assert_eq!(
            defaults.clone().with_published(PublishedLimits::default()),
            defaults
        );
        let records = |max_records| {
            defaults
                .clone()
                .with_published(PublishedLimits {
                    max_records: Some(max_records),
                    max_request_bytes: None,
                })
                .max_batch_records
        };
        assert_eq!(records(500), 500);
        // The scan budget grows with a raised cap, so the cap can be filled,
        // and never shrinks below the configured one.
        let scan = |max_records| {
            defaults
                .clone()
                .with_published(PublishedLimits {
                    max_records: Some(max_records),
                    max_request_bytes: None,
                })
                .max_scan_records
        };
        assert_eq!(scan(500), 2_000);
        assert_eq!(scan(250), 1_000);
        assert_eq!(scan(50), defaults.max_scan_records);
        assert_eq!(records(250), 250);
        assert_eq!(records(10_000), MAX_PUBLISHED_BATCH_RECORDS);
        assert_eq!(records(50), 50);
        assert_eq!(records(0), 1);
        let chosen = DeliveryLimits {
            max_batch_records: 20,
            ..defaults.clone()
        };
        let published = PublishedLimits {
            max_records: Some(500),
            max_request_bytes: Some(4 * 2_097_152),
        };
        assert_eq!(
            chosen.clone().with_published(published).max_batch_records,
            20
        );
        assert_eq!(
            chosen.with_published(published).max_batch_bytes,
            defaults.max_batch_bytes
        );
        let smaller = defaults.clone().with_published(PublishedLimits {
            max_records: None,
            max_request_bytes: Some(1_048_576),
        });
        assert_eq!(smaller.max_batch_bytes, 1_048_576 - 65_536);
        assert_eq!(smaller.max_batch_records, defaults.max_batch_records);
    }

    /// The oldest batch of a window fails window after window while its
    /// siblings are acknowledged: their acknowledgments, which arrive while
    /// it is still in flight, leave its attempts alone, so each failure backs
    /// off further. Its own acknowledgment then clears the backoff.
    #[test]
    fn a_failing_oldest_batch_backs_off_further_while_its_siblings_are_acknowledged() {
        let (_directory, conn, job_id) = windowed_job(10);
        let store = feed::store(&conn).unwrap();
        let attempts = || -> i64 {
            conn.query_row(
                "SELECT attempts FROM delivery_jobs WHERE id=?",
                [&job_id],
                |r| r.get(0),
            )
            .unwrap()
        };
        let mut now = 1_000;
        let mut delays = Vec::new();
        for round in 1..=2 {
            while prepare_batch_from(&conn, &store, &job_id, now, 3, PublishedLimits::default())
                .unwrap()
                .scanned_records
                > 0
            {}
            let clock = move || now;
            let oldest = claim_batch(&conn, &job_id, "worker", 30_000, &clock)
                .unwrap()
                .unwrap();
            let first = claimed(claim_next(&conn, &oldest.lease, &clock).unwrap());
            let second = claimed(claim_next(&conn, &oldest.lease, &clock).unwrap());
            for claim in [&oldest, &first, &second] {
                if claim.prepared.is_none() {
                    persisted(&conn, claim, &clock);
                }
            }
            assert!(
                settle(&conn, &first.lease, &accepted(&first), &clock)
                    .unwrap()
                    .complete
            );
            assert!(
                settle(&conn, &second.lease, &accepted(&second), &clock)
                    .unwrap()
                    .complete
            );
            assert_eq!(attempts(), round);
            record_failure(
                &conn,
                &oldest.lease,
                DeliveryFailure::Transient,
                None,
                &clock,
            )
            .unwrap();
            assert_eq!(attempts(), round);
            let waiting = status(&conn, &job_id).unwrap();
            assert_eq!(waiting.failure.as_deref(), Some("transient"));
            delays.push(waiting.next_attempt_ms - now);
            now = waiting.next_attempt_ms;
        }
        // 1 s doubled per attempt, plus up to a fifth of jitter.
        assert!((2_000..=2_400).contains(&delays[0]), "{delays:?}");
        assert!((4_000..=4_800).contains(&delays[1]), "{delays:?}");

        let clock = move || now;
        let oldest = claim_batch(&conn, &job_id, "worker", 30_000, &clock)
            .unwrap()
            .unwrap();
        assert_eq!(attempts(), 3);
        assert!(
            settle(&conn, &oldest.lease, &accepted(&oldest), &clock)
                .unwrap()
                .complete
        );
        let recovered = status(&conn, &job_id).unwrap();
        assert_eq!(attempts(), 0);
        assert_eq!(recovered.failure, None);
        assert_eq!(recovered.next_attempt_ms, 0);
        assert_eq!(recovered.acknowledged_records, 10);
        assert_eq!(recovered.acknowledged_cursor, recovered.journal_cursor);
    }

    /// With a published limit of 500 records and enough eligible changes, a
    /// default job prepares a full 500-record batch: the scan budget does not
    /// stop it at the default 400 changes.
    #[test]
    fn a_published_record_limit_fills_a_full_batch() {
        let (_directory, conn, job_id) = job_with(600, DeliveryLimits::default());
        let store = feed::store(&conn).unwrap();
        let published = PublishedLimits {
            max_records: Some(500),
            max_request_bytes: None,
        };
        let batch_id = prepare_batch_from(&conn, &store, &job_id, 0, 1, published)
            .unwrap()
            .batch_id
            .unwrap();
        let records: i64 = conn
            .query_row(
                "SELECT records FROM delivery_batches WHERE id=?",
                [&batch_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(records, 500);
    }

    /// A session job over `sessions`, each a member with `events` session
    /// events of its own, selecting `kinds`, with batches of two records.
    fn windowed_session_job(
        sessions: &[&str],
        events: usize,
        kinds: &[&str],
    ) -> (tempfile::TempDir, Connection, String) {
        let directory = tempfile::tempdir().unwrap();
        let conn = open_db(&directory.path().join("history.db")).unwrap();
        for session in sessions {
            for n in 0..events {
                conn.execute("INSERT INTO session_events(source,session_id,event_uid,ts_ms,role,kind,text) VALUES ('claude',?1,?2,42,'user','text','window')", params![session, format!("{session}-{n}")]).unwrap();
            }
        }
        let config = DeliveryJobConfig {
            destination_id: "fixture".into(),
            instance_id: "window".into(),
            account_id: "fixture-account".into(),
            mapping_version: "1".into(),
            selection: ExportSelection {
                all_sources: true,
                kinds: kinds.iter().map(|kind| (*kind).into()).collect(),
                ..ExportSelection::default()
            },
            limits: DeliveryLimits {
                max_batch_records: 2,
                ..DeliveryLimits::default()
            },
        };
        let job = create_session_job(&conn, &config, 0).unwrap().job_id;
        for session in sessions {
            set_job_session(&conn, &job, &member(session), true).unwrap();
        }
        (directory, conn, job)
    }
    fn member(session: &str) -> SessionIdentity {
        SessionIdentity {
            source: "claude".into(),
            session_id: session.into(),
        }
    }
    /// The records of every batch the job holds unresolved.
    fn unresolved_records(conn: &Connection, job_id: &str) -> Vec<HistoryExportRecord> {
        conn.prepare(&format!("SELECT payload FROM delivery_batches WHERE job_id=? AND state IN {UNRESOLVED} ORDER BY journal_end,seq"))
            .unwrap()
            .query_map([job_id], |r| r.get::<_, String>(0))
            .unwrap()
            .flat_map(|payload| {
                serde_json::from_str::<HistoryExportBatch>(&payload.unwrap())
                    .unwrap()
                    .records
            })
            .collect()
    }

    /// A session job's backfill fills a window of batches that all end at the
    /// job's feed position. They are claimed in preparation order; the
    /// acknowledged position passes their shared end only once every one of
    /// them resolved, and an acknowledgment while an earlier one is still in
    /// flight keeps the job's retry count.
    #[test]
    fn a_session_window_shares_its_feed_end_and_resolves_in_claim_order() {
        let (_directory, conn, job_id) = windowed_session_job(&["session"], 6, &["session_event"]);
        let store = feed::store(&conn).unwrap();
        let none = PublishedLimits::default();
        let ids: Vec<String> = (0..3)
            .map(|_| {
                prepare_batch_from(&conn, &store, &job_id, 0, 3, none)
                    .unwrap()
                    .batch_id
                    .unwrap()
            })
            .collect();
        assert_eq!(ids.iter().collect::<HashSet<_>>().len(), 3);
        let end = end_of(&conn, &ids[0]);
        assert!(ids.iter().all(|id| end_of(&conn, id) == end));
        // A full window prepares nothing more and names its oldest batch.
        let full = prepare_batch_from(&conn, &store, &job_id, 0, 3, none).unwrap();
        assert_eq!(full.batch_id.as_ref(), Some(&ids[0]));
        assert_eq!(full.scanned_records, 0);

        let clock = || 1_000;
        let first = claim_batch(&conn, &job_id, "worker", 30_000, &clock)
            .unwrap()
            .unwrap();
        let second = claimed(claim_next(&conn, &first.lease, &clock).unwrap());
        let third = claimed(claim_next(&conn, &first.lease, &clock).unwrap());
        let order: Vec<&String> = [&first, &second, &third]
            .iter()
            .map(|claim| &claim.batch.batch_id)
            .collect();
        assert_eq!(order, ids.iter().collect::<Vec<_>>());
        for claim in [&first, &second, &third] {
            persisted(&conn, claim, &clock);
        }
        // The second is acknowledged while the first is in flight: the
        // first may still fail, so the window's attempt stands, and the
        // position stays before the end they share.
        assert!(
            settle(&conn, &second.lease, &accepted(&second), &clock)
                .unwrap()
                .complete
        );
        let waiting = status(&conn, &job_id).unwrap();
        assert_eq!(waiting.attempts, 1);
        assert_eq!(waiting.acknowledged_cursor, 0);
        record_failure(
            &conn,
            &first.lease,
            DeliveryFailure::Transient,
            None,
            &clock,
        )
        .unwrap();
        assert!(
            settle(&conn, &third.lease, &accepted(&third), &clock)
                .unwrap()
                .complete
        );
        let failed = status(&conn, &job_id).unwrap();
        assert_eq!(failed.failure.as_deref(), Some("transient"));
        assert_eq!(failed.attempts, 1);
        assert_eq!(failed.acknowledged_cursor, 0);
        // Receipts ending where the failed batch ends may go: it carries
        // that end itself.
        compact_receipts(&conn, 100).unwrap();

        // The retry claims the failed batch alone; once it is acknowledged
        // the position reaches the shared end.
        let later = || failed.next_attempt_ms;
        let retried = claim_batch(&conn, &job_id, "worker", 30_000, &later)
            .unwrap()
            .unwrap();
        assert_eq!(retried.batch.batch_id, ids[0]);
        assert!(matches!(
            claim_next(&conn, &retried.lease, &later).unwrap(),
            NextClaim::Empty
        ));
        assert!(
            settle(&conn, &retried.lease, &accepted(&retried), &later)
                .unwrap()
                .complete
        );
        let caught_up = status(&conn, &job_id).unwrap();
        assert_eq!(caught_up.failure, None);
        assert_eq!(caught_up.attempts, 0);
        assert_eq!(caught_up.acknowledged_cursor, end);
        assert_eq!(caught_up.acknowledged_records, 6);
    }

    /// Under one membership each change has one path that sends it, so a
    /// window of backfill batches never repeats a change: an edge between
    /// two members, which both their backfills reach, is in exactly one
    /// batch.
    #[test]
    fn a_session_window_holds_each_change_once() {
        let (_directory, conn, job_id) =
            windowed_session_job(&["parent", "child"], 5, &["session_event", "relationship"]);
        // Edges written before both members were added: the child's
        // backfill owns them.
        let tx = conn.unchecked_transaction().unwrap();
        tx.execute("DELETE FROM delivery_session_members", [])
            .unwrap();
        for n in 0..5 {
            tx.execute("INSERT INTO session_relationships(source,parent_session_id,relationship_uid,child_session_id,relationship,identity_status,evidence_kind,created_ms,updated_ms) VALUES('claude','parent',?1,'child','delegation','observed','fixture',1,1)", [format!("edge-{n}")]).unwrap();
        }
        tx.commit().unwrap();
        set_job_session(&conn, &job_id, &member("parent"), true).unwrap();
        set_job_session(&conn, &job_id, &member("child"), true).unwrap();
        let store = feed::store(&conn).unwrap();
        loop {
            let prepared = prepare_batch_from(
                &conn,
                &store,
                &job_id,
                0,
                worker::MAX_IN_FLIGHT,
                PublishedLimits::default(),
            )
            .unwrap();
            if prepared.batch_id.is_none() && prepared.bootstrap_complete {
                break;
            }
        }
        let records = unresolved_records(&conn, &job_id);
        let revisions: HashSet<&String> =
            records.iter().map(|record| &record.revision_id).collect();
        assert_eq!(revisions.len(), records.len());
        assert_eq!(
            records
                .iter()
                .filter(|record| record.kind == "relationship")
                .count(),
            5
        );
        assert_eq!(records.len(), 15);
        let batches: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM delivery_batches WHERE job_id=?",
                [&job_id],
                |r| r.get(0),
            )
            .unwrap();
        assert!(batches >= 8, "{batches}");
    }

    /// A membership change while batches are unresolved restarts a
    /// member's backfill under the new membership. Until the batches
    /// prepared before the change resolve, the new backfill skips every
    /// revision they hold; batches prepared since are never read, and the
    /// change is forgotten once the earlier batches resolve, whatever is
    /// still unresolved after them.
    #[test]
    fn a_membership_change_skips_what_unresolved_batches_hold() {
        let (_directory, conn, job_id) = windowed_session_job(&["session"], 6, &["session_event"]);
        let store = feed::store(&conn).unwrap();
        let none = PublishedLimits::default();
        let first = prepare_batch_from(&conn, &store, &job_id, 0, 4, none)
            .unwrap()
            .batch_id
            .unwrap();
        let changed = |conn: &Connection| -> i64 {
            conn.query_row(
                "SELECT membership_seq FROM delivery_session_jobs WHERE job_id=?",
                [&job_id],
                |r| r.get(0),
            )
            .unwrap()
        };
        let seq_of = |id: &str| -> i64 {
            conn.query_row("SELECT seq FROM delivery_batches WHERE id=?", [id], |r| {
                r.get(0)
            })
            .unwrap()
        };
        assert_eq!(changed(&conn), 0);
        set_job_session(&conn, &job_id, &member("session"), false).unwrap();
        set_job_session(&conn, &job_id, &member("session"), true).unwrap();
        assert_eq!(changed(&conn), seq_of(&first));
        for _ in 0..2 {
            prepare_batch_from(&conn, &store, &job_id, 0, 4, none)
                .unwrap()
                .batch_id
                .unwrap();
        }
        let records = unresolved_records(&conn, &job_id);
        let events: Vec<&str> = records
            .iter()
            .map(|record| record.payload["event_uid"].as_str().unwrap())
            .collect();
        assert_eq!(
            events,
            [
                "session-0",
                "session-1",
                "session-2",
                "session-3",
                "session-4",
                "session-5"
            ]
        );
        assert!(prepare_batch_from(&conn, &store, &job_id, 0, 4, none)
            .unwrap()
            .batch_id
            .is_none());

        // The batch prepared before the change resolves: the change is
        // forgotten while the two prepared after it are still unresolved.
        let clock = || 1_000;
        let claim = claim_batch(&conn, &job_id, "worker", 30_000, &clock)
            .unwrap()
            .unwrap();
        assert_eq!(claim.batch.batch_id, first);
        persisted(&conn, &claim, &clock);
        settle(&conn, &claim.lease, &accepted(&claim), &clock).unwrap();
        prepare_batch_from(&conn, &store, &job_id, 0, 4, none).unwrap();
        assert_eq!(changed(&conn), 0);
        assert_eq!(unresolved_records(&conn, &job_id).len(), 4);
    }

    /// A batch narrowed at claim takes the place in claim order of the batch
    /// it replaces, so acknowledging a sibling claimed after it keeps the
    /// job's backoff while the narrowed batch is still in flight.
    #[test]
    fn a_narrowed_batch_keeps_its_place_in_claim_order() {
        let sessions = ["s0", "s1", "s2", "s3", "s4", "s5"];
        let (_directory, conn, job_id) = windowed_session_job(&sessions, 1, &["session_event"]);
        let store = feed::store(&conn).unwrap();
        let none = PublishedLimits::default();
        for _ in 0..3 {
            prepare_batch_from(&conn, &store, &job_id, 0, 3, none)
                .unwrap()
                .batch_id
                .unwrap();
        }
        let clock = || 1_000;
        let first = claim_batch(&conn, &job_id, "worker", 30_000, &clock)
            .unwrap()
            .unwrap();
        assert_eq!(first.batch.records.len(), 2);
        persisted(&conn, &first, &clock);
        record_failure(
            &conn,
            &first.lease,
            DeliveryFailure::Transient,
            None,
            &clock,
        )
        .unwrap();
        let failed = status(&conn, &job_id).unwrap();
        assert_eq!(failed.attempts, 1);
        // One of the failed batch's members leaves, so its retry is narrowed.
        let leaving = first.batch.records[0].session_id.clone().unwrap();
        set_job_session(&conn, &job_id, &member(&leaving), false).unwrap();

        let later = || failed.next_attempt_ms;
        let narrowed = claim_batch(&conn, &job_id, "worker", 30_000, &later)
            .unwrap()
            .unwrap();
        assert_ne!(narrowed.batch.batch_id, first.batch.batch_id);
        assert_eq!(narrowed.batch.records.len(), 1);
        let sibling = claimed(claim_next(&conn, &narrowed.lease, &later).unwrap());
        for claim in [&narrowed, &sibling] {
            persisted(&conn, claim, &later);
        }
        assert!(
            settle(&conn, &sibling.lease, &accepted(&sibling), &later)
                .unwrap()
                .complete
        );
        let waiting = status(&conn, &job_id).unwrap();
        assert_eq!(waiting.attempts, 2);
        assert_eq!(waiting.failure.as_deref(), Some("transient"));
        assert!(
            settle(&conn, &narrowed.lease, &accepted(&narrowed), &later)
                .unwrap()
                .complete
        );
        let recovered = status(&conn, &job_id).unwrap();
        assert_eq!(recovered.attempts, 0);
        assert_eq!(recovered.failure, None);
    }
}
