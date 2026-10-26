//! The single generic delivery worker: one bounded drain loop, implemented once.
//!
//! Every host (Node through NAPI, the CLI, a plugin, the probe) supplies only a
//! [`Receiver`] — a destination mapping and transport — and this module owns the
//! durable protocol: round-robin over jobs, claimed batches (one at a time, or
//! a bounded window of them for a receiver that sends concurrently), payload
//! persistence before transport, an eligibility recheck immediately before the
//! send, lease keepalive while a receiver runs, and acknowledgment or a
//! classified failure afterwards. No network, credential or environment access
//! happens here; receivers never see this module's database connections.
//!
//! A drain is bounded: it attempts at most `max_batches` batches, starts no
//! further step once `max_elapsed` has passed, never waits for a retry deadline
//! and never enables, pauses or resumes a job. Delivery stays at least once, so
//! receivers must remain idempotent per revision.
//!
//! The core cannot forcibly interrupt a receiver: Rust has no way to cancel a
//! synchronous call. [`ReceiverContext::timeout_ms`] is the deadline a receiver
//! is required to honour itself (socket/read timeouts), and
//! [`ReceiverContext::cancelled`] reports a host stop request or a lost lease so
//! a long-running receiver can abandon its work early. A receiver that ignores
//! both merely delays this drain; its result is still discarded when the lease
//! was lost, and nothing is acknowledged.

mod session;
pub use session::DrainSession;

use super::{
    claim_batch, claim_next, compact_receipts, job_ids, prepare_batch_from, record_failure,
    recover_conflict_classified, release_stopped_claim, renew_lease, renew_window, settle, status,
    store_payload, validate_dispatch, ClaimedBatch, ConflictRecovery, ConflictRecoveryError,
    DeliveryAcknowledgment, DeliveryFailure, DeliveryJobConfig, DeliveryLease, DeliveryStatus,
    HistoryExportBatch, NextClaim, PreparedPayload, PublishedLimits, RetainedPayload, Settled,
    THIS_BUILD,
};
use anyhow::{anyhow, bail, Context, Result};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::cell::Cell;
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Receiver-classified failure. `retry_after_ms` is an absolute epoch-ms retry
/// time, exactly as `record_failure` interprets its own `retry_after_ms`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReceiverFailure {
    pub failure: DeliveryFailure,
    pub retry_after_ms: Option<i64>,
    pub recovery: Option<ConflictRecovery>,
}
impl From<DeliveryFailure> for ReceiverFailure {
    fn from(failure: DeliveryFailure) -> Self {
        Self {
            failure,
            retry_after_ms: None,
            recovery: None,
        }
    }
}

/// The destination body a receiver maps a batch into, without credentials.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedBody {
    pub content_type: String,
    pub body: String,
}

/// Passed to [`Receiver::published_limits`]: what asking the destination for
/// its limits may spend, the drain's stop signal and per-request deadline, as
/// for a send.
pub struct LimitsContext<'a> {
    pub cancelled: &'a dyn Fn() -> bool,
    pub timeout_ms: i64,
}

/// Passed to receiver calls. `cancelled()` becomes true when the host asked the
/// drain to stop or the lease was lost; `timeout_ms` is the per-call deadline
/// the receiver is expected to honour itself.
pub struct ReceiverContext<'a> {
    pub cancelled: &'a dyn Fn() -> bool,
    pub timeout_ms: i64,
    /// The claimed batch id: stable across redelivery of the same bytes.
    pub idempotency_key: &'a str,
    /// Durable progress from earlier attempts to isolate this same immutable
    /// batch. Receivers that do not isolate may ignore these lists.
    pub accepted_revision_ids: &'a [String],
    pub suppressed_revision_ids: &'a [String],
    pub rejected_revision_ids: &'a [String],
    pub isolation_frontier: &'a [super::IsolationTask],
}

/// One destination implementation. Trusted application code, not a sandbox.
pub trait Receiver {
    fn mapping_version(&self) -> &str;
    fn supported_kinds(&self) -> &[&str];
    fn supports_tombstones(&self) -> bool;
    /// Pure payload mapping; never include credentials in the body.
    fn prepare(
        &self,
        batch: &HistoryExportBatch,
        ctx: &ReceiverContext<'_>,
    ) -> Result<PreparedBody, ReceiverFailure>;
    /// Send exactly the stored bytes. Must verify the remote account matches
    /// `batch.account_id`. Never launch an interactive login: report
    /// `AuthenticationRequired` instead. `payload.prepared_by` is
    /// [`super::THIS_BUILD`] when the stored body is what this build's
    /// `prepare` returned.
    fn send(
        &self,
        payload: &PreparedPayload,
        batch: &HistoryExportBatch,
        ctx: &ReceiverContext<'_>,
    ) -> Result<DeliveryAcknowledgment, ReceiverFailure>;
    /// This receiver as one that may `prepare` and `send` from several
    /// threads at once. When it is, and [`DrainOptions::max_in_flight`]
    /// allows, the worker keeps up to that many batches of an all-sources job
    /// in flight, each mapped and sent on a sender thread; `None`, the
    /// default, prepares and sends one batch at a time on the draining
    /// thread.
    fn concurrent(&self) -> Option<&(dyn Receiver + Sync)> {
        None
    }
    /// The batch limits the destination last published, which size the
    /// batches prepared next (see [`DeliveryLimits::with_published`]). None
    /// by default, which keeps each job's configured limits.
    ///
    /// A receiver that asks the destination for them stays within `ctx`.
    ///
    /// [`DeliveryLimits::with_published`]: super::DeliveryLimits::with_published
    fn published_limits(&self, _ctx: &LimitsContext<'_>) -> PublishedLimits {
        PublishedLimits::default()
    }
}

/// Lookup of receivers by the job configuration's destination and instance ids.
pub trait Receivers {
    fn receiver(&self, destination_id: &str, instance_id: &str) -> Option<&dyn Receiver>;
}

impl Receivers for HashMap<(String, String), Box<dyn Receiver>> {
    fn receiver(&self, destination_id: &str, instance_id: &str) -> Option<&dyn Receiver> {
        self.get(&(destination_id.to_owned(), instance_id.to_owned()))
            .map(|receiver| receiver.as_ref())
    }
}

/// A single registered receiver, for hosts that deliver to one destination.
pub struct SingleReceiver<'a> {
    pub destination_id: String,
    pub instance_id: String,
    pub receiver: &'a dyn Receiver,
}
impl<'a> SingleReceiver<'a> {
    pub fn new(
        destination_id: impl Into<String>,
        instance_id: impl Into<String>,
        receiver: &'a dyn Receiver,
    ) -> Self {
        Self {
            destination_id: destination_id.into(),
            instance_id: instance_id.into(),
            receiver,
        }
    }
}
impl Receivers for SingleReceiver<'_> {
    fn receiver(&self, destination_id: &str, instance_id: &str) -> Option<&dyn Receiver> {
        (self.destination_id == destination_id && self.instance_id == instance_id)
            .then_some(self.receiver)
    }
}

#[derive(Debug, Clone)]
pub struct DrainOptions {
    /// `None` drains every job; an unknown id is an invalid argument.
    pub job_ids: Option<Vec<String>>,
    pub worker_id: String,
    pub max_batches: usize,
    pub max_prepare_steps: usize,
    /// Wall-clock budget for the drain's delivery work, measured from the end
    /// of its own maintenance. Once it passes no further prepare step or
    /// attempt starts, and an attempt already under way runs to its receiver's
    /// own timeout. The budget bounds how long a drain keeps going, not whether
    /// it goes at all: its first step, and the first attempt that step
    /// prepares, always run, so however short the budget the queue still moves.
    /// `None` bounds the drain by counts alone.
    pub max_elapsed: Option<Duration>,
    pub lease_ms: i64,
    pub request_timeout_ms: i64,
    /// An optional absolute ceiling shared by every request this drain starts.
    /// Unlike `max_elapsed`, this is measured from the caller's clock before
    /// maintenance begins and is recomputed immediately before each send.
    pub request_deadline: Option<Instant>,
    /// The most batches of one job prepared, claimed and in flight at once,
    /// at most [`MAX_IN_FLIGHT`]. Beyond one, batches are sent from that many
    /// threads while the next is prepared, to a receiver that offers
    /// [`Receiver::concurrent`]. The default, 1, delivers one batch at a
    /// time.
    pub max_in_flight: usize,
}
impl DrainOptions {
    pub fn new(worker_id: impl Into<String>) -> Self {
        Self {
            job_ids: None,
            worker_id: worker_id.into(),
            max_batches: 100,
            max_prepare_steps: 100,
            max_elapsed: None,
            lease_ms: 30_000,
            request_timeout_ms: 30_000,
            request_deadline: None,
            max_in_flight: 1,
        }
    }
}

fn request_timeout_ms(configured: i64, deadline: Option<Instant>) -> i64 {
    let Some(deadline) = deadline else {
        return configured;
    };
    let remaining = deadline.saturating_duration_since(Instant::now());
    let remaining_ms = i64::try_from(remaining.as_millis()).unwrap_or(i64::MAX);
    configured.min(remaining_ms.max(1))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DrainIssueCode {
    DestinationNotRegistered,
    DeliveryStateFailed,
    /// A batch could not be prepared from local history. Unlike a failure
    /// SQLite reports, retrying soon will not help.
    PreparationFailed,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DrainIssue {
    pub job_id: String,
    pub code: DrainIssueCode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DrainResult {
    pub attempts: usize,
    pub statuses: Vec<DeliveryStatus>,
    pub issues: Vec<DrainIssue>,
    /// The first local error behind an issue, whole, so the host can report
    /// its cause (a locked, full or damaged store) and not only the issue.
    #[serde(skip)]
    pub failure: Option<LocalFailure>,
    /// What the drain moved and how long it took.
    #[serde(skip)]
    pub metrics: DrainMetrics,
}

/// Content-free measurements of one drain: counts, bytes and durations,
/// never record content, identifiers or paths.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DrainMetrics {
    /// Wall time of the whole drain, its maintenance included.
    pub elapsed_ms: u64,
    /// Batches handed to a receiver's `send`, whatever came of them.
    pub batches_sent: u64,
    /// Request bytes of those batches, as persisted.
    pub bytes_sent: u64,
    /// Time inside `send`, summed over the drain and for its slowest batch.
    pub send_ms_total: u64,
    pub send_ms_max: u64,
    /// Batches the drain finished: every revision accounted for, so the
    /// batch left the queue.
    pub batches_acknowledged: u64,
    /// Records the receiver accepted in those batches.
    pub records_acknowledged: u64,
    /// The longest a finished batch waited, from its preparation to its
    /// acknowledgment.
    pub queue_ms_max: u64,
    /// How long before its acknowledgment the newest record the drain
    /// delivered was written, by the record's own event time (`ts_ms` or
    /// `timestamp_ms`): end-to-end lag once the job keeps up, and the age of
    /// the history it reached during a backfill. `None` when no delivered
    /// record carries an event time.
    pub event_lag_ms: Option<u64>,
    /// The most batches of one job the drain had claimed and not yet
    /// recorded at once: 1 for a drain that delivers one at a time.
    pub max_in_flight: u64,
    /// Batches claimed again after an earlier attempt that did not
    /// acknowledge them: a retry after a failure, or a resumption after a
    /// stop or a lost lease.
    pub batches_retried: u64,
}
impl DrainMetrics {
    /// Fold another drain's measurements into these: sums add, maxima and
    /// the freshest lag are kept.
    pub fn add(&mut self, other: &DrainMetrics) {
        self.elapsed_ms += other.elapsed_ms;
        self.batches_sent += other.batches_sent;
        self.bytes_sent += other.bytes_sent;
        self.send_ms_total += other.send_ms_total;
        self.send_ms_max = self.send_ms_max.max(other.send_ms_max);
        self.batches_acknowledged += other.batches_acknowledged;
        self.records_acknowledged += other.records_acknowledged;
        self.queue_ms_max = self.queue_ms_max.max(other.queue_ms_max);
        self.event_lag_ms = match (self.event_lag_ms, other.event_lag_ms) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        };
        self.max_in_flight = self.max_in_flight.max(other.max_in_flight);
        self.batches_retried += other.batches_retried;
    }
}

/// The event time a record's payload carries, if any.
fn event_time_ms(payload: &serde_json::Value) -> Option<i64> {
    ["ts_ms", "timestamp_ms"]
        .iter()
        .find_map(|column| payload.get(*column).and_then(serde_json::Value::as_i64))
}

fn millis(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

/// A drain's local error, kept with its typed causes. Two are equal only when
/// they are the same error.
#[derive(Debug, Clone)]
pub struct LocalFailure(std::sync::Arc<anyhow::Error>);
impl PartialEq for LocalFailure {
    fn eq(&self, other: &Self) -> bool {
        std::sync::Arc::ptr_eq(&self.0, &other.0)
    }
}
impl Eq for LocalFailure {}
impl LocalFailure {
    /// The error itself, or a copy of its message when it is still shared.
    pub fn into_error(self) -> anyhow::Error {
        std::sync::Arc::try_unwrap(self.0).unwrap_or_else(|shared| anyhow::anyhow!("{shared:#}"))
    }
}

/// Shortest gap between two lease-renewal attempts.
///
/// Once the keepalive is inside its renewal margin the computed wait is zero,
/// so without a floor a contended renewal would retry in a tight loop against
/// the writer holding the lock.
const RENEWAL_RETRY_FLOOR_MS: u64 = 5;

/// How long one renewal waits for the write lock before giving the decision
/// back to the renewal loop.
///
/// A sixth of the lease, so a blocked renewal returns with most of its margin
/// intact and several attempts still available before the deadline. Floored so
/// a very short lease still makes progress, and capped so a very long one does
/// not inherit the thirty-second wait this exists to avoid.
fn keepalive_busy_timeout_ms(lease_ms: i64) -> u64 {
    (lease_ms / 6).clamp(5, 2_000) as u64
}

/// Whether a failed write is SQLite refusing it because another connection
/// holds the lock, rather than the write itself being rejected.
///
/// "I could not write just now" and "this write is not allowed" are the same
/// `Err` at the call site, and the delivery keepalive read the first as the
/// second: a renewal that merely lost a race for the database marked the claim
/// lost, discarding a send that had already succeeded.
fn lost_a_race_for_the_database(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<rusqlite::Error>()
        .is_some_and(|error| {
            matches!(
                error,
                rusqlite::Error::SqliteFailure(failure, _)
                    if matches!(
                        failure.code,
                        rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked
                    )
            )
        })
}

/// Whether preparing a batch failed for a reason of its own, rather than
/// because the store refused an operation: a busy, full, unreadable or
/// damaged database is the database's condition, and is reported as a
/// delivery state failure.
fn preparation_failed(error: &anyhow::Error) -> bool {
    error.downcast_ref::<super::PreparationFailed>().is_some()
        && error.chain().all(|cause| {
            cause.downcast_ref::<rusqlite::Error>().is_none()
                && cause.downcast_ref::<ai_hist::Error>().is_none()
                && cause.downcast_ref::<std::io::Error>().is_none()
        })
}

pub fn system_clock() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| i64::try_from(value.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

fn range(value: i64, name: &str, minimum: i64, maximum: i64) -> Result<()> {
    if value < minimum || value > maximum {
        bail!("INVALID_ARGUMENT: {name} must be between {minimum} and {maximum}");
    }
    Ok(())
}
/// Release every settled receipt, a bounded transaction at a time, while
/// `more` allows.
fn compact(conn: &Connection, more: &dyn Fn() -> bool) -> Result<()> {
    while more() && compact_receipts(conn, RECEIPT_PAGE)? == RECEIPT_PAGE {}
    Ok(())
}
/// Settled receipts one compaction transaction removes.
const RECEIPT_PAGE: usize = 10_000;
fn chosen(selection: Option<&[String]>, job_id: &str) -> bool {
    match selection {
        None => true,
        Some(ids) => ids.iter().any(|id| id == job_id),
    }
}

/// One bounded drain. It never waits for a retry deadline or enables a job.
///
/// The database path, rather than a connection, is required because the lease
/// keepalive renews from its own connection on its own thread while a receiver
/// holds the calling thread. `clock` returns epoch milliseconds; pass
/// [`system_clock`] unless a test needs a deterministic clock. `cancelled`
/// reports a host stop request and is polled between and during attempts.
pub fn drain(
    db_path: &Path,
    receivers: &dyn Receivers,
    options: &DrainOptions,
    clock: &(dyn Fn() -> i64 + Sync),
    cancelled: &(dyn Fn() -> bool + Sync),
) -> Result<DrainResult> {
    session::drain_once(db_path, receivers, options, clock, cancelled)
}

/// The most batches [`DrainOptions::max_in_flight`] may allow at once.
pub const MAX_IN_FLIGHT: usize = 16;

/// Batches one job's turn may claim while other jobs share the drain, so a
/// pipelined job cannot hold the drain until its budget is spent.
const SHARED_TURN_BATCHES: usize = 64;

enum Step {
    Idle,
    Progressed,
    Unregistered,
}

struct Worker<'a> {
    conn: &'a Connection,
    keepalive: &'a Mutex<Connection>,
    receivers: &'a dyn Receivers,
    options: &'a DrainOptions,
    clock: &'a (dyn Fn() -> i64 + Sync),
    cancelled: &'a (dyn Fn() -> bool + Sync),
    started: Instant,
    attempts: usize,
    prepare_steps: usize,
    issues: Vec<DrainIssue>,
    failure: Option<anyhow::Error>,
    metrics: DrainMetrics,
    /// The read-only store batches are prepared from, opened by the first
    /// step that prepares one and dropped after a failed preparation, so
    /// the next step opens it again.
    store: &'a mut Option<ai_hist::SessionStore>,
    /// Whether other jobs share this drain, which bounds a pipelined turn.
    shared_turns: bool,
}

/// Work handed to a sender thread.
enum Task {
    /// Map a claimed batch with the receiver's `prepare`.
    Map(ClaimedBatch),
    /// Send a claimed batch's persisted body, validated for it immediately
    /// before.
    Send {
        claim: ClaimedBatch,
        payload: PreparedPayload,
    },
}
/// What a sender thread made of a [`Task`].
enum Done {
    Mapped { claim: ClaimedBatch, mapped: Mapped },
    Sent(Sent),
}
/// What mapping a claimed batch produced: the payload to persist, none when
/// the batch already holds its persisted body, or the batch's failure.
type Mapped = Result<Option<RetainedPayload>, ReceiverFailure>;
/// A send's outcome for its claimed batch.
struct Sent {
    claim: ClaimedBatch,
    outcome: Result<DeliveryAcknowledgment, ReceiverFailure>,
    /// The bytes handed to `send` and how long it took; none when a stop
    /// came first and `send` was never called.
    sent: Option<(u64, Duration)>,
}

/// What recording an attempt's outcome did.
struct Concluded {
    settled: Option<Settled>,
    /// A failure was recorded for the batch: the job now waits out a retry
    /// or is blocked.
    failed: bool,
}

impl<'a> Worker<'a> {
    /// Whether the drain may start another step. The count ceilings are
    /// absolute; the elapsed budget bounds every step after the first, so a
    /// drain always does one unit of work however little budget is left, and
    /// scanning that produces no batch cannot run on past the deadline either.
    fn budget(&self) -> bool {
        self.attempts < self.options.max_batches
            && self.prepare_steps < self.options.max_prepare_steps
            && (self.prepare_steps == 0 || self.within_budget())
    }
    /// Whether an attempt may start. The first attempt of a drain always runs,
    /// so a batch is never left undelivered by a budget that expired while that
    /// same step was preparing it.
    fn may_attempt(&self) -> bool {
        self.attempts == 0 || self.within_budget()
    }
    fn within_budget(&self) -> bool {
        self.options
            .max_elapsed
            .is_none_or(|limit| self.started.elapsed() < limit)
    }
    /// At most one issue per job, whatever its cause, exactly as the host SDK.
    fn issue(&mut self, job_id: &str, code: DrainIssueCode, detail: Option<String>) {
        if !self.issues.iter().any(|issue| issue.job_id == job_id) {
            self.issues.push(DrainIssue {
                job_id: job_id.to_owned(),
                code,
                detail,
            });
        }
    }

    /// One job iteration inside the drain's per-job error boundary.
    fn step(&mut self, job_id: &str) -> Result<Step> {
        let job = super::schedule(&self.conn, job_id)?;
        if job.state != "active" || job.next_attempt_ms > (self.clock)() {
            return Ok(Step::Idle);
        }
        let receivers = self.receivers;
        let Some(receiver) =
            receivers.receiver(&job.config.destination_id, &job.config.instance_id)
        else {
            return Ok(Step::Unregistered);
        };
        let published = receiver.published_limits(&LimitsContext {
            cancelled: self.cancelled,
            timeout_ms: request_timeout_ms(
                self.options.request_timeout_ms,
                self.options.request_deadline,
            ),
        });
        if self.options.max_in_flight > 1 {
            if let Some(concurrent) = receiver.concurrent() {
                return self.pipeline(job_id, concurrent, &job.config);
            }
        }
        let prepared = self.prepare(job_id, 1, published)?;
        self.prepare_steps += 1;
        if prepared.batch_id.is_none() {
            // Scanning only excluded or unselected rows still moves a cursor.
            return Ok(
                if !prepared.bootstrap_complete || prepared.scanned_records > 0 {
                    Step::Progressed
                } else {
                    Step::Idle
                },
            );
        }
        // Preparing a batch can wait on the busy handler for longer than the
        // budget that remains. The batch stays pending for the next drain
        // rather than starting a network attempt past the deadline the host's
        // stop request and heartbeat depend on.
        if !self.may_attempt() {
            return Ok(Step::Progressed);
        }
        let Some(claim) = claim_batch(
            &self.conn,
            job_id,
            &self.options.worker_id,
            self.options.lease_ms,
            self.clock,
        )?
        else {
            // A privacy recheck can suppress the obsolete pending batch. If
            // re-inclusion has a fresh baseline ready, continue this bounded
            // drain instead of waiting for another host scheduling interval.
            let current = status(&self.conn, job_id)?;
            return Ok(
                if current.state == "active"
                    && current.pending_records == 0
                    && (!current.bootstrap_complete || current.unqueued_changes > 0)
                {
                    Step::Progressed
                } else {
                    Step::Idle
                },
            );
        };
        self.attempts += 1;
        self.claimed(&claim, 1);
        let attempt = self.attempt(receiver, &claim, &job.config)?;
        self.measure(&claim, attempt);
        Ok(Step::Progressed)
    }

    /// Prepare the job's next batch through the drain's store.
    fn prepare(
        &mut self,
        job_id: &str,
        window: usize,
        published: PublishedLimits,
    ) -> Result<super::PrepareResult> {
        let store = match self.store.take() {
            Some(store) => store,
            None => super::feed::store(&self.conn).context(super::PreparationFailed)?,
        };
        let prepared = prepare_batch_from(
            &self.conn,
            &store,
            job_id,
            (self.clock)(),
            window,
            published,
        );
        if prepared.is_ok() {
            *self.store = Some(store);
        }
        prepared
    }

    /// Count a claim: a batch that already holds a prepared body was claimed
    /// before, so this attempt retries it.
    fn claimed(&mut self, claim: &ClaimedBatch, in_flight: usize) {
        if claim.prepared.is_some() {
            self.metrics.batches_retried += 1;
        }
        self.metrics.max_in_flight = self.metrics.max_in_flight.max(in_flight as u64);
    }

    /// Fold one attempt into the drain's metrics.
    fn measure(&mut self, claim: &ClaimedBatch, attempt: Attempt) {
        let metrics = &mut self.metrics;
        if let Some((bytes, took)) = attempt.sent {
            metrics.batches_sent += 1;
            metrics.bytes_sent += bytes;
            metrics.send_ms_total += millis(took);
            metrics.send_ms_max = metrics.send_ms_max.max(millis(took));
        }
        let Some(settled) = attempt.settled.filter(|settled| settled.complete) else {
            return;
        };
        let now = (self.clock)();
        metrics.batches_acknowledged += 1;
        metrics.records_acknowledged += settled.accepted as u64;
        metrics.queue_ms_max = metrics
            .queue_ms_max
            .max(u64::try_from(now - settled.created_ms).unwrap_or(0));
        let newest = claim
            .batch
            .records
            .iter()
            .filter_map(|record| event_time_ms(&record.payload))
            .max();
        if let Some(newest) = newest {
            let lag = u64::try_from(now - newest).unwrap_or(0);
            metrics.event_lag_ms = Some(metrics.event_lag_ms.map_or(lag, |known| known.min(lag)));
        }
    }

    /// One attempt under the claimed lease. Returns `Ok` once the outcome is
    /// durably recorded, whether that is an acknowledgment or a failure; only
    /// a fenced or failing state write escapes to the job error boundary.
    fn attempt(
        &self,
        receiver: &dyn Receiver,
        claim: &ClaimedBatch,
        config: &DeliveryJobConfig,
    ) -> Result<Attempt> {
        let sent = Cell::new(None);
        let lost = AtomicBool::new(false);
        let stop = KeepaliveStop::default();
        let host = self.cancelled;
        let stopping = || host() || lost.load(Ordering::SeqCst);
        let outcome = std::thread::scope(|scope| {
            let renewals = scope.spawn(|| {
                keep_alive(
                    self.keepalive,
                    &claim.lease,
                    self.options.lease_ms,
                    self.clock,
                    &stop,
                    &lost,
                    renew_lease,
                )
            });
            // The keepalive must stop even if the receiver panics: the
            // scope joins every thread before unwinding, and a renewal loop
            // that never sees `stop` would hold the lease and hang the
            // drain. A receiver panic is contained as a transient failure
            // so one misbehaving destination cannot take the host down.
            let guard = StopOnDrop(&stop);
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let payload = self.ready(receiver, claim, config, &stopping)?;
                let started = Instant::now();
                let ack = receiver.send(&payload, &claim.batch, &self.context(claim, &stopping));
                sent.set(Some((payload.body.len() as u64, started.elapsed())));
                let ack = ack?;
                check_acknowledgment(&ack, &claim.batch)?;
                Ok(ack)
            }))
            .unwrap_or_else(|_| Err(DeliveryFailure::Transient.into()));
            drop(guard);
            // A panicking keepalive thread must not take the drain with it.
            let _ = renewals.join();
            result
        });
        let concluded = self.conclude(claim, outcome, lost.load(Ordering::SeqCst))?;
        Ok(Attempt {
            sent: sent.get(),
            settled: concluded.settled,
        })
    }

    /// Record an attempt's outcome under its lease: an acknowledgment, a
    /// classified failure, or an orderly release on a host stop. Only a fenced
    /// or failing state write escapes, to the job error boundary.
    fn conclude(
        &self,
        claim: &ClaimedBatch,
        outcome: Result<DeliveryAcknowledgment, ReceiverFailure>,
        lost: bool,
    ) -> Result<Concluded> {
        // A host stop is an orderly interruption, not a failed upload. The
        // transient result also covers a receiver honoring ctx.cancelled().
        // Keep explicit receiver refusals (including Retry-After) authoritative.
        // Even a completed send stays unacknowledged on stop: replay the same
        // persisted bytes/id after restart. The release is fenced in core.
        if (self.cancelled)()
            && matches!(
                &outcome,
                Ok(_)
                    | Err(ReceiverFailure {
                        failure: DeliveryFailure::Transient,
                        retry_after_ms: None,
                        recovery: None,
                    })
            )
        {
            release_stopped_claim(&self.conn, &claim.lease, self.clock)?;
            return Ok(Concluded {
                settled: None,
                failed: false,
            });
        }
        let mut settled = None;
        let verdict = match outcome {
            // Lease loss still fences acknowledgments. If a stop arrives after
            // the outcome decision above, a completed owned send can commit;
            // do not turn that late stop into a synthetic receiver failure.
            Ok(_) if lost => Err(DeliveryFailure::Transient.into()),
            Ok(ack) => settle(&self.conn, &claim.lease, &ack, self.clock)
                .map(|outcome| settled = Some(outcome))
                .map_err(|_| ReceiverFailure::from(DeliveryFailure::Transient)),
            Err(failure) => Err(failure),
        };
        let failed = match verdict {
            Err(failure) => {
                if let Some(recovery) = failure.recovery.as_ref() {
                    match recover_conflict_classified(
                        &self.conn,
                        &claim.lease,
                        recovery,
                        self.clock,
                    ) {
                        Ok(()) => {
                            return Ok(Concluded {
                                settled: None,
                                failed: false,
                            });
                        }
                        Err(ConflictRecoveryError::Rejected(_)) => {
                            eprintln!("delivery conflict recovery rejected: invalid recovery plan");
                        }
                        Err(ConflictRecoveryError::Storage(_)) => {
                            eprintln!(
                                "delivery conflict recovery deferred: local storage unavailable"
                            );
                            record_failure(
                                &self.conn,
                                &claim.lease,
                                DeliveryFailure::Transient,
                                failure.retry_after_ms,
                                self.clock,
                            )?;
                            return Ok(Concluded {
                                settled: None,
                                failed: true,
                            });
                        }
                        Err(error @ ConflictRecoveryError::Fenced) => {
                            eprintln!("delivery conflict recovery fenced: lease ownership changed");
                            return Err(error.into());
                        }
                    }
                }
                // The core fences this write. If another worker owns the job,
                // even failure recording must fail rather than move that
                // worker's state. This is also the safe fallback when a
                // receiver recovery plan fails its transactional recheck: an
                // owned batch is durably blocked with the truthful conflict
                // verdict instead of remaining leased and being resent on
                // every drain.
                record_failure(
                    &self.conn,
                    &claim.lease,
                    failure.failure,
                    failure.retry_after_ms,
                    self.clock,
                )?;
                true
            }
            Ok(()) => !settled.is_some_and(|settled: Settled| settled.complete),
        };
        Ok(Concluded { settled, failed })
    }

    /// The context a receiver call for `claim` runs with.
    fn context<'c>(
        &self,
        claim: &'c ClaimedBatch,
        stopping: &'c dyn Fn() -> bool,
    ) -> ReceiverContext<'c> {
        receiver_context(
            claim,
            stopping,
            self.options.request_timeout_ms,
            self.options.request_deadline,
        )
    }

    /// Mapping, payload persistence and the eligibility recheck: everything
    /// before transport, ending with the persisted body to send.
    fn ready(
        &self,
        receiver: &dyn Receiver,
        claim: &ClaimedBatch,
        config: &DeliveryJobConfig,
        stopping: &dyn Fn() -> bool,
    ) -> Result<PreparedPayload, ReceiverFailure> {
        let mapped = map(
            receiver,
            claim,
            config.limits.max_prepared_bytes,
            &self.context(claim, stopping),
        )?;
        self.dispatch(claim, mapped, stopping)
    }

    /// Persist a batch's mapped payload, if it has one, and recheck its
    /// eligibility, ending with the persisted body to send. A pipelined drain
    /// does this on its draining thread, which holds the journal connection,
    /// and hands the body to a sender thread at once. Every local error here
    /// is a retryable transient.
    fn dispatch(
        &self,
        claim: &ClaimedBatch,
        mapped: Option<RetainedPayload>,
        stopping: &dyn Fn() -> bool,
    ) -> Result<PreparedPayload, ReceiverFailure> {
        let transient = || ReceiverFailure::from(DeliveryFailure::Transient);
        if stopping() {
            return Err(transient());
        }
        if let Some(retained) = mapped {
            store_payload(&self.conn, &claim.lease, retained, self.clock)
                .map_err(|_| transient())?;
            if stopping() {
                return Err(transient());
            }
        }
        // Eligibility can change while a receiver maps its payload. Recheck it
        // in core immediately before transport and send the persisted bytes.
        let payload =
            validate_dispatch(&self.conn, &claim.lease, self.clock).map_err(|_| transient())?;
        if stopping() {
            return Err(transient());
        }
        Ok(payload)
    }

    /// Record an attempt's outcome and fold it into the drain's metrics.
    /// Returns whether it recorded a failure.
    fn finish(
        &mut self,
        claim: &ClaimedBatch,
        outcome: Result<DeliveryAcknowledgment, ReceiverFailure>,
        sent: Option<(u64, Duration)>,
        lost: bool,
    ) -> Result<bool> {
        let concluded = self.conclude(claim, outcome, lost)?;
        self.measure(
            claim,
            Attempt {
                sent,
                settled: concluded.settled,
            },
        );
        Ok(concluded.failed)
    }

    /// One job's turn with up to [`DrainOptions::max_in_flight`] batches in
    /// flight. This thread prepares and claims each batch and hands it to an
    /// idle sender thread, which maps it with the receiver's `prepare`. In
    /// claim order, this thread then persists each mapped payload and
    /// validates it, and hands it at once to a sender thread to send, so the
    /// eligibility recheck still immediately precedes `send`. It records every
    /// outcome itself, under the one job lease the window's batches share,
    /// which a keepalive renews while any of them is in flight. A failure
    /// stops further claims until its retry deadline; the batches already in
    /// flight finish and are recorded, so one acknowledged beyond the failed
    /// one stays delivered while the failed one waits to be retried.
    fn pipeline(
        &mut self,
        job_id: &str,
        receiver: &'a (dyn Receiver + Sync),
        config: &DeliveryJobConfig,
    ) -> Result<Step> {
        let window = self.options.max_in_flight;
        let host = self.cancelled;
        let clock = self.clock;
        let keepalive_conn = self.keepalive;
        let lease_ms = self.options.lease_ms;
        let configured_timeout_ms = self.options.request_timeout_ms;
        let request_deadline = self.options.request_deadline;
        let max_prepared_bytes = config.limits.max_prepared_bytes;
        let lost = AtomicBool::new(false);
        let stopping = || host() || lost.load(Ordering::SeqCst);
        let (to_senders, tasks) = mpsc::channel::<Task>();
        let tasks = Mutex::new(tasks);
        let (to_worker, finished) = mpsc::channel::<Done>();
        std::thread::scope(|scope| {
            for _ in 0..window {
                let to_worker = to_worker.clone();
                let (tasks, lost) = (&tasks, &lost);
                scope.spawn(move || {
                    let stopping = || host() || lost.load(Ordering::SeqCst);
                    loop {
                        let task = tasks.lock().unwrap_or_else(|e| e.into_inner()).recv();
                        let Ok(task) = task else {
                            return;
                        };
                        let done = match task {
                            Task::Map(claim) => {
                                let mapped = {
                                    let context = receiver_context(
                                        &claim,
                                        &stopping,
                                        configured_timeout_ms,
                                        request_deadline,
                                    );
                                    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                                        map(receiver, &claim, max_prepared_bytes, &context)
                                    }))
                                    .unwrap_or_else(|_| Err(DeliveryFailure::Transient.into()))
                                };
                                Done::Mapped { claim, mapped }
                            }
                            Task::Send { claim, payload } => {
                                let (outcome, sent) = if stopping() {
                                    (Err(DeliveryFailure::Transient.into()), None)
                                } else {
                                    let context = receiver_context(
                                        &claim,
                                        &stopping,
                                        configured_timeout_ms,
                                        request_deadline,
                                    );
                                    let started = Instant::now();
                                    let outcome = std::panic::catch_unwind(
                                        std::panic::AssertUnwindSafe(|| {
                                            let ack =
                                                receiver.send(&payload, &claim.batch, &context)?;
                                            check_acknowledgment(&ack, &claim.batch)?;
                                            Ok(ack)
                                        }),
                                    )
                                    .unwrap_or_else(|_| Err(DeliveryFailure::Transient.into()));
                                    (
                                        outcome,
                                        Some((payload.body.len() as u64, started.elapsed())),
                                    )
                                };
                                Done::Sent(Sent {
                                    claim,
                                    outcome,
                                    sent,
                                })
                            }
                        };
                        if to_worker.send(done).is_err() {
                            return;
                        }
                    }
                });
            }
            drop(to_worker);
            // Claimed batches not yet concluded, whether mapping, waiting
            // their turn to be persisted, or sending.
            let mut in_flight = 0usize;
            // Claimed batches not yet handed over to send, in claim order,
            // each with its mapping once a sender thread returned it.
            let mut unsent: VecDeque<(String, Option<(ClaimedBatch, Mapped)>)> = VecDeque::new();
            // Owned here, so a panic on this thread drops it while unwinding
            // and the senders waiting for tasks return before the scope joins
            // them.
            let to_senders = to_senders;
            let mut held: Option<DeliveryLease> = None;
            let mut keeper: Option<Keeper<'_>> = None;
            let mut halted = false;
            let mut progressed = false;
            let mut error: Option<anyhow::Error> = None;
            let mut turn = 0usize;
            let mut prepared_since_claim = false;
            let close = |keeper: &mut Option<Keeper<'_>>| {
                if let Some(keeper) = keeper.take() {
                    keeper.close();
                }
            };
            loop {
                while !halted
                    && in_flight < window
                    && self.budget()
                    && !stopping()
                    && !(self.shared_turns && turn >= SHARED_TURN_BATCHES)
                {
                    // Preparing can wait on the busy handler past the budget;
                    // what it prepared stays pending for the next drain.
                    if !self.may_attempt() {
                        halted = true;
                        break;
                    }
                    let next = match &held {
                        Some(lease) => claim_next(&self.conn, lease, clock),
                        None => self.open_window(job_id),
                    };
                    let claim = match next {
                        Ok(NextClaim::Claimed(claim)) => *claim,
                        Ok(NextClaim::Lost) => {
                            halted = true;
                            break;
                        }
                        Ok(NextClaim::Empty) if prepared_since_claim => break,
                        Ok(NextClaim::Empty) => {
                            // Nothing waits to be claimed: prepare the next
                            // batch while the job is still due.
                            let due = super::schedule(&self.conn, job_id)
                                .map(|job| job.state == "active" && job.next_attempt_ms <= clock());
                            match due {
                                Ok(true) => {}
                                Ok(false) => {
                                    halted = true;
                                    break;
                                }
                                Err(failed) => {
                                    error = Some(failed);
                                    halted = true;
                                    break;
                                }
                            }
                            // Each batch is sized by the limits the latest
                            // receipt published.
                            let published = receiver.published_limits(&LimitsContext {
                                cancelled: &stopping,
                                timeout_ms: request_timeout_ms(
                                    configured_timeout_ms,
                                    request_deadline,
                                ),
                            });
                            let prepared = match self.prepare(job_id, window, published) {
                                Ok(prepared) => prepared,
                                Err(failed) => {
                                    error = Some(failed);
                                    halted = true;
                                    break;
                                }
                            };
                            self.prepare_steps += 1;
                            if prepared.batch_id.is_some() {
                                prepared_since_claim = true;
                            } else if !prepared.bootstrap_complete || prepared.scanned_records > 0 {
                                // Scanning only excluded or unselected rows
                                // still moves a cursor.
                                progressed = true;
                            } else {
                                halted = true;
                            }
                            continue;
                        }
                        Err(failed) => {
                            error = Some(failed);
                            halted = true;
                            break;
                        }
                    };
                    prepared_since_claim = false;
                    progressed = true;
                    turn += 1;
                    self.attempts += 1;
                    self.claimed(&claim, in_flight + 1);
                    if held.is_none() {
                        // The window opens: renew its lease while any of its
                        // batches is in flight.
                        let stop = std::sync::Arc::new(KeepaliveStop::default());
                        let lease = claim.lease.clone();
                        let (signal, lost) = (stop.clone(), &lost);
                        let renewals = scope.spawn(move || {
                            keep_alive(
                                keepalive_conn,
                                &lease,
                                lease_ms,
                                clock,
                                &signal,
                                lost,
                                renew_window,
                            )
                        });
                        keeper = Some(Keeper {
                            stop,
                            renewals: Some(renewals),
                        });
                        held = Some(claim.lease.clone());
                    }
                    let batch_id = claim.batch.batch_id.clone();
                    if to_senders.send(Task::Map(claim)).is_err() {
                        error = Some(anyhow!("delivery senders stopped"));
                        halted = true;
                        break;
                    }
                    unsent.push_back((batch_id, None));
                    in_flight += 1;
                }
                if in_flight == 0 {
                    break;
                }
                let done = match finished.recv() {
                    Ok(done) => done,
                    Err(_) => {
                        error.get_or_insert_with(|| anyhow!("delivery senders stopped"));
                        break;
                    }
                };
                match done {
                    Done::Mapped { claim, mapped } => {
                        let slot = unsent
                            .iter_mut()
                            .find(|(batch_id, _)| *batch_id == claim.batch.batch_id)
                            .expect("a mapped batch was claimed in this window");
                        slot.1 = Some((claim, mapped));
                    }
                    Done::Sent(Sent {
                        claim,
                        outcome,
                        sent,
                    }) => {
                        in_flight -= 1;
                        // A slot is free again: the next fill may prepare.
                        prepared_since_claim = false;
                        match self.finish(&claim, outcome, sent, lost.load(Ordering::SeqCst)) {
                            Ok(failed) => halted |= failed,
                            Err(failed) => {
                                error.get_or_insert(failed);
                                halted = true;
                            }
                        }
                    }
                }
                // Persist, validate and hand over to send every mapped batch
                // whose earlier claims have all been handed over.
                while let Some((_, Some(_))) = unsent.front() {
                    let Some((_, Some((claim, mapped)))) = unsent.pop_front() else {
                        break;
                    };
                    let ready = mapped.and_then(|mapped| {
                        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            self.dispatch(&claim, mapped, &stopping)
                        }))
                        .unwrap_or_else(|_| Err(DeliveryFailure::Transient.into()))
                    });
                    match ready {
                        Ok(payload) => {
                            if to_senders.send(Task::Send { claim, payload }).is_err() {
                                in_flight -= 1;
                                error.get_or_insert_with(|| anyhow!("delivery senders stopped"));
                                halted = true;
                            }
                        }
                        Err(failure) => {
                            in_flight -= 1;
                            // A slot is free again: the next fill may prepare.
                            prepared_since_claim = false;
                            match self.finish(
                                &claim,
                                Err(failure),
                                None,
                                lost.load(Ordering::SeqCst),
                            ) {
                                Ok(failed) => halted |= failed,
                                Err(failed) => {
                                    error.get_or_insert(failed);
                                    halted = true;
                                }
                            }
                        }
                    }
                }
                if in_flight == 0 {
                    // The last outcome released the window's lease.
                    close(&mut keeper);
                    held = None;
                }
            }
            close(&mut keeper);
            drop(to_senders);
            match error {
                Some(error) => Err(error),
                None if progressed => Ok(Step::Progressed),
                None => Ok(Step::Idle),
            }
        })
    }

    /// Open a window: claim the job's oldest unresolved batch under a new job
    /// lease, as a one-batch drain does.
    fn open_window(&self, job_id: &str) -> Result<NextClaim> {
        Ok(
            match claim_batch(
                &self.conn,
                job_id,
                &self.options.worker_id,
                self.options.lease_ms,
                self.clock,
            )? {
                Some(claim) => NextClaim::Claimed(Box::new(claim)),
                None => NextClaim::Empty,
            },
        )
    }
}

/// A window's keepalive thread. Dropping it, including while unwinding, tells
/// the thread to stop, so the scope that joins it cannot wait forever.
struct Keeper<'scope> {
    stop: std::sync::Arc<KeepaliveStop>,
    renewals: Option<std::thread::ScopedJoinHandle<'scope, ()>>,
}
impl Keeper<'_> {
    /// Stop the keepalive and wait for it.
    fn close(mut self) {
        self.stop.stop();
        if let Some(renewals) = self.renewals.take() {
            // A panicking keepalive thread must not take the drain with it.
            let _ = renewals.join();
        }
    }
}
impl Drop for Keeper<'_> {
    fn drop(&mut self) {
        self.stop.stop();
    }
}

/// Renew `lease` with two thirds of it still to run until `stop`, setting
/// `lost` when a renewal is refused: the claim then belongs to someone else,
/// and the attempts under it are cancelled.
///
/// Renewing with two thirds of the lease still to run means two consecutive
/// renewals can be missed entirely before the claim is at risk. Same cadence
/// as a fixed `lease_ms / 3` interval in the quiet case; the difference is
/// that each wait is computed from the lease's own deadline, so a renewal
/// that took 300 ms is followed by a correspondingly shorter wait instead of
/// a full interval on top of it. Anchoring on the deadline is what stops the
/// cadence drifting out under sustained load, which is how a live claim
/// silently lapsed and let a second worker dispatch the same batch.
fn keep_alive(
    keepalive: &Mutex<Connection>,
    lease: &DeliveryLease,
    lease_ms: i64,
    clock: &(dyn Fn() -> i64 + Sync),
    stop: &KeepaliveStop,
    lost: &AtomicBool,
    renew: fn(&Connection, &DeliveryLease, i64, &dyn Fn() -> i64) -> Result<DeliveryLease>,
) {
    let margin_ms = lease_ms - 1.max(lease_ms / 3);
    let mut expires_at_ms = lease.expires_at_ms;
    loop {
        let wait_ms = (expires_at_ms - clock() - margin_ms).max(0) as u64;
        // Inside the renewal margin the computed wait is zero, and a renewal
        // that lost a race for the write lock must back off a little rather
        // than contend in a tight loop with the writer it is waiting for.
        let wait = Duration::from_millis(wait_ms.max(RENEWAL_RETRY_FLOOR_MS));
        if !sleep_until(stop, wait) {
            break;
        }
        // Deliberately no "the deadline passed, so the claim is gone" check
        // here. Expiry is a signal to *other* workers that an abandoned batch
        // may be stolen, and `claim_batch` enforces it; a lease that lapsed
        // while nobody took it is still ours, and `check_lease` says so by
        // fence. Giving up on the clock alone would discard a send that had
        // already succeeded, for a batch no one else ever touched.
        let renewed = keepalive
            .lock()
            .map_err(|_| anyhow!("delivery keepalive connection is poisoned"))
            .and_then(|conn| renew(&conn, lease, lease_ms, &clock));
        match renewed {
            Ok(lease) => expires_at_ms = lease.expires_at_ms,
            // Losing a race for the database is not losing the lease: the
            // keepalive's connection gives up on a contended write quickly
            // (see `keepalive_busy_timeout_ms`) precisely so the decision
            // comes back here, where the deadline is known, rather than being
            // made by a busy handler that has never heard of it. Retry.
            //
            // Anything else -- notably `check_lease` refusing because another
            // worker now owns the batch -- is a verdict, and is reported at
            // once.
            Err(error) if lost_a_race_for_the_database(&error) => {}
            Err(_) => {
                lost.store(true, Ordering::SeqCst);
                break;
            }
        }
    }
}

/// What one attempt did, for the drain's metrics: the bytes it handed to
/// `send` and how long that took, and what recording its outcome did.
struct Attempt {
    sent: Option<(u64, Duration)>,
    settled: Option<Settled>,
}

/// The context a receiver call for `claim` runs with.
fn receiver_context<'c>(
    claim: &'c ClaimedBatch,
    stopping: &'c dyn Fn() -> bool,
    configured_timeout_ms: i64,
    request_deadline: Option<Instant>,
) -> ReceiverContext<'c> {
    ReceiverContext {
        cancelled: stopping,
        timeout_ms: request_timeout_ms(configured_timeout_ms, request_deadline),
        idempotency_key: &claim.batch.batch_id,
        accepted_revision_ids: &claim.accepted_revision_ids,
        suppressed_revision_ids: &claim.suppressed_revision_ids,
        rejected_revision_ids: &claim.rejected_revision_ids,
        isolation_frontier: &claim.isolation_frontier,
    }
}

/// The receiver's mapping of a claimed batch, hashed and serialized as its
/// row retains it, or none when the batch already holds its persisted body.
/// It reads no local state, so a pipelined drain runs it on a sender thread.
/// Every local error here is a retryable transient: only the receiver
/// classifies the batch itself.
fn map(
    receiver: &dyn Receiver,
    claim: &ClaimedBatch,
    max_prepared_bytes: usize,
    context: &ReceiverContext<'_>,
) -> Mapped {
    let transient = || ReceiverFailure::from(DeliveryFailure::Transient);
    if (context.cancelled)() {
        return Err(transient());
    }
    if receiver.mapping_version() != claim.batch.mapping_version {
        return Err(DeliveryFailure::MappingVersionMismatch.into());
    }
    let kinds = receiver.supported_kinds();
    if claim.batch.records.iter().any(|record| {
        !kinds.contains(&record.kind.as_str())
            || (record.operation == "delete" && !receiver.supports_tombstones())
    }) {
        return Err(DeliveryFailure::UnsupportedEvidence.into());
    }
    if claim.prepared.is_some() {
        return Ok(None);
    }
    let prepared = receiver.prepare(&claim.batch, context)?;
    if (context.cancelled)() {
        return Err(transient());
    }
    if prepared.content_type.is_empty()
        || prepared.content_type.len() > 200
        || prepared.content_type.contains(['\r', '\n'])
    {
        return Err(DeliveryFailure::InvalidPayload.into());
    }
    let retained = RetainedPayload::new(PreparedPayload::stored(
        receiver.mapping_version(),
        &prepared.content_type,
        &prepared.body,
        Some(THIS_BUILD),
    ))
    .map_err(|_| transient())?;
    if retained.len() > max_prepared_bytes {
        return Err(DeliveryFailure::InvalidPayload.into());
    }
    Ok(Some(retained))
}

/// Every acknowledged, unsupported, adapter-suppressed, provisionally rejected,
/// or pending-isolation id must be a distinct revision of this exact batch.
/// Core rejects a partial acceptance as a retryable hole.
fn check_acknowledgment(
    ack: &DeliveryAcknowledgment,
    batch: &HistoryExportBatch,
) -> Result<(), ReceiverFailure> {
    let expected: HashSet<&str> = batch
        .records
        .iter()
        .map(|record| record.revision_id.as_str())
        .collect();
    if ack.batch_id != batch.batch_id {
        return Err(DeliveryFailure::InvalidPayload.into());
    }
    let mut seen: HashSet<&str> = HashSet::new();
    for id in ack
        .accepted_revision_ids
        .iter()
        .chain(ack.unsupported_revision_ids.iter())
        .chain(ack.suppressed_revision_ids.iter())
        .chain(ack.rejected_revision_ids.iter())
    {
        if !expected.contains(id.as_str()) || !seen.insert(id.as_str()) {
            return Err(DeliveryFailure::InvalidPayload.into());
        }
    }
    for task in &ack.isolation_frontier {
        if task.revision_ids.is_empty() {
            return Err(DeliveryFailure::InvalidPayload.into());
        }
        for id in &task.revision_ids {
            if !expected.contains(id.as_str()) || !seen.insert(id.as_str()) {
                return Err(DeliveryFailure::InvalidPayload.into());
            }
        }
    }
    Ok(())
}

/// Tells the keepalive thread its attempt is over, waking it at once: the
/// attempt joins that thread before it records its outcome, so a keepalive
/// that only noticed on its next poll would add that poll's delay to every
/// batch.
#[derive(Default)]
struct KeepaliveStop {
    stopped: Mutex<bool>,
    wake: Condvar,
}
impl KeepaliveStop {
    fn stop(&self) {
        *self.stopped.lock().unwrap_or_else(|e| e.into_inner()) = true;
        self.wake.notify_all();
    }
}

/// Raises the keepalive stop flag when dropped, including during unwinding.
struct StopOnDrop<'a>(&'a KeepaliveStop);
impl Drop for StopOnDrop<'_> {
    fn drop(&mut self) {
        self.0.stop();
    }
}

/// Wait until `interval` has passed or the attempt asks the keepalive to
/// stop, whichever is first. Returns false once the attempt asked it to stop.
///
/// The wait is measured against a real deadline, not by accumulating the
/// durations it asked for: a wakeup guarantees only that time has passed, and
/// on a loaded machine it can be late or spurious, so each wait is for what
/// remains until the deadline. Counting requested slices instead made the
/// renewal cadence stretch by exactly the factor the machine was overloaded
/// by, which is the wrong way round for a keepalive.
fn sleep_until(stop: &KeepaliveStop, interval: Duration) -> bool {
    let deadline = Instant::now() + interval;
    let mut stopped = stop.stopped.lock().unwrap_or_else(|e| e.into_inner());
    loop {
        if *stopped {
            return false;
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return true;
        }
        stopped = stop
            .wake
            .wait_timeout(stopped, remaining)
            .unwrap_or_else(|e| e.into_inner())
            .0;
    }
}
