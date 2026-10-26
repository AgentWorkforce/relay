use super::{lock, read_config, save_json, save_status_json, user_error, Config};
use agent_relay_probe::cloud::{self, Renewal, RenewalFailure};
use agent_relay_probe::delivery::{self, worker, ExportSelection};
use agent_relay_probe::destination;
use anyhow::{ensure, Context, Result};
use rusqlite::Connection;
use serde_json::json;
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    time::{Duration, Instant},
};

mod claims;
mod passes;
pub(super) use claims::{
    collector_version, ensure_no_live_newer_claim, newer_build, newer_build_live, outdated,
    running, UPDATE_REQUIRED,
};
use passes::deliver;
#[cfg(test)]
use passes::deliver_with_receiver;

/// The destination and generation this probe delivers as. Both are part of the
/// saved job configuration, so they cannot change for an existing install.
pub(super) const DESTINATION: &str = "relayhistory";
pub(super) const INSTANCE: &str = "teams-probe";
/// Wall-clock budget of one delivery pass. A pass runs as many batches as the
/// destination accepts within it, and while a backlog keeps moving the next
/// pass follows at once, so the budget does not bound throughput: it is how
/// often the collector reports while a backlog drains. Stop requests are
/// polled between batches regardless.
pub(super) const DRAIN_TIME_BUDGET: Duration = Duration::from_secs(15);
/// Batches of the job a pass keeps in flight at once: one is prepared,
/// persisted and validated while the other is on the wire. The receiver
/// accepts a workspace's batches one at a time behind workspace-wide locks,
/// so more only queue there, push later batches past the request timeout and
/// lengthen the wait for every other computer in the workspace.
const DELIVERY_CONCURRENCY: usize = 2;
/// Safety ceiling on attempts and prepare steps within one pass, well above
/// what the time budget admits against a live destination.
const DRAIN_STEP_CEILING: usize = 1_000;
/// RelayHistory may spend tens of seconds waiting on its database before it
/// acknowledges a batch, and gives up at about 125 s. Outlast that so an
/// accepted idempotent batch is not retried just before its receipt.
const DELIVERY_REQUEST_TIMEOUT_MS: i64 = 150_000;
/// Gap between passes while the job still has queued, unqueued or unscanned
/// work that the last pass could not move. A pass that moved some starts the
/// next at once.
const BACKLOG_PASS_INTERVAL: Duration = Duration::from_secs(2);
/// Gap between passes once the job is caught up, unless the capture thread
/// wakes the loop first because local history gained something to deliver.
const IDLE_PASS_INTERVAL: Duration = Duration::from_secs(20);
/// An app-update replacement is bounded so one old collector cannot hold the
/// desktop control lock forever. Sharing mutations have no deadline because
/// returning after their durable stop request would strand the collector.
const REPLACEMENT_STOP_TIMEOUT: Duration = Duration::from_secs(10 * 60);
type ReplacementHandoff<'a> = dyn Fn(&Path, &str) -> Result<()> + 'a;
static STOP: AtomicBool = AtomicBool::new(false);
/// Poll the generation-scoped stop file independently of a long capture. The
/// hot record loops read an atomic flag rather than opening a file per record.
struct StopWatch {
    cancelled: Arc<AtomicBool>,
    finish: mpsc::Sender<()>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl StopWatch {
    fn start(directory: &Path, startup_id: &str) -> Self {
        let cancelled = Arc::new(AtomicBool::new(stop_requested(directory, startup_id)));
        let flag = cancelled.clone();
        let directory = directory.to_owned();
        let startup_id = startup_id.to_owned();
        let (finish, receive) = mpsc::channel();
        let thread = std::thread::spawn(move || loop {
            if stop_requested(&directory, &startup_id) {
                flag.store(true, Ordering::Relaxed);
                break;
            }
            match receive.recv_timeout(Duration::from_millis(100)) {
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                _ => break,
            }
        });
        Self {
            cancelled,
            finish,
            thread: Some(thread),
        }
    }
}
impl Drop for StopWatch {
    fn drop(&mut self) {
        let _ = self.finish.send(());
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
pub(super) fn stopping(cancelled: &AtomicBool) -> bool {
    cancelled.load(Ordering::Relaxed) || STOP.load(Ordering::Relaxed)
}

pub fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
/// The stored selection, independent of how much history exists locally:
/// every evidence kind, in every sharing mode. What a mode withholds is
/// consent — exclusions and selected-session membership — not kinds. The
/// new-only baseline is deliberately absent: a delivery configuration is
/// capped at 64 KiB, which a few hundred session identities already exceed,
/// and the same setup must remain reproducible so an interrupted install can
/// recover its generation instead of orphaning it.
pub fn selection(include_existing: bool) -> ExportSelection {
    ExportSelection {
        all_sources: true,
        sources: vec![],
        sessions: vec![],
        kinds: delivery::SUPPORTED_KINDS
            .iter()
            .map(|kind| (*kind).into())
            .collect(),
        excluded_sessions: vec![],
        // A prompt logged with no session cannot be excluded, so no baseline
        // can prove when it began: only sharing everything includes it.
        sessionless: include_existing,
    }
}
/// Converge the durable exclusion baseline on the requested sharing choice and
/// report how many sessions it now withholds. Delivery rechecks exclusions when
/// a batch is prepared, claimed and dispatched, so a new-only baseline has to be
/// complete before the job exists: written afterwards it would race an already
/// prepared batch, whereas written without a job it only withholds more history.
///
/// That ordering is also why the choice to share existing sessions must withdraw
/// the baseline rather than ignore it. Exclusions outlive the generation they
/// were recorded for, so a setup abandoned between the baseline and its job
/// would otherwise keep suppressing exactly the history the user has now opted
/// in to send. Withdrawal is refused while a live job still selects a session,
/// which this path cannot reach: it runs only when no generation was adopted.
pub fn record_baseline(conn: &Connection, include_existing: bool) -> Result<usize> {
    // Exclusions take their own short write transactions, so the consistent
    // read ends before any of them is recorded or withdrawn.
    let identities = delivery::session_identities(conn)?;
    for identity in &identities {
        delivery::set_session_excluded(conn, identity, !include_existing)?;
    }
    Ok(if include_existing {
        0
    } else {
        identities.len()
    })
}
/// [`delivery_options`] for one pass of a drain that must end by a deadline
/// (`history flush`): the pass budget, and every request, within what is left.
pub(super) fn deadline_options(
    job_id: String,
    worker_id: String,
    pass: Duration,
    deadline: Instant,
) -> worker::DrainOptions {
    let remaining = deadline.saturating_duration_since(Instant::now());
    let remaining_ms = i64::try_from(remaining.as_millis()).unwrap_or(i64::MAX);
    worker::DrainOptions {
        // The worker validates whole milliseconds. A positive remainder below
        // one millisecond must not truncate to an invalid zero-ms pass.
        max_elapsed: Some(pass.min(remaining).max(Duration::from_millis(1))),
        // Never let a request outlive the remaining wall-clock budget. The
        // worker accepts milliseconds, so a positive sub-millisecond budget
        // rounds up to the smallest representable timeout.
        request_timeout_ms: DELIVERY_REQUEST_TIMEOUT_MS.min(remaining_ms).max(1),
        // Recompute the remaining request budget immediately before every
        // send. A pass may spend time in maintenance or on earlier batches.
        request_deadline: Some(deadline),
        ..delivery_options(job_id, worker_id)
    }
}
fn delivery_options(job_id: String, worker_id: String) -> worker::DrainOptions {
    worker::DrainOptions {
        job_ids: Some(vec![job_id]),
        // A pass is bounded by wall time so a stop request and the heartbeat
        // are never starved by an unbounded backlog; the next pass continues
        // it. The count bounds are ceilings the time budget rarely reaches.
        max_elapsed: Some(DRAIN_TIME_BUDGET),
        max_batches: DRAIN_STEP_CEILING,
        max_prepare_steps: DRAIN_STEP_CEILING,
        max_in_flight: DELIVERY_CONCURRENCY,
        request_timeout_ms: DELIVERY_REQUEST_TIMEOUT_MS,
        ..worker::DrainOptions::new(worker_id)
    }
}
pub fn capture(directory: &Path, history_url: &str) -> Result<()> {
    capture_with_stop(
        directory,
        history_url,
        Duration::ZERO,
        false,
        Arc::new(AtomicBool::new(false)),
    )
}
pub(super) fn capture_with_stop(
    directory: &Path,
    history_url: &str,
    lock_wait: Duration,
    force: bool,
    cancelled: Arc<AtomicBool>,
) -> Result<()> {
    let started = Instant::now();
    let progress = super::progress::Monitor::start(directory, history_url, None, false);
    let latest = Arc::new(std::sync::Mutex::new(ai_hist::CaptureProgress::default()));
    let seen = latest.clone();
    let observer = progress.observer();
    let result = super::history::sync(
        &directory.join("history.db"),
        lock_wait,
        force,
        move |value| {
            if let Ok(mut last) = seen.lock() {
                *last = value.clone();
            }
            observer(value);
        },
        move || stopping(&cancelled),
    );
    progress.finish(matches!(result, Ok(true)));
    capture_diagnostic(
        directory,
        "broad_capture",
        started,
        0,
        usize::from(!matches!(result, Ok(true))),
        result.as_ref().err(),
    )?;
    if let Err(error) = &result {
        let last = latest.lock().ok();
        let source = last
            .as_ref()
            .map(|v| v.source.as_str())
            .filter(|s| ai_hist::Source::parse(s).is_some())
            .unwrap_or("unknown");
        let value = json!({"operation":"capture","stage":"broad_capture","source":source,"processed_files":last.as_ref().map(|v|v.processed_files).unwrap_or(0),"elapsed_ms":started.elapsed().as_millis(),"error_class":capture_error_class(error)});
        save_json(&directory.join("capture-diagnostic.json"), &value)?;
        eprintln!("{value}");
    }
    if matches!(result, Ok(false)) {
        save_json(
            &directory.join("capture-diagnostic.json"),
            &json!({"operation":"capture","stage":"broad_capture","elapsed_ms":started.elapsed().as_millis(),"outcome":"lock_contended","error_class":"capture_not_started"}),
        )?;
    }
    ensure!(result?, "capture not complete");
    Ok(())
}

#[cfg(test)]
pub fn cycle(directory: &Path, config: &Config) -> Result<()> {
    cycle_with_stop(directory, config, Arc::new(AtomicBool::new(false)), false)?.result()
}

/// What one pass established. Capture and delivery fail independently and are
/// observed at different cadences, so a pass reports them apart: a pass that
/// only delivered leaves `capture` unset and the last capture verdict stands.
struct PassOutcome {
    capture: Option<Result<()>>,
    delivery: Result<()>,
}
impl PassOutcome {
    fn delivery_only(delivery: Result<()>) -> Self {
        Self {
            capture: None,
            delivery,
        }
    }
    /// One result for callers that report a single outcome. A capture fault
    /// names a local condition to act on, so it outranks a delivery fault.
    fn result(self) -> Result<()> {
        match self.capture {
            Some(Err(error)) => Err(error),
            _ => self.delivery,
        }
    }
}

fn cycle_with_stop(
    directory: &Path,
    config: &Config,
    cancelled: Arc<AtomicBool>,
    before_exit: bool,
) -> Result<PassOutcome> {
    super::bridge::openclaw_upgrade::enforce_selection(directory, config)?;
    let conn = agent_relay_probe::delivery::open_db(&directory.join("history.db"))?;
    let status = delivery::status(&conn, &config.job_id)?;
    let selected = super::bridge::mode(config) == super::bridge::SharingMode::Selected;
    if status.state == "paused" {
        // A paused job delivers nothing. Broad capture still runs, so its
        // outcome is this pass's capture verdict; a selected pass observes
        // nothing about capture and leaves the last verdict standing.
        if selected {
            return Ok(PassOutcome::delivery_only(Ok(())));
        }
        let stop = cancelled.clone();
        let captured = super::history::sync(
            &directory.join("history.db"),
            Duration::ZERO,
            false,
            |_| {},
            move || stopping(&stop),
        );
        return Ok(PassOutcome {
            capture: Some(captured.map(|_| ())),
            delivery: Ok(()),
        });
    }
    Ok(run_capture_cycle(
        selected,
        || deliver_captured_with_stop(directory, config, before_exit, &cancelled),
        || ready_to_capture(&conn, &config.job_id),
        || capture_selected(directory, config, &cancelled),
        || {
            capture_with_stop(
                directory,
                &config.history_url,
                Duration::ZERO,
                false,
                cancelled.clone(),
            )
        },
        || stopping(&cancelled),
    ))
}

fn ready_to_capture(conn: &Connection, job_id: &str) -> Result<bool> {
    let status = delivery::status(conn, job_id)?;
    // A retry deadline means delivery cannot progress yet. Keep capturing
    // locally while offline rather than waiting for the remote queue to clear.
    Ok(status.next_attempt_ms > now()
        || (status.bootstrap_complete
            && status.pending_records == 0
            && status.unqueued_changes == 0))
}

// Tests inject a failing/blocked unrelated provider. Selected cycles never
// enter it, and backlog gets priority over any further selected hydration.
fn run_capture_cycle(
    selected: bool,
    deliver: impl Fn() -> Result<()>,
    capture_ready: impl Fn() -> Result<bool>,
    targeted: impl Fn() -> Result<()>,
    broad: impl Fn() -> Result<()>,
    stopped: impl Fn() -> bool,
) -> PassOutcome {
    let delivered = deliver();
    if stopped() {
        return PassOutcome::delivery_only(delivered);
    }
    if delivered.is_ok() && selected {
        match capture_ready() {
            // Readiness reads delivery state, so a failed read is delivery's
            // own outcome; capture simply does not run this pass.
            Err(error) => return PassOutcome::delivery_only(Err(error)),
            Ok(false) => return PassOutcome::delivery_only(delivered),
            Ok(true) => {}
        }
    }
    // Delivery errors must remain visible, but must not prevent acquiring
    // local evidence while credentials, transport or receiver state recover.
    let capture = if selected { targeted() } else { broad() };
    if stopped() {
        return PassOutcome {
            capture: Some(capture),
            delivery: delivered,
        };
    }
    let drained = deliver();
    PassOutcome {
        capture: Some(capture),
        delivery: delivered.and(drained),
    }
}

/// Hydrate only authorized members using core observation locks and cancellation.
fn capture_selected(directory: &Path, config: &Config, cancelled: &Arc<AtomicBool>) -> Result<()> {
    let conn = agent_relay_probe::delivery::open_db(&directory.join("history.db"))?;
    let members = delivery::job_selected_sessions(&conn, &config.job_id)?;
    let captured = capture_members(
        directory,
        members.clone(),
        || stopping(cancelled),
        |member| {
            // Core hydration owns observation locks, parsers and checkpoints.
            // It never enumerates an unrelated provider.
            let stop = cancelled.clone();
            super::history::hydrate(
                &directory.join("history.db"),
                &member.source,
                &member.session_id,
                move || stopping(&stop),
            )
        },
    );
    // Each member's subagents and child threads, which hydration just
    // recorded, are part of it and share its membership.
    delivery::sync_delegated_members(&conn, &config.job_id)?;
    // A one-shot selected run keeps only its members' evidence too, as the
    // capture thread does; a failure is reported and left to the next run.
    // Its delivery runs before and after this, never beside it, so the
    // rewrite can run here.
    if let Ok(true) = super::live::prune_to_members(
        directory,
        &directory.join("history.db"),
        &members,
        cancelled,
    ) {
        super::live::compact_store(directory, &directory.join("history.db"));
    }
    captured
}

/// Continue across member failures while retaining the first typed cause for
/// safe reporting. A member whose provider is not ready yet (Claude's
/// Keychain read still unanswered) is neither a capture nor a failure.
pub(super) fn capture_members(
    directory: &Path,
    members: Vec<delivery::SessionIdentity>,
    stopped: impl Fn() -> bool,
    hydrate: impl Fn(delivery::SessionIdentity) -> Result<()>,
) -> Result<()> {
    let started = Instant::now();
    let mut captured = 0;
    let mut failed = 0;
    let mut first_error = None;
    for member in super::bridge::openclaw_upgrade::hydratable(directory, members) {
        if stopped() {
            break;
        }
        match hydrate(member) {
            Ok(()) => captured += 1,
            // Not ready yet (no Keychain access to Claude Code's login yet):
            // neither captured nor failed, and tried again later.
            Err(error) if super::remote_sources::keychain_not_ready(&error) => {}
            Err(error) => {
                failed += 1;
                capture_diagnostic(
                    directory,
                    "targeted_hydration",
                    started,
                    captured,
                    failed,
                    Some(&error),
                )?;
                if first_error.is_none() {
                    first_error = Some(error);
                }
            }
        }
    }
    match first_error {
        // Keep the typed cause for the safe cycle/desktop classifier. Replacing
        // it with a generic aggregate reports every local fault as "offline".
        Some(error) => Err(error.context("selected session capture incomplete")),
        None => capture_diagnostic(directory, "targeted_hydration", started, captured, 0, None),
    }
}

/// Classify typed causes into stable public labels without exposing raw error details.
pub(super) fn capture_error_class(error: &anyhow::Error) -> &'static str {
    for cause in error.chain() {
        if let Some(store) = cause.downcast_ref::<ai_hist::Error>() {
            return store_error_class(store);
        }
        if let Some(transport) = cause.downcast_ref::<destination::TransportFailure>() {
            if transport.0 == delivery::DeliveryFailure::DeliveryConflict {
                return "delivery_conflict";
            }
        }
        if let Some(sql) = cause.downcast_ref::<rusqlite::Error>() {
            return match sql.sqlite_error_code() {
                Some(rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked) => {
                    "database_busy"
                }
                Some(rusqlite::ErrorCode::DiskFull) => "disk_full",
                Some(rusqlite::ErrorCode::ReadOnly | rusqlite::ErrorCode::PermissionDenied) => {
                    "permission_denied"
                }
                Some(rusqlite::ErrorCode::CannotOpen) => "database_unavailable",
                Some(rusqlite::ErrorCode::DatabaseCorrupt) => "database_corrupt",
                _ => "database_error",
            };
        }
        if let Some(io) = cause.downcast_ref::<std::io::Error>() {
            return match io.kind() {
                std::io::ErrorKind::NotFound => "source_missing",
                std::io::ErrorKind::PermissionDenied => "permission_denied",
                std::io::ErrorKind::StorageFull => "disk_full",
                _ => "io_error",
            };
        }
        if cause.downcast_ref::<serde_json::Error>().is_some() {
            return "invalid_source_json";
        }
    }
    if error
        .downcast_ref::<delivery::PreparationFailed>()
        .is_some()
    {
        return "upload_preparation_failed";
    }
    "capture_error"
}

/// Classify a `SessionStore` failure. The store carries its cause as a stable
/// code and a message rather than the typed SQLite or I/O error, so the local
/// conditions the desktop acts on are recognized by SQLite's and the
/// platform's own fixed wording for them.
fn store_error_class(error: &ai_hist::Error) -> &'static str {
    if matches!(error, ai_hist::Error::Cancelled(_)) {
        return "cancelled";
    }
    let message = error.message();
    let says = |phrases: &[&str]| phrases.iter().any(|phrase| message.contains(phrase));
    if says(&["database is locked", "database table is locked"]) {
        "database_busy"
    } else if says(&["database or disk is full", "No space left on device"]) {
        "disk_full"
    } else if says(&["database disk image is malformed", "file is not a database"]) {
        "database_corrupt"
    } else if says(&[
        "attempt to write a readonly database",
        "access permission denied",
        "Permission denied",
    ]) {
        "permission_denied"
    } else if says(&["unable to open database file"]) {
        "database_unavailable"
    } else if says(&["No such file or directory"]) {
        "source_missing"
    } else if matches!(
        error,
        ai_hist::Error::DatabaseOpen(_) | ai_hist::Error::Query(_)
    ) {
        "database_error"
    } else {
        "capture_error"
    }
}

/// Return actionable, allowlisted storage guidance suitable for desktop status and stderr.
pub(super) fn local_failure_message(error: &anyhow::Error) -> Option<&'static str> {
    class_failure_message(capture_error_class(error))
}

/// The guidance for a class, so a verdict read back from a report renders the
/// same sentence as the error it came from.
fn class_failure_message(class: &str) -> Option<&'static str> {
    match class {
        "database_corrupt" => Some("The local history database needs repair. Preserve the database before recovery; reconnecting will not repair it."),
        "disk_full" => Some("The local disk is full. Free disk space to resume session uploads."),
        "database_busy" => Some("Local history is busy. Agent Relay will retry when the other operation finishes."),
        "database_unavailable" => Some("Agent Relay cannot open local history. Check that its directory exists and local file permissions allow access."),
        "permission_denied" => Some("Agent Relay cannot access local history. Check local file permissions."),
        "upload_preparation_failed" => Some("Agent Relay could not prepare local history for upload. It keeps retrying; update Agent Relay if uploads stay stuck."),
        "delivery_conflict" => Some("History delivery conflict: receiver-rejected records are quarantined or await validated conflict details. Inspect delivery status; other records remain queued."),
        _ => None,
    }
}

/// The last verdict on each side of a pass: the stable class of that outcome,
/// `None` where it succeeded.
#[derive(Default, Clone)]
struct Verdicts {
    capture: Option<String>,
    delivery: Option<String>,
    /// The collector run that observed them, whose `startup_id` the report
    /// carries: `status` shows only the live run's report.
    run: Option<String>,
}
impl Verdicts {
    #[cfg(test)]
    fn capture(result: &Result<()>) -> Self {
        Self {
            capture: verdict(result),
            delivery: None,
            run: None,
        }
    }
    /// The one class the desktop acts on: a capture fault first, because it
    /// names a local condition, then a delivery fault.
    fn effective(&self) -> Option<&str> {
        self.capture.as_deref().or(self.delivery.as_deref())
    }
}

/// Classify one side's result into its public label.
fn verdict(result: &Result<()>) -> Option<String> {
    result
        .as_ref()
        .err()
        .map(|error| capture_error_class(error).to_owned())
}

/// The sentence for a class.
fn class_message(class: Option<&str>) -> Option<String> {
    class.map(|class| {
        class_failure_message(class)
            .unwrap_or("Sync paused or offline. Retrying; local data remains queued.")
            .to_owned()
    })
}

/// Build the advisory cycle status from typed classes without including
/// provider data. `capture` and `delivery` carry each side; the top-level
/// fields are the effective verdict, which is what the desktop shows.
fn cycle_report(verdicts: &Verdicts) -> serde_json::Value {
    let side = |class: Option<&str>| json!({"ok": class.is_none(), "error_class": class, "message": class_message(class)});
    let effective = verdicts.effective();
    json!({
        "at_ms": now(), "startup_id": verdicts.run, "ok": effective.is_none(),
        "error_class": effective,
        "message": class_message(effective),
        "capture": side(verdicts.capture.as_deref()),
        "delivery": side(verdicts.delivery.as_deref()),
    })
}

/// The capture verdict the last report of run `run` holds. Another run's
/// verdict describes a capture this run has not made, and a report that
/// cannot be read carries none: the next capture pass re-establishes it.
fn saved_capture_verdict(directory: &Path, run: &str) -> Option<String> {
    fs::read(directory.join("cycle.json"))
        .ok()
        .and_then(|data| serde_json::from_slice::<serde_json::Value>(&data).ok())
        .filter(|report| report["startup_id"] == run)
        .and_then(|report| report["capture"]["error_class"].as_str().map(str::to_owned))
}

/// The last report, if the collector run `runtime.json` names wrote it. A
/// report from an earlier run, including one from before reports named their
/// run, says nothing about the collector now running, whose first capture
/// pass may take many minutes on a large history.
pub(super) fn current_cycle_report(directory: &Path) -> Option<serde_json::Value> {
    let read = |name: &str| {
        fs::read(directory.join(name))
            .ok()
            .and_then(|data| serde_json::from_slice::<serde_json::Value>(&data).ok())
    };
    let run = read("runtime.json")?["startup_id"].as_str()?.to_owned();
    read("cycle.json").filter(|report| report["startup_id"] == run.as_str())
}

/// What the drains of one pass moved, and the queue they left: content-free
/// counts, bytes and durations for the pass report. Drains record into the
/// thread that ran them, which is the thread that reports the pass, and the
/// report takes what they recorded.
#[derive(Default)]
struct PassMetrics {
    drains: u64,
    drain: worker::DrainMetrics,
    /// The queue after the pass's last drain.
    pending_records: i64,
    unqueued_changes: i64,
    oldest_pending_age_ms: Option<i64>,
    /// Whether that queue still holds work a pass can move now.
    backlog: bool,
}
thread_local! {
    static PASS_METRICS: std::cell::RefCell<Option<PassMetrics>> = const { std::cell::RefCell::new(None) };
}
impl PassMetrics {
    fn record(drain: &worker::DrainMetrics, status: &delivery::DeliveryStatus) {
        PASS_METRICS.with(|pass| {
            let mut pass = pass.borrow_mut();
            let pass = pass.get_or_insert_with(PassMetrics::default);
            pass.drains += 1;
            pass.drain.add(drain);
            pass.pending_records = status.pending_records;
            pass.unqueued_changes = status.unqueued_changes;
            pass.oldest_pending_age_ms = status
                .oldest_pending_ms
                .map(|oldest| now().saturating_sub(oldest).max(0));
            pass.backlog = has_backlog(status);
        });
    }
    /// What this thread's drains recorded since the last take, if any ran.
    fn take() -> Option<PassMetrics> {
        PASS_METRICS.with(|pass| pass.borrow_mut().take())
    }
    fn report(&self) -> serde_json::Value {
        let drain = &self.drain;
        let per_second = |count: u64| {
            (drain.elapsed_ms > 0)
                .then(|| ((count as f64) * 1_000.0 / drain.elapsed_ms as f64 * 10.0).round() / 10.0)
        };
        json!({
            "drains": self.drains,
            "drain_ms": drain.elapsed_ms,
            "batches_sent": drain.batches_sent,
            "bytes_sent": drain.bytes_sent,
            "batches_acknowledged": drain.batches_acknowledged,
            "records_acknowledged": drain.records_acknowledged,
            "batches_per_second": per_second(drain.batches_acknowledged),
            "records_per_second": per_second(drain.records_acknowledged),
            "send_ms_total": drain.send_ms_total,
            "send_ms_mean": (drain.batches_sent > 0).then(|| drain.send_ms_total / drain.batches_sent),
            "send_ms_max": drain.send_ms_max,
            "queue_ms_max": drain.queue_ms_max,
            "event_lag_ms": drain.event_lag_ms,
            "in_flight_limit": DELIVERY_CONCURRENCY,
            "max_in_flight": drain.max_in_flight,
            "batches_retried": drain.batches_retried,
            "pending_records": self.pending_records,
            "unqueued_changes": self.unqueued_changes,
            "oldest_pending_age_ms": self.oldest_pending_age_ms,
        })
    }
}

/// Persist advisory status without interrupting retries when either status or logs cannot be written.
/// A pass that ran a drain reports what it moved as `delivery_metrics`.
fn write_cycle_report(
    directory: &Path,
    verdicts: &Verdicts,
    metrics: Option<&PassMetrics>,
    diagnostics: impl Write,
) {
    write_report(directory, verdicts, metrics, None, diagnostics)
}
/// [`write_cycle_report`], with the capture thread's `capture_metrics` when
/// it runs beside the delivery loop.
fn write_report(
    directory: &Path,
    verdicts: &Verdicts,
    metrics: Option<&PassMetrics>,
    capture: Option<serde_json::Value>,
    mut diagnostics: impl Write,
) {
    let mut report = cycle_report(verdicts);
    if let Some(metrics) = metrics {
        report["delivery_metrics"] = metrics.report();
    }
    if let Some(capture) = capture {
        report["capture_metrics"] = capture;
    }
    if let Err(error) = save_status_json(&directory.join("cycle.json"), &report) {
        let message = local_failure_message(&error)
            .unwrap_or("Sync status could not be saved. Retrying; local data remains queued.");
        // collector.log may be on the same full disk. Logging must not panic
        // or propagate another I/O error out of the retry loop either.
        let _ = writeln!(diagnostics, "{message}");
    }
    if let Some(message) = report["message"].as_str() {
        let _ = writeln!(diagnostics, "{message}");
    }
}

/// Report one pass. A pass that only delivered observed nothing about
/// capture, so the last capture verdict stands.
fn persist_cycle_report(
    directory: &Path,
    run: &str,
    outcome: &PassOutcome,
    diagnostics: impl Write,
) {
    persist_pass_report(
        directory,
        run,
        outcome,
        PassMetrics::take().as_ref(),
        diagnostics,
    )
}
/// [`persist_cycle_report`] with the metrics the pass's drains recorded,
/// already taken.
fn persist_pass_report(
    directory: &Path,
    run: &str,
    outcome: &PassOutcome,
    metrics: Option<&PassMetrics>,
    diagnostics: impl Write,
) {
    let verdicts = Verdicts {
        capture: match &outcome.capture {
            Some(result) => verdict(result),
            None => saved_capture_verdict(directory, run),
        },
        delivery: verdict(&outcome.delivery),
        run: Some(run.to_owned()),
    };
    write_cycle_report(directory, &verdicts, metrics, diagnostics);
}
/// Report one delivery pass of the background loop. Capture runs on its own
/// thread: its last verdict and counts are the report's capture side, and
/// before it has finished a capture the run's last reported verdict stands.
fn persist_live_report(
    directory: &Path,
    run: &str,
    live: &super::live::Shared,
    delivery: &Result<()>,
    metrics: Option<&PassMetrics>,
    diagnostics: impl Write,
) {
    let verdicts = Verdicts {
        capture: live
            .verdict()
            .unwrap_or_else(|| saved_capture_verdict(directory, run)),
        delivery: verdict(delivery),
        run: Some(run.to_owned()),
    };
    write_report(directory, &verdicts, metrics, live.report(), diagnostics);
}

pub(super) fn capture_diagnostic(
    directory: &Path,
    stage: &str,
    started: Instant,
    captured: usize,
    failed: usize,
    error: Option<&anyhow::Error>,
) -> Result<()> {
    let diagnostic = json!({"operation":"capture","stage":stage,"elapsed_ms":started.elapsed().as_millis(),"sessions_captured":captured,"failures":failed,"error_class":error.map(capture_error_class)});
    let filename = match stage {
        "shallow_inventory" => "inventory-diagnostic.json",
        // Remote connector work keeps its own last-run record so it never
        // overwrites a capture or inventory failure.
        "remote_enumeration" | "remote_sweep" => "remote-diagnostic.json",
        _ => "capture-diagnostic.json",
    };
    save_status_json(&directory.join(filename), &diagnostic)?;
    if error.is_some() {
        eprintln!("{diagnostic}");
    }
    Ok(())
}

/// How many of the newest sessions selected setup catalogs before it reports
/// ready: the apps' first page of the session list (500) and as many again
/// for the subagents and child threads among them, which the list folds into
/// their sessions. A shallow read of metadata, as the pre-install preview's.
pub(super) const SETUP_CATALOG_LIMIT: usize = 1_000;

/// Selected setup captures nothing, but the session list reads the install's
/// own catalog, which the collector's inventory fills only once it runs, a
/// moment after the collector starts. One bounded shallow pass here lists the
/// newest sessions as soon as setup reports ready, so a fresh install's list
/// is never empty while its first inventory pass is due. Best effort: a
/// failure is reported in `inventory-diagnostic.json` and left to the
/// inventory, which discovers every session shortly after anyway.
pub fn catalog_for_setup(directory: &Path) {
    let started = Instant::now();
    let result = super::history::discover(
        &directory.join("history.db"),
        Some(SETUP_CATALOG_LIMIT),
        || false,
    );
    let _ = capture_diagnostic(
        directory,
        "shallow_inventory",
        started,
        result.as_ref().copied().unwrap_or(0),
        usize::from(result.is_err()),
        result.as_ref().err(),
    );
}

/// All/new setup has already captured before creating its baseline. Selected
/// setup stays shallow unless --once makes this the only capture opportunity.
pub fn finish_setup(directory: &Path, config: &Config, once: bool) -> Result<()> {
    retry_verdict_of_another_build(directory, &config.job_id, agent_relay_probe::VERSION)?;
    if once && super::bridge::mode(config) == super::bridge::SharingMode::Selected {
        cycle_with_stop(directory, config, Arc::new(AtomicBool::new(false)), true)?.result()
    } else {
        deliver_captured(directory, config, true)
    }
}

pub fn deliver_captured(directory: &Path, config: &Config, before_exit: bool) -> Result<()> {
    deliver_captured_with_stop(directory, config, before_exit, &AtomicBool::new(false))
}
fn deliver_captured_with_stop(
    directory: &Path,
    config: &Config,
    before_exit: bool,
    cancelled: &AtomicBool,
) -> Result<()> {
    if stopping(cancelled) {
        return Ok(());
    }
    deliver_captured_on(
        directory,
        config,
        before_exit,
        cancelled,
        &mut worker::DrainSession::open(&directory.join("history.db"))?,
    )
}
fn deliver_captured_on(
    directory: &Path,
    config: &Config,
    before_exit: bool,
    cancelled: &AtomicBool,
    session: &mut worker::DrainSession,
) -> Result<()> {
    if stopping(cancelled) {
        return Ok(());
    }
    // Every drain must apply selected-mode exclusions, including retries after
    // a failed capture. Never reach the delivery worker with an unvetted row.
    super::bridge::openclaw_upgrade::enforce_selection_from(
        session.connection()?,
        directory,
        config,
    )?;
    // One read of the job serves the whole pass's checks: a pause, the
    // destination and the saved configuration.
    {
        let conn = session.connection()?;
        let job = delivery::job_check(conn, &config.job_id)?;
        if job.state == "paused" {
            return Ok(());
        }
        ensure!(
            destination::selected_account(Some(&config.history_url))? == config.delivery_account,
            "wrong destination"
        );
        // The receiver rejects a batch whose account or mapping does not
        // match, but only once one exists. An idle generation pointed at
        // another destination must not look healthy, so the saved
        // configuration is checked outright.
        ensure!(
            job.config.account_id == config.delivery_account
                && job.config.mapping_version == destination::MAPPING_VERSION,
            "delivery config mismatch"
        );
        recover_authentication_of(&conn, directory, config, &job, || renew_session(config))?;
    }
    // The receiver blocks the job when an older managed uploader appears, but
    // its verdict is a generic permission refusal. Name the cause here first so
    // the user sees which uploader to stop instead of a reconnect suggestion.
    // The verdict is the receiver's own, inspected at most once a minute
    // however many passes run, so back-to-back passes do not each spawn the
    // scheduler commands.
    super::legacy_schedule_verdict(
        receiver_state().legacy_scheduler_state(),
        config.acknowledge_uninspected_schedules,
    )?;
    let progress = super::progress::Monitor::start(
        directory,
        &config.history_url,
        Some(&config.job_id),
        before_exit,
    );
    let result = deliver(session, config, cancelled);
    if before_exit {
        let connected =
            progress.finish_before_exit(result.is_ok(), super::progress::COMPLETION_TIMEOUT);
        if result.is_ok() {
            ensure!(connected, user_error("Cloud connection could not be confirmed. Check the endpoint and retry; local data remains queued."));
        }
    } else {
        progress.finish_with(result.is_ok(), result.as_ref().ok());
    }
    let status = result?;
    humanln!(
        "Probe connected: {} records received, {} queued.",
        status.acknowledged_records,
        status.pending_records
    );
    Ok(())
}
/// A job blocked because its `rth_*` session died resumes by itself when Agent
/// Relay's own sign-in can issue a new session, so an unattended machine does
/// not need anyone to log in again. Otherwise the job stays blocked on
/// `authentication_required`, and why renewal failed is kept in
/// `renewal.json` for `status --json` to report.
#[cfg(test)]
fn recover_authentication(
    conn: &Connection,
    directory: &Path,
    config: &Config,
    renew: impl FnOnce() -> Result<Renewal>,
) -> Result<()> {
    let job = delivery::job_check(conn, &config.job_id)?;
    recover_authentication_of(conn, directory, config, &job, renew)
}
/// [`recover_authentication`] for the job the pass already read.
fn recover_authentication_of(
    conn: &Connection,
    directory: &Path,
    config: &Config,
    job: &delivery::JobCheck,
    renew: impl FnOnce() -> Result<Renewal>,
) -> Result<()> {
    if job.state != "blocked" || job.failure.as_deref() != Some("authentication_required") {
        return Ok(());
    }
    match renew() {
        Ok(Renewal::Renewed(_)) => {
            // The receiver kept the dead session between passes.
            receiver_state().forget_session();
            record_renewal_failure(directory, None);
            delivery::retry_job(conn, &config.job_id)?;
        }
        Ok(Renewal::Busy) => {}
        Ok(Renewal::Failed(failure)) => {
            // Logged once per cause, not on every pass that finds it.
            if record_renewal_failure(directory, Some(failure)) {
                let _ = writeln!(std::io::stderr(), "{}", renewal_failure_message(failure));
            }
        }
        // Keep diagnostics free of URLs, credentials and response bodies.
        Err(_) => {
            let _ = writeln!(
                std::io::stderr(),
                "Upload sign-in could not be renewed from Agent Relay. Sign in again to resume uploads."
            );
        }
    }
    Ok(())
}
/// Why the last renewal failed, while it stands.
const RENEWAL_REPORT: &str = "renewal.json";
/// The failure the last renewal recorded; `None` after one succeeded.
pub(super) fn renewal_failure(directory: &Path) -> Option<RenewalFailure> {
    let report: serde_json::Value =
        serde_json::from_slice(&fs::read(directory.join(RENEWAL_REPORT)).ok()?).ok()?;
    RenewalFailure::parse(report["failure"].as_str()?)
}
/// Records `failure` (`None` clears it); `true` when it changed.
fn record_renewal_failure(directory: &Path, failure: Option<RenewalFailure>) -> bool {
    if renewal_failure(directory) == failure {
        return false;
    }
    match failure {
        Some(failure) => {
            let _ = save_json(
                &directory.join(RENEWAL_REPORT),
                &json!({"failure": failure.code(), "at_ms": now()}),
            );
        }
        None => {
            let _ = fs::remove_file(directory.join(RENEWAL_REPORT));
        }
    }
    true
}
/// What a person reads for a renewal failure: a fixed sentence per cause.
pub(super) fn renewal_failure_message(failure: RenewalFailure) -> &'static str {
    match failure {
        RenewalFailure::NoCloudSession => {
            "Uploads need you to sign in to Agent Relay again. Queued records are preserved."
        }
        RenewalFailure::CloudRefused => {
            "Agent Relay Cloud refused to renew the upload sign-in. Check your workspace access, then sign in again. Queued records are preserved."
        }
        RenewalFailure::CloudUnreachable => {
            "Agent Relay Cloud is unreachable or busy, so the upload sign-in could not be renewed. Agent Relay will retry. Queued records are preserved."
        }
        RenewalFailure::WrongDestination => {
            "Agent Relay Cloud renewed the upload sign-in for another workspace. Connect this computer again. Queued records are preserved."
        }
    }
}
/// What the RelayHistory receiver keeps across this process's passes: its
/// stage session, its legacy scheduler verdict and the batch limits the
/// server last published. Kept for the process rather than per pass, so
/// back-to-back passes neither reread the session nor inspect the
/// schedulers each time, and batches stay sized to the published limits.
fn receiver_state() -> &'static destination::ReceiverState {
    static STATE: std::sync::OnceLock<destination::ReceiverState> = std::sync::OnceLock::new();
    STATE.get_or_init(destination::ReceiverState::default)
}
/// Least gap between asking Cloud to renew, so a Cloud that keeps refusing
/// is not asked on every pass. Finding no sign-in, or another process
/// rotating the session, asks nothing, so neither starts the gap: a session
/// the core has just refreshed renews on the next pass.
const RENEWAL_INTERVAL: Duration = Duration::from_secs(5 * 60);
fn renew_session(config: &Config) -> Result<Renewal> {
    static LAST_ASKED: std::sync::Mutex<Option<Instant>> = std::sync::Mutex::new(None);
    let api_url = cloud::cloud_api_url(Some(&format!("{}/cloud", config.site_url)))?;
    let Some(bearer) = cloud::renewal_bearer(&api_url) else {
        return Ok(Renewal::Failed(RenewalFailure::NoCloudSession));
    };
    ask_at_most_every(&LAST_ASKED, RENEWAL_INTERVAL, || {
        cloud::renew_workspace_session(
            &api_url,
            &bearer,
            &config.workspace_id,
            &config.history_url,
            &config.org_id,
        )
    })
}
/// Runs `ask` unless Cloud was last asked within `interval`; a `Busy`
/// answer asked nothing, so it leaves the last time as it was.
fn ask_at_most_every(
    last_asked: &std::sync::Mutex<Option<Instant>>,
    interval: Duration,
    ask: impl FnOnce() -> Result<Renewal>,
) -> Result<Renewal> {
    let mut last = last_asked.lock().unwrap_or_else(|e| e.into_inner());
    if last.is_some_and(|at| at.elapsed() < interval) {
        return Ok(Renewal::Busy);
    }
    let renewal = ask()?;
    if !matches!(renewal, Renewal::Busy) {
        *last = Some(Instant::now());
    }
    Ok(renewal)
}
pub fn print_status(directory: &Path) -> Result<()> {
    humanln!(
        "{}",
        if running(directory)? {
            "Probe is running."
        } else {
            "Probe is stopped."
        }
    );
    Ok(())
}
pub fn stop(directory: &Path) -> Result<()> {
    stop_with_timeout(directory, Some(Duration::from_secs(45)), None)
}
pub fn stop_for_change(directory: &Path) -> Result<()> {
    // A sharing command must either restart the collector itself or keep
    // waiting; returning with a durable stop request would strand uploads.
    stop_with_timeout(directory, None, None)
}
pub fn stop_for_replacement(directory: &Path) -> Result<()> {
    stop_for_replacement_with_timeout_and_handoff(
        directory,
        REPLACEMENT_STOP_TIMEOUT,
        &spawn_replacement_handoff,
    )
}
fn stop_for_replacement_with_timeout_and_handoff(
    directory: &Path,
    timeout: Duration,
    handoff: &dyn Fn(&Path, &str) -> Result<()>,
) -> Result<()> {
    stop_with_timeout(directory, Some(timeout), Some(handoff))
}
fn stop_with_timeout(
    directory: &Path,
    timeout: Option<Duration>,
    replacement_handoff: Option<&ReplacementHandoff<'_>>,
) -> Result<()> {
    if !running(directory)? {
        humanln!("Probe is stopped.");
        return Ok(());
    }
    let runtime: serde_json::Value =
        serde_json::from_slice(&fs::read(directory.join("runtime.json"))?)?;
    let startup_id = runtime["startup_id"]
        .as_str()
        .context("missing run identity")?;
    save_json(
        &directory.join("stop.json"),
        &json!({"startup_id":startup_id}),
    )?;
    let deadline = timeout.map(|duration| Instant::now() + duration);
    loop {
        if !running(directory)? {
            humanln!("Probe stopped.");
            return Ok(());
        }
        if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
            if let Some(handoff) = replacement_handoff {
                handoff(directory, startup_id)?;
                return Err(user_error(
                    "Uploader replacement is taking longer than expected. It will continue safely in the background.",
                ));
            }
            return Err(user_error(
                "Stop was requested. The probe is finishing its current capture operation.",
            ));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn spawn_replacement_handoff(directory: &Path, startup_id: &str) -> Result<()> {
    let executable = std::env::current_exe()?;
    // The old collector still owns its streams. Rotating from this process
    // would strand them on the renamed file until it exits.
    let log = append_log(directory)?;
    let mut command = Command::new(executable);
    command
        .arg("complete-replacement")
        .arg("--directory")
        .arg(directory)
        .arg("--startup-id")
        .arg(startup_id)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log.try_clone()?))
        .stderr(Stdio::from(log));
    // A session of its own (Unix `setsid`; on Windows a console process
    // group and no window), so it outlives the collector it replaces.
    agent_relay_probe::platform::process::new_session(&mut command);
    command.spawn()?;
    Ok(())
}
pub(super) fn stop_requested(directory: &Path, startup_id: &str) -> bool {
    let matched = fs::read(directory.join("stop.json"))
        .ok()
        .and_then(|data| serde_json::from_slice::<serde_json::Value>(&data).ok())
        .is_some_and(|value| value["startup_id"] == startup_id);
    STOP.load(Ordering::Relaxed) || matched
}
/// True only while another build's live collector has received its own,
/// generation-scoped stop request. This distinguishes an update replacement
/// from an arbitrary stale stop file.
pub(super) fn replacement_in_progress(directory: &Path) -> bool {
    if !outdated(directory) || !running(directory).unwrap_or(false) {
        return false;
    }
    let Ok(control) = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(directory.join("desktop.lock"))
    else {
        return false;
    };
    if fs2::FileExt::try_lock_exclusive(&control).is_ok() {
        return false;
    }
    fs::read(directory.join("runtime.json"))
        .ok()
        .and_then(|data| serde_json::from_slice::<serde_json::Value>(&data).ok())
        .and_then(|runtime| runtime["startup_id"].as_str().map(str::to_owned))
        .is_some_and(|startup_id| stop_requested(directory, &startup_id))
}
#[cfg(unix)]
extern "C" fn stop_signal(_: libc::c_int) {
    STOP.store(true, Ordering::Relaxed);
}
/// Windows' stand-in for SIGTERM/SIGINT: Ctrl+C, Ctrl+Break, closing the
/// console and logoff or shutdown only set the stop flag, and returning
/// true keeps the default handler from ending the process before the loop
/// cleans up. A detached collector has no console, so `stop.json` remains
/// its usual stop.
#[cfg(windows)]
unsafe extern "system" fn stop_console_event(_: u32) -> windows_sys::core::BOOL {
    STOP.store(true, Ordering::Relaxed);
    1
}
/// A blocked job holds the verdict of the probe build that reached it, and a
/// different build can judge the same exchange differently — a receipt it now
/// parses, say. The first run under each new build retries a blocked job once;
/// later runs of that build leave its own verdicts alone.
/// The database records the build atomically with the retry, including across
/// detached collectors and restarts when the legacy file marker is unwritable.
fn retry_verdict_of_another_build(directory: &Path, job_id: &str, version: &str) -> Result<()> {
    let marker = directory.join("verdict-retry.json");
    let retried = fs::read(&marker)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        // Unscoped files cannot prove which generation used the retry. In
        // particular, disconnect/reconnect reuses this directory for a new job.
        .filter(|value| value["job_id"].as_str() == Some(job_id))
        .and_then(|value| value["probe_version"].as_str().map(str::to_owned));
    let conn = delivery::open_db(&directory.join("history.db"))?;
    if delivery::retry_job_for_build(&conn, job_id, version, retried.as_deref()).is_err() {
        // This recovery is optional. Its transaction rolls back both the retry
        // and build record on failure, so collection can continue safely.
        let _ = writeln!(
            std::io::stderr(),
            "Automatic probe recovery was deferred. Collection will continue."
        );
        return Ok(());
    }
    // Maintain the older marker for probes that do not yet read retry_build.
    if save_json(
        &marker,
        &json!({ "job_id": job_id, "probe_version": version }),
    )
    .is_err()
    {
        // Keep diagnostics free of paths, credentials and raw filesystem errors.
        let _ = writeln!(
            std::io::stderr(),
            "Probe retry file could not be saved. Retry state is stored in the database."
        );
    }
    Ok(())
}

/// Own the collector lock and retry capture/delivery until stopped; status writes are advisory.
pub fn run_background(directory: &Path, startup_id: &str) -> Result<()> {
    let _lock = lock(directory)?;
    let _log_watch = LogWatch::start(directory, STREAMS);
    ensure!(
        !directory.join("sharing-change.json").exists()
            && !directory.join("session-reset-pending.json").exists(),
        user_error("A sharing update is incomplete. Run start to recover it before retrying.")
    );
    let config = read_config(directory)?;
    std::env::set_var("RELAYHISTORY_HOME", directory);
    #[cfg(unix)]
    unsafe {
        // Handlers only store an atomic flag. Network/capture cleanup happens in
        // the normal loop, outside the signal handler.
        libc::signal(
            libc::SIGTERM,
            stop_signal as *const () as libc::sighandler_t,
        );
        libc::signal(libc::SIGINT, stop_signal as *const () as libc::sighandler_t);
    }
    // SAFETY: the handler only stores an atomic flag.
    #[cfg(windows)]
    unsafe {
        windows_sys::Win32::System::Console::SetConsoleCtrlHandler(Some(stop_console_event), 1);
    }
    // Readiness means this run owns the lock and its retry loop is live, not
    // that a cycle has finished. Capture and drain are unbounded in the size of
    // local history, so announcing readiness afterwards lets a supervisor's
    // startup wait expire and kill a collector that is working normally. Setup
    // already completed one cycle before spawning this process. Opening the
    // store below migrates one an older build wrote, which on a large store
    // outlasts that wait too, so readiness comes first.
    save_json(
        &directory.join("runtime.json"),
        &json!({"startup_id":startup_id,"pid":std::process::id(),"ready":true,"version":agent_relay_probe::VERSION}),
    )?;
    let stop = StopWatch::start(directory, startup_id);
    // Opening the store migrates it, and a migration can fail after readiness
    // was announced: a full disk, a damaged store. The run stays up, reports
    // the classified failure as its own and retries, so the desktop shows the
    // cause instead of restarting an uploader that exits while starting.
    while !stopping(&stop.cancelled) {
        let Err(error) =
            retry_verdict_of_another_build(directory, &config.job_id, agent_relay_probe::VERSION)
        else {
            // The store opens: this run reports at once, before capture or
            // delivery has run. The startup sweep runs beside the first
            // delivery pass and can hold the store's write lock for long
            // stretches, so the first pass's own report can come late, or
            // never if a stop arrives first; the run must not be left with no
            // report of its own, or with a failure to open it has outgrown.
            // Nothing has been observed yet, so the report carries no fault
            // and no capture verdict.
            let opened = PassOutcome::delivery_only(Ok(()));
            persist_cycle_report(directory, startup_id, &opened, std::io::stderr());
            break;
        };
        let outcome = PassOutcome::delivery_only(Err(error));
        persist_cycle_report(directory, startup_id, &outcome, std::io::stderr());
        let deadline = Instant::now() + pass_interval(false, false);
        while !stopping(&stop.cancelled) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    let live = Arc::new(super::live::Shared::default());
    // Selected mode reads no provider for capture, so the catalog the
    // session list offers is kept apart from delivery. Each pass tells the
    // capture thread, whose members in a shared database move with the rows
    // a pass refreshes.
    let _inventory =
        (super::bridge::mode(&config) == super::bridge::SharingMode::Selected).then(|| {
            let catalogued = live.clone();
            super::inventory::start(
                directory,
                stop.cancelled.clone(),
                super::inventory::InventoryOptions::default(),
                move || catalogued.catalogued(),
            )
        });
    // Capture runs on its own thread from the start, so the first delivery
    // pass reports within seconds while the first sweep of a large history
    // takes minutes beside it, and a backlog never delays live capture.
    let capture = super::live::start(
        directory,
        &config,
        stop.cancelled.clone(),
        live.clone(),
        super::live::LiveOptions::default(),
    );
    deliver_until_stopped(directory, startup_id, &config, &stop.cancelled, &live);
    // The capture thread ends on the same stop request, after its in-flight
    // sweep; the collector lock is released only once it has.
    drop(capture);
    save_json(
        &directory.join("runtime.json"),
        &json!({"startup_id":startup_id,"pid":std::process::id(),"ready":false,"version":agent_relay_probe::VERSION}),
    )?;
    Ok(())
}
/// The delivery loop: one bounded pass at a time, woken early by the capture
/// thread when local history gained something to deliver. A pass that moved
/// a backlog is followed at once; otherwise the next waits for the capture
/// thread's wake or the pass interval, whichever comes first.
fn deliver_until_stopped(
    directory: &Path,
    startup_id: &str,
    config: &Config,
    cancelled: &Arc<AtomicBool>,
    live: &super::live::Shared,
) {
    let mut session: Option<worker::DrainSession> = None;
    while !stopping(cancelled) {
        // Whatever the capture thread wrote before this pass, the pass reads.
        live.clear();
        let delivery = (|| {
            if session.is_none() {
                session = Some(worker::DrainSession::open(&directory.join("history.db"))?);
            }
            deliver_captured_on(
                directory,
                config,
                false,
                cancelled,
                session.as_mut().context("delivery session unavailable")?,
            )
        })();
        // A user stop is not a failed/offline cycle and must not start delivery.
        if stopping(cancelled) {
            break;
        }
        let metrics = PassMetrics::take();
        persist_live_report(
            directory,
            startup_id,
            live,
            &delivery,
            metrics.as_ref(),
            std::io::stderr(),
        );
        // Between passes, never beside one: the rewrite holds the store's
        // write lock for its whole length.
        if live.take_compact_due() {
            super::live::compact_store(directory, &directory.join("history.db"));
        }
        // The pass's last drain already read the queue it left; only a pass
        // that ran none reads it again.
        let backlog = match &metrics {
            Some(metrics) => metrics.backlog,
            None => backlog_pending(directory, config),
        };
        let moved = delivery.is_ok()
            && metrics
                .as_ref()
                .is_some_and(|metrics| metrics.drain.batches_acknowledged > 0);
        live.wait(Instant::now() + pass_interval(backlog, moved), || {
            stopping(cancelled)
        });
    }
}
/// Whether the active job still has work a further pass can move: batches
/// queued for delivery, feed changes not yet examined, or an unfinished
/// bootstrap or member backfill. A paused job has nothing to move, whatever it holds,
/// and neither has one waiting out a retry deadline: the next pass before that
/// deadline does the same round of local work and reaches the same idle drain.
fn backlog_pending(directory: &Path, config: &Config) -> bool {
    let status = delivery::open_db_readonly(&directory.join("history.db"))
        .and_then(|conn| delivery::status(&conn, &config.job_id));
    status.is_ok_and(|status| has_backlog(&status))
}
/// [`backlog_pending`] for a status already read.
fn has_backlog(status: &delivery::DeliveryStatus) -> bool {
    status.state == "active"
        && status.next_attempt_ms <= now()
        && (status.pending_records > 0 || status.unqueued_changes > 0 || !status.bootstrap_complete)
}
/// The gap between two delivery passes: none while a backlog is moving, so
/// delivery drains it back to back; short while there is backlog the last
/// pass could not move (a pass that failed or acknowledged nothing), so a
/// stuck pass does not spin; and long once caught up. A job waiting out a
/// retry deadline has no backlog it can move.
fn pass_interval(backlog: bool, moved: bool) -> Duration {
    match (backlog, moved) {
        (true, true) => Duration::ZERO,
        (true, false) => BACKLOG_PASS_INTERVAL,
        (false, _) => IDLE_PASS_INTERVAL,
    }
}
/// The collector's log, which a detached collector writes through its stdout
/// and stderr.
pub(super) const LOG: &str = "collector.log";
/// The size at which `collector.log` rotates.
const LOG_CAP: u64 = 10 * 1024 * 1024;
/// How many rotated logs are kept beside `collector.log`: `collector.log.1`
/// is the newest, and the oldest is dropped by the next rotation.
pub(super) const LOG_KEEP: usize = 3;
/// Rotation must keep running while capture, delivery or shutdown is blocked.
/// A check can overshoot the cap by the output written during this interval.
const LOG_CHECK_INTERVAL: Duration = Duration::from_secs(1);
struct LogWatch {
    finish: mpsc::Sender<()>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl LogWatch {
    fn start(directory: &Path, streams: [i32; 2]) -> Self {
        let directory = directory.to_owned();
        let (finish, receive) = mpsc::channel();
        let thread = std::thread::spawn(move || loop {
            keep_log_under_cap(&directory, &streams);
            match receive.recv_timeout(LOG_CHECK_INTERVAL) {
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                _ => break,
            }
        });
        Self {
            finish,
            thread: Some(thread),
        }
    }
}
impl Drop for LogWatch {
    fn drop(&mut self) {
        let _ = self.finish.send(());
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
pub(super) fn rotated_log(directory: &Path, generation: usize) -> std::path::PathBuf {
    directory.join(format!("{LOG}.{generation}"))
}
/// Rotate `collector.log` once it has reached `LOG_CAP`. Returns whether it
/// rotated.
fn rotate_log(directory: &Path) -> std::io::Result<bool> {
    match fs::metadata(directory.join(LOG)) {
        Ok(metadata) if metadata.len() >= LOG_CAP => {}
        Ok(_) => return Ok(false),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error),
    }
    for generation in (1..LOG_KEEP).rev() {
        let older = rotated_log(directory, generation);
        if older.exists() {
            fs::rename(older, rotated_log(directory, generation + 1))?;
        }
    }
    fs::rename(directory.join(LOG), rotated_log(directory, 1))?;
    Ok(true)
}
/// `collector.log`, private, opened for appending.
fn append_log(directory: &Path) -> Result<fs::File> {
    let log = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(directory.join(LOG))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        log.set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    Ok(log)
}
/// `collector.log` for a process about to write to it, rotated first if full.
/// A log that cannot rotate is still written: losing lines to a full log is
/// better than an uploader that cannot start.
fn open_log(directory: &Path) -> Result<fs::File> {
    let _ = rotate_log(directory);
    append_log(directory)
}
/// Keep a running collector's log under `LOG_CAP`. The collector writes
/// through `streams`, its stdout and stderr, so renaming the log alone would
/// leave it appending to the rotated file: every stream that was the full log
/// is pointed at a fresh one. Advisory, like every other log write.
fn keep_log_under_cap(directory: &Path, streams: &[i32]) {
    #[cfg(unix)]
    {
        use std::os::fd::{AsRawFd, BorrowedFd};
        use std::os::unix::fs::MetadataExt;
        let Ok(full) = fs::metadata(directory.join(LOG)) else {
            return;
        };
        if full.len() < LOG_CAP {
            return;
        }
        let writing_full_log = |stream: i32| {
            // SAFETY: the stream is only duplicated here, never closed.
            unsafe { BorrowedFd::borrow_raw(stream) }
                .try_clone_to_owned()
                .map(fs::File::from)
                .and_then(|file| file.metadata())
                .is_ok_and(|open| open.dev() == full.dev() && open.ino() == full.ino())
        };
        let redirect: Vec<i32> = streams
            .iter()
            .copied()
            .filter(|stream| writing_full_log(*stream))
            .collect();
        if redirect.is_empty() || !rotate_log(directory).unwrap_or(false) {
            return;
        }
        let Ok(fresh) = append_log(directory) else {
            return;
        };
        for stream in redirect {
            // SAFETY: dup2 atomically replaces an open descriptor this
            // process owns with another it owns.
            unsafe {
                libc::dup2(fresh.as_raw_fd(), stream);
            }
        }
    }
    #[cfg(not(unix))]
    {
        // An open file cannot be renamed here; the next start rotates it.
        let _ = (directory, streams);
    }
}
/// A detached collector's stdout and stderr.
const STREAMS: [i32; 2] = [1, 2];

/// The Mac app bundles a hard link to its core as `<core> (Sessions)`, so
/// Activity Monitor tells the collector apart from the relay core. A link,
/// not a symlink: the process takes the name it was started by.
const SESSIONS_SUFFIX: &str = " (Sessions)";

/// The executable a detached collector runs as: the bundle's Sessions link
/// beside `executable` when there is one, otherwise `executable` itself.
fn collector_executable(executable: PathBuf) -> PathBuf {
    let Some(name) = executable.file_name().and_then(|name| name.to_str()) else {
        return executable;
    };
    if name.ends_with(SESSIONS_SUFFIX) {
        return executable;
    }
    let sessions = executable.with_file_name(format!("{name}{SESSIONS_SUFFIX}"));
    if sessions.is_file() {
        sessions
    } else {
        executable
    }
}

pub fn start_background(directory: &Path) -> Result<()> {
    let executable = collector_executable(std::env::current_exe()?);
    let startup_id = format!("{}-{}", std::process::id(), now());
    let mut log = open_log(directory)?;
    writeln!(log, "Starting Agent Relay Probe")?;
    let mut command = Command::new(executable);
    command
        .arg("run")
        .arg("--directory")
        .arg(directory)
        .arg("--startup-id")
        .arg(&startup_id)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log.try_clone()?))
        .stderr(Stdio::from(log));
    // Detached from this terminal: `setsid` on Unix; on Windows a console
    // process group of its own and no window.
    agent_relay_probe::platform::process::new_session(&mut command);
    let mut child = command.spawn()?;
    let deadline = Instant::now() + Duration::from_secs(60);
    while Instant::now() < deadline {
        if child.try_wait()?.is_some() {
            return Err(user_error(
                "Probe stopped during startup. Run setup in --foreground to retry.",
            ));
        }
        let ready = fs::read(directory.join("runtime.json"))
            .ok()
            .and_then(|data| serde_json::from_slice::<serde_json::Value>(&data).ok())
            .is_some_and(|value| value["startup_id"] == startup_id && value["ready"] == true);
        if ready {
            humanln!("Probe is running in the background. You can close this terminal.");
            humanln!("Run setup again after restarting the computer.");
            let config = read_config(directory)?;
            humanln!(
                "Stop: agent-relay-probe stop --site-url {} --workspace {} --account {}",
                config.site_url,
                config.workspace_id,
                config.account_id
            );
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    if child.try_wait()?.is_none() {
        child.kill()?;
        child.wait()?;
    }
    Err(user_error("Probe startup timed out. Run setup again."))
}
#[cfg(test)]
mod tests {
    use super::claims::release;
    use super::*;
    use fs2::FileExt;

    #[test]
    fn the_collector_runs_as_the_bundled_sessions_link_when_there_is_one() {
        let dir = tempfile::tempdir().unwrap();
        let core = dir.path().join("Agent Relay Helper");
        fs::write(&core, b"core").unwrap();
        // ~/.local/bin/agent-relay-probe and the Linux core have no link.
        assert_eq!(collector_executable(core.clone()), core);

        let sessions = dir.path().join("Agent Relay Helper (Sessions)");
        fs::hard_link(&core, &sessions).unwrap();
        assert_eq!(collector_executable(core), sessions);
        // A collector that starts its replacement keeps its own name.
        assert_eq!(collector_executable(sessions.clone()), sessions);
    }

    #[test]
    fn relayhistory_batches_outlast_the_receivers_database_timeout() {
        let options = delivery_options("test-job".into(), "test-worker".into());
        assert_eq!(options.request_timeout_ms, 150_000);
        assert_eq!(options.max_in_flight, DELIVERY_CONCURRENCY);
    }

    #[test]
    fn flush_requests_never_outlive_the_remaining_deadline() {
        let now = Instant::now();
        let options = deadline_options(
            "test-job".into(),
            "test-worker".into(),
            Duration::from_secs(15),
            now + Duration::from_millis(250),
        );
        assert!(options
            .max_elapsed
            .is_some_and(|value| value <= Duration::from_millis(250)));
        assert!(options.request_timeout_ms <= 250);
        assert_eq!(
            options.request_deadline,
            Some(now + Duration::from_millis(250))
        );

        let options = deadline_options(
            "test-job".into(),
            "test-worker".into(),
            Duration::from_secs(15),
            Instant::now() + Duration::from_nanos(1),
        );
        assert_eq!(options.max_elapsed, Some(Duration::from_millis(1)));
        assert_eq!(options.request_timeout_ms, 1);
    }

    fn fill_log(directory: &Path, bytes: u64) {
        let log = append_log(directory).unwrap();
        log.set_len(log.metadata().unwrap().len() + bytes).unwrap();
    }

    #[test]
    fn collector_log_rotates_at_its_cap_and_keeps_three_older_logs() {
        let dir = tempfile::tempdir().unwrap();
        let size = |path: std::path::PathBuf| fs::metadata(path).map(|m| m.len()).ok();
        // Under the cap, a new writer appends to the same log.
        fill_log(dir.path(), LOG_CAP - 1);
        writeln!(open_log(dir.path()).unwrap(), "under").unwrap();
        assert!(!rotated_log(dir.path(), 1).exists());
        for _ in 0..LOG_KEEP + 2 {
            fill_log(dir.path(), LOG_CAP);
            writeln!(open_log(dir.path()).unwrap(), "fresh").unwrap();
            assert!(size(dir.path().join(LOG)).unwrap() < LOG_CAP);
        }
        assert_eq!(fs::read_to_string(dir.path().join(LOG)).unwrap(), "fresh\n");
        for generation in 1..=LOG_KEEP {
            assert!(size(rotated_log(dir.path(), generation)).unwrap() >= LOG_CAP);
        }
        assert!(!rotated_log(dir.path(), LOG_KEEP + 1).exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_running_collector_moves_its_streams_to_the_fresh_log() {
        use std::os::fd::AsRawFd;
        let dir = tempfile::tempdir().unwrap();
        // The collector's stderr, as start_background hands it the log.
        let mut stream = append_log(dir.path()).unwrap();
        let other = tempfile::tempfile().unwrap();
        keep_log_under_cap(dir.path(), &[stream.as_raw_fd(), other.as_raw_fd()]);
        assert!(!rotated_log(dir.path(), 1).exists());

        fill_log(dir.path(), LOG_CAP);
        keep_log_under_cap(dir.path(), &[stream.as_raw_fd(), other.as_raw_fd()]);
        writeln!(stream, "after rotation").unwrap();
        assert_eq!(
            fs::read_to_string(dir.path().join(LOG)).unwrap(),
            "after rotation\n"
        );
        assert_eq!(
            fs::metadata(rotated_log(dir.path(), 1)).unwrap().len(),
            LOG_CAP
        );
        // A stream that is not the log is left where it was.
        assert_eq!(other.metadata().unwrap().len(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn collector_log_watch_rotates_without_delivery_and_bounds_retention() {
        use std::os::{
            fd::AsRawFd,
            unix::fs::{MetadataExt, PermissionsExt},
        };
        let dir = tempfile::tempdir().unwrap();
        let mut stdout = append_log(dir.path()).unwrap();
        let mut stderr = stdout.try_clone().unwrap();
        let watch = LogWatch::start(dir.path(), [stdout.as_raw_fd(), stderr.as_raw_fd()]);
        // No delivery pass runs. Both inherited streams must follow every
        // rotation, including when all backup slots have already been used.
        for generation in 0..LOG_KEEP + 2 {
            writeln!(stdout, "stdout {generation}").unwrap();
            writeln!(stderr, "stderr {generation}").unwrap();
            stdout.set_len(LOG_CAP).unwrap();
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                // Observe a completed rotation, not the transient descriptor
                // replacement while the watch thread runs dup2. A descriptor
                // that stays invalid still fails the same finite deadline.
                let output = stdout.metadata();
                let errors = stderr.metadata();
                let current = fs::metadata(dir.path().join(LOG));
                if output
                    .as_ref()
                    .ok()
                    .zip(errors.as_ref().ok())
                    .zip(current.as_ref().ok())
                    .is_some_and(|((output, errors), current)| {
                        [output, errors].into_iter().all(|stream| {
                            stream.dev() == current.dev()
                                && stream.ino() == current.ino()
                                && stream.len() < LOG_CAP
                        })
                    })
                {
                    break;
                }
                assert!(
                    Instant::now() < deadline,
                    "rotation waited for delivery: stdout={output:?}, stderr={errors:?}, current={current:?}"
                );
                std::thread::sleep(Duration::from_millis(10));
            }
        }
        drop(watch);
        writeln!(stdout, "fresh stdout").unwrap();
        writeln!(stderr, "fresh stderr").unwrap();
        assert_eq!(
            fs::read_to_string(dir.path().join(LOG)).unwrap(),
            "fresh stdout\nfresh stderr\n"
        );
        for generation in 1..=LOG_KEEP {
            let path = rotated_log(dir.path(), generation);
            let bytes = fs::read(&path).unwrap();
            let expected = LOG_KEEP + 2 - generation;
            assert!(bytes.starts_with(format!("stdout {expected}\nstderr {expected}\n").as_bytes()));
            assert_eq!(bytes.len() as u64, LOG_CAP);
            assert_eq!(
                fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), LOG_KEEP + 1);
        assert_eq!(
            fs::metadata(dir.path().join(LOG))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }

    #[cfg(unix)]
    #[test]
    fn collector_log_is_not_rotated_by_a_process_without_its_streams() {
        use std::os::fd::AsRawFd;
        let dir = tempfile::tempdir().unwrap();
        fill_log(dir.path(), LOG_CAP);
        let other = tempfile::tempfile().unwrap();
        keep_log_under_cap(dir.path(), &[other.as_raw_fd()]);
        assert_eq!(fs::metadata(dir.path().join(LOG)).unwrap().len(), LOG_CAP);
        assert!(!rotated_log(dir.path(), 1).exists());
    }

    #[test]
    fn selected_once_setup_hydrates_only_members_even_when_delivery_is_unavailable() {
        // Hydration validates source paths against configured provider roots.
        // Run alone in a subprocess so fixture roots cannot race other tests.
        const CHILD: &str = "RELAYHISTORY_TEST_SELECTED_ONCE_CHILD";
        if std::env::var_os(CHILD).is_none() {
            let output = Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "collector::tests::selected_once_setup_hydrates_only_members_even_when_delivery_is_unavailable", "--nocapture"])
                .env(CHILD, "1")
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            return;
        }
        let home = tempfile::tempdir().unwrap();
        std::env::set_var("HOME", home.path());
        std::env::set_var("USERPROFILE", home.path());
        std::env::set_var("CLAUDE_CONFIG_DIR", home.path().join(".claude"));
        let project = home.path().join(".claude/projects/synthetic");
        fs::create_dir_all(&project).unwrap();
        for session in ["selected", "private"] {
            let record = json!({"sessionId":session,"uuid":format!("u-{session}"),"type":"user","message":{"role":"user","content":"synthetic"},"timestamp":"2026-09-01T01:00:00Z"});
            fs::write(
                project.join(format!("{session}.jsonl")),
                format!("{record}\n"),
            )
            .unwrap();
        }
        let conn = agent_relay_probe::delivery::open_db(&home.path().join("history.db")).unwrap();
        super::super::history::discover(&home.path().join("history.db"), None, || false).unwrap();
        let job = delivery::create_session_job(&conn, &job_config(false), now()).unwrap();
        delivery::set_job_session(
            &conn,
            &job.job_id,
            &delivery::SessionIdentity {
                source: "claude".into(),
                session_id: "selected".into(),
            },
            true,
        )
        .unwrap();
        let config = Config {
            version: 1,
            site_url: "https://synthetic.invalid".into(),
            account_id: "account".into(),
            account_email: None,
            account_name: None,
            account_avatar_url: None,
            workspace_name: None,
            org_id: "org".into(),
            workspace_id: "workspace".into(),
            // Invalid URL fails before any credentials or transport can be used.
            history_url: "invalid synthetic URL".into(),
            delivery_account: job.config.account_id,
            job_id: job.job_id,
            include_existing: false,
            sharing_mode: Some(super::super::bridge::SharingMode::Selected),
            acknowledge_uninspected_schedules: false,
        };
        save_json(&home.path().join("config.json"), &config).unwrap();
        let events = || {
            conn.query_row("SELECT COUNT(*) FROM session_events", [], |r| {
                r.get::<_, usize>(0)
            })
            .unwrap()
        };
        assert_eq!(events(), 0);
        // Background setup stays shallow; the collector will hydrate later.
        assert!(finish_setup(home.path(), &config, false).is_err());
        assert_eq!(events(), 0);
        delivery::pause_job(&conn, &config.job_id).unwrap();
        finish_setup(home.path(), &config, true).unwrap();
        assert_eq!(events(), 0, "paused selected setup must not hydrate");
        delivery::resume_job(&conn, &config.job_id).unwrap();
        assert!(finish_setup(home.path(), &config, true).is_err());
        assert_eq!(
            events(),
            1,
            "selected --once must capture before returning the delivery error"
        );
        let session: String = conn
            .query_row("SELECT session_id FROM session_events", [], |r| r.get(0))
            .unwrap();
        assert_eq!(session, "selected");
        let diagnostic: serde_json::Value =
            serde_json::from_slice(&fs::read(home.path().join("capture-diagnostic.json")).unwrap())
                .unwrap();
        assert_eq!(diagnostic["sessions_captured"], 1);
        assert_eq!(diagnostic["failures"], 0);
    }

    /// Selected setup lists the newest sessions in the install's own catalog
    /// before it reports ready, without reading any session's evidence.
    #[test]
    fn selected_setup_catalogs_sessions_without_capturing_them() {
        let Some(home) = super::super::live::tests::isolated_home(
            "collector::tests::selected_setup_catalogs_sessions_without_capturing_them",
        ) else {
            return;
        };
        let project = home.join(".claude/projects/setup");
        fs::create_dir_all(&project).unwrap();
        for session in ["first", "second"] {
            super::super::live::tests::append(
                &project.join(format!("{session}.jsonl")),
                &super::super::live::tests::transcript_line(session, "one"),
            );
        }
        let directory = home.join("probe");
        fs::create_dir_all(&directory).unwrap();
        catalog_for_setup(&directory);
        let store = super::super::history::open_read(&directory.join("history.db")).unwrap();
        let listed = super::super::history::catalog(&store, ai_hist::SessionScope::All, 500)
            .unwrap()
            .len();
        assert_eq!(listed, 2);
        let conn = agent_relay_probe::delivery::open_db(&directory.join("history.db")).unwrap();
        let events: usize = conn
            .query_row("SELECT COUNT(*) FROM session_events", [], |r| r.get(0))
            .unwrap();
        assert_eq!(events, 0, "setup reads metadata only");
    }

    #[test]
    fn selected_inventory_discovers_sessions_older_than_the_first_thousand() {
        let home = tempfile::tempdir().unwrap();
        let project = home.path().join(".claude/projects/synthetic");
        fs::create_dir_all(&project).unwrap();
        for n in 0..1001 {
            let path = project.join(format!("session-{n:04}.jsonl"));
            let record = json!({"sessionId":format!("session-{n:04}"),"uuid":format!("u-{n}"),"type":"user","message":{"role":"user","content":"synthetic"},"timestamp":"2026-09-01T01:00:00Z"});
            fs::write(&path, format!("{record}\n")).unwrap();
            fs::OpenOptions::new()
                .write(true)
                .open(&path)
                .unwrap()
                .set_times(
                    fs::FileTimes::new().set_modified(
                        std::time::SystemTime::UNIX_EPOCH + Duration::from_secs(n + 1),
                    ),
                )
                .unwrap();
        }
        let conn = agent_relay_probe::delivery::open_db(&home.path().join("history.db")).unwrap();
        let job = delivery::create_session_job(&conn, &job_config(true), now()).unwrap();
        let mut options = ai_hist::StoreOptions::default();
        options.db_path = Some(home.path().join("history.db"));
        options.roots = Some(ai_hist::ProviderRoots::from_home(
            home.path().to_path_buf(),
            home.path().join("opencode.db"),
        ));
        let store = ai_hist::SessionStore::open(options).unwrap();
        for _ in 0..2 {
            let report = store
                .discover(ai_hist::DiscoveryOptions::default())
                .unwrap();
            assert_eq!(
                report.discovered + report.skipped_unchanged,
                1001,
                "periodic inventory must not repeatedly cap the same newest sessions"
            );
        }
        let oldest_known: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM sessions WHERE source='claude' AND session_id='session-0000')", [], |r| r.get(0)).unwrap();
        assert!(oldest_known);
        assert!(delivery::job_sessions(&conn, &job.job_id)
            .unwrap()
            .is_empty());
        assert!(delivery::prepare_batch(&conn, &job.job_id, now())
            .unwrap()
            .batch_id
            .is_none());
    }

    #[test]
    fn fake_receiver_drains_selected_backlog_despite_failing_capture_and_private_discovery() {
        struct Fake(std::cell::RefCell<Vec<String>>);
        impl worker::Receiver for Fake {
            fn mapping_version(&self) -> &str {
                destination::MAPPING_VERSION
            }
            fn supported_kinds(&self) -> &[&str] {
                delivery::SUPPORTED_KINDS
            }
            fn supports_tombstones(&self) -> bool {
                true
            }
            fn prepare(
                &self,
                batch: &delivery::HistoryExportBatch,
                _: &worker::ReceiverContext<'_>,
            ) -> std::result::Result<worker::PreparedBody, worker::ReceiverFailure> {
                Ok(worker::PreparedBody {
                    content_type: "application/json".into(),
                    body: serde_json::to_string(batch).unwrap(),
                })
            }
            fn send(
                &self,
                _: &delivery::PreparedPayload,
                batch: &delivery::HistoryExportBatch,
                _: &worker::ReceiverContext<'_>,
            ) -> std::result::Result<delivery::DeliveryAcknowledgment, worker::ReceiverFailure>
            {
                self.0
                    .borrow_mut()
                    .extend(batch.records.iter().map(|r| r.session_id.clone().unwrap()));
                Ok(delivery::DeliveryAcknowledgment {
                    batch_id: batch.batch_id.clone(),
                    accepted_revision_ids: batch
                        .records
                        .iter()
                        .map(|r| r.revision_id.clone())
                        .collect(),
                    unsupported_revision_ids: vec![],
                    suppressed_revision_ids: vec![],
                    rejected_revision_ids: vec![],
                    isolation_frontier: vec![],
                    acceptance_level: delivery::AcceptanceLevel::Durable,
                })
            }
        }
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("history.db");
        let conn = agent_relay_probe::delivery::open_db(&path).unwrap();
        conn.execute(
            "INSERT INTO sessions(source,session_id) VALUES ('claude','selected')",
            [],
        )
        .unwrap();
        for n in 0..20 {
            conn.execute("INSERT INTO session_events(source,session_id,event_uid,ts_ms,role,kind,text) VALUES('claude','selected',?,1,'user','text','synthetic')",[n.to_string()]).unwrap();
        }
        let mut jc = job_config(true);
        jc.limits.max_batch_records = 1;
        let job = delivery::create_session_job(&conn, &jc, now()).unwrap();
        delivery::set_job_session(
            &conn,
            &job.job_id,
            &delivery::SessionIdentity {
                source: "claude".into(),
                session_id: "selected".into(),
            },
            true,
        )
        .unwrap();
        // A newly discovered catalog row is visible, but never authorized.
        conn.execute(
            "INSERT INTO sessions(source,session_id) VALUES ('codex','new-private')",
            [],
        )
        .unwrap();
        let config = Config {
            version: 1,
            site_url: "https://example.invalid".into(),
            account_id: "account".into(),
            account_email: None,
            account_name: None,
            account_avatar_url: None,
            workspace_name: None,
            org_id: "org".into(),
            workspace_id: "workspace".into(),
            history_url: "https://example.invalid".into(),
            delivery_account: jc.account_id,
            job_id: job.job_id,
            include_existing: false,
            sharing_mode: Some(super::super::bridge::SharingMode::Selected),
            acknowledge_uninspected_schedules: false,
        };
        let fake = Fake(std::cell::RefCell::new(vec![]));
        let capture_calls = std::cell::Cell::new(0);
        for _ in 0..4 {
            let _ = run_capture_cycle(
                true,
                || deliver_with_receiver(&path, &config, &fake, &|| false).map(|_| ()),
                || {
                    let s = delivery::status(&conn, &config.job_id)?;
                    Ok(s.bootstrap_complete && s.pending_records == 0 && s.unqueued_changes == 0)
                },
                || {
                    capture_calls.set(capture_calls.get() + 1);
                    Err(anyhow::anyhow!("synthetic missing selected source"))
                },
                || panic!("unrelated slow/failing provider called"),
                || false,
            );
        }
        assert_eq!(fake.0.borrow().len(), 21);
        assert!(fake.0.borrow().iter().all(|id| id == "selected"));
        assert!(capture_calls.get() > 0);
        assert_eq!(
            delivery::status(&conn, &config.job_id)
                .unwrap()
                .acknowledged_records,
            21
        );
    }
    #[test]
    fn delivery_errors_do_not_prevent_selected_or_broad_capture() {
        for selected in [true, false] {
            let calls = std::cell::RefCell::new(Vec::new());
            let error = run_capture_cycle(
                selected,
                || {
                    calls.borrow_mut().push("deliver");
                    Err(anyhow::anyhow!("synthetic credential failure"))
                },
                || panic!("delivery failure must not suppress capture behind backlog"),
                || {
                    calls.borrow_mut().push("targeted");
                    Ok(())
                },
                || {
                    calls.borrow_mut().push("broad");
                    Ok(())
                },
                || false,
            )
            .result()
            .unwrap_err();
            assert_eq!(
                calls.into_inner(),
                vec![
                    "deliver",
                    if selected { "targeted" } else { "broad" },
                    "deliver"
                ]
            );
            assert_eq!(error.to_string(), "synthetic credential failure");
        }
    }

    #[test]
    fn selected_retry_backoff_does_not_starve_local_capture() {
        let (_dir, conn) = test_db();
        conn.execute(
            "INSERT INTO sessions(source,session_id) VALUES ('claude','selected')",
            [],
        )
        .unwrap();
        let job = delivery::create_session_job(&conn, &job_config(true), now()).unwrap();
        delivery::set_job_session(
            &conn,
            &job.job_id,
            &delivery::SessionIdentity {
                source: "claude".into(),
                session_id: "selected".into(),
            },
            true,
        )
        .unwrap();
        delivery::prepare_batch(&conn, &job.job_id, now()).unwrap();
        assert!(
            delivery::status(&conn, &job.job_id)
                .unwrap()
                .pending_records
                > 0
        );
        let captures = std::cell::Cell::new(0);
        for waiting in [false, true, false] {
            conn.execute(
                "UPDATE delivery_jobs SET next_attempt_ms=? WHERE id=?",
                rusqlite::params![if waiting { now() + 60_000 } else { 0 }, job.job_id],
            )
            .unwrap();
            run_capture_cycle(
                true,
                || Ok(()),
                || ready_to_capture(&conn, &job.job_id),
                || {
                    captures.set(captures.get() + 1);
                    Ok(())
                },
                || panic!("selected mode must not use broad capture"),
                || false,
            )
            .result()
            .unwrap();
        }
        assert_eq!(
            captures.get(),
            1,
            "capture runs during backoff, but an eligible backlog retains priority"
        );
    }

    #[test]
    fn selected_backlog_does_not_enter_unrelated_capture() {
        use std::cell::Cell;
        let delivered = Cell::new(0);
        for _ in 0..3 {
            run_capture_cycle(
                true,
                || {
                    delivered.set(delivered.get() + 1);
                    Ok(())
                },
                || Ok(false),
                || panic!("backlog must drain first"),
                || panic!("blocked unrelated provider entered"),
                || false,
            )
            .result()
            .unwrap();
        }
        assert_eq!(delivered.get(), 3);
        run_capture_cycle(
            true,
            || {
                delivered.set(delivered.get() + 1);
                Ok(())
            },
            || Ok(true),
            || Err(anyhow::anyhow!("synthetic selected capture failure")),
            || panic!("failing unrelated provider entered"),
            || false,
        )
        .result()
        .unwrap_err();
        assert_eq!(delivered.get(), 5);
    }

    #[test]
    fn capture_diagnostics_never_include_raw_errors_or_credentials() {
        let dir = tempfile::tempdir().unwrap();
        let error = anyhow::Error::new(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "secret prompt /private/source https://token:secret@example.invalid",
        ));
        capture_diagnostic(
            dir.path(),
            "targeted_hydration",
            Instant::now(),
            2,
            1,
            Some(&error),
        )
        .unwrap();
        let value = std::fs::read_to_string(dir.path().join("capture-diagnostic.json")).unwrap();
        assert!(value.contains("permission_denied"));
        for forbidden in ["secret", "prompt", "private", "https", "example"] {
            assert!(!value.contains(forbidden));
        }
    }

    fn members(ids: &[&str]) -> Vec<delivery::SessionIdentity> {
        ids.iter()
            .map(|id| delivery::SessionIdentity {
                source: "codex".into(),
                session_id: (*id).into(),
            })
            .collect()
    }

    /// Verify failed members retain their typed cause while healthy members are captured.
    #[test]
    fn targeted_storage_failure_keeps_its_class_and_other_members_still_capture() {
        let dir = tempfile::tempdir().unwrap();
        let captured = std::cell::Cell::new(0);
        let result = capture_members(
            dir.path(),
            members(&["corrupt", "healthy"]),
            || false,
            |member| {
                if member.session_id == "corrupt" {
                    Err(anyhow::Error::new(rusqlite::Error::SqliteFailure(
                        rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CORRUPT),
                        Some("secret transcript".into()),
                    )))
                } else {
                    captured.set(captured.get() + 1);
                    Ok(())
                }
            },
        );
        assert_eq!(captured.get(), 1);
        let report = cycle_report(&Verdicts::capture(&result));
        assert_eq!(report["error_class"], "database_corrupt");
        assert!(!report.to_string().contains("secret"));
        assert!(!report["message"].as_str().unwrap().contains("offline"));
    }

    /// A member waiting for Keychain access is not a failed capture.
    #[test]
    fn a_member_waiting_for_the_keychain_is_not_a_failure() {
        let dir = tempfile::tempdir().unwrap();
        let captured = std::cell::Cell::new(0);
        let result = capture_members(
            dir.path(),
            members(&["cloud", "healthy"]),
            || false,
            |member| {
                if member.session_id == "cloud" {
                    Err(super::super::remote_sources::keychain_waiting_error())
                } else {
                    captured.set(captured.get() + 1);
                    Ok(())
                }
            },
        );
        assert!(result.is_ok());
        assert_eq!(captured.get(), 1);
        let diagnostic: serde_json::Value = serde_json::from_slice(
            &std::fs::read(dir.path().join("capture-diagnostic.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(diagnostic["failures"], 0);
        assert_eq!(diagnostic["error_class"], serde_json::Value::Null);
    }

    /// Verify SQLite failure guidance and cycle reports never reveal raw sensitive details.
    #[test]
    fn cycle_errors_classify_local_storage_without_exposing_raw_details() {
        for (code, class) in [
            (rusqlite::ffi::SQLITE_CORRUPT, "database_corrupt"),
            (rusqlite::ffi::SQLITE_FULL, "disk_full"),
            (rusqlite::ffi::SQLITE_BUSY, "database_busy"),
            (rusqlite::ffi::SQLITE_READONLY, "permission_denied"),
            (
                rusqlite::ffi::SQLITE_READONLY_DIRECTORY,
                "permission_denied",
            ),
            (rusqlite::ffi::SQLITE_PERM, "permission_denied"),
            (rusqlite::ffi::SQLITE_CANTOPEN, "database_unavailable"),
        ] {
            let error = anyhow::Error::new(rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error::new(code),
                Some("secret prompt https://token:secret@example.invalid".into()),
            ));
            let report = cycle_report(&Verdicts::capture(&Err(error)));
            assert_eq!(report["error_class"], class);
            assert_eq!(report["ok"], false);
            assert!(!report["message"].as_str().unwrap().contains("offline"));
            for forbidden in ["secret", "prompt", "https", "example"] {
                assert!(!report.to_string().contains(forbidden));
            }
        }
        let healthy = cycle_report(&Verdicts::default());
        assert_eq!(healthy["ok"], true);
        assert!(healthy["message"].is_null());
        assert!(healthy["error_class"].is_null());
    }

    /// Verify contextual StorageFull and native ENOSPC errors retain safe disk guidance.
    #[test]
    fn filesystem_disk_full_uses_safe_local_guidance_through_context() {
        let errors = vec![std::io::Error::new(
            std::io::ErrorKind::StorageFull,
            "secret prompt /private/token",
        )];
        #[cfg(unix)]
        let errors = {
            let mut errors = errors;
            errors.push(std::io::Error::from_raw_os_error(libc::ENOSPC));
            errors
        };
        for error in errors {
            let error = anyhow::Error::new(error).context("writing secret runtime.json");
            assert!(local_failure_message(&error)
                .unwrap()
                .contains("Free disk space"));
            let report = cycle_report(&Verdicts::capture(&Err(error)));
            assert_eq!(report["error_class"], "disk_full");
            assert_eq!(report["ok"], false);
            assert!(!report.to_string().contains("secret"));
            assert!(!report.to_string().contains("offline"));
        }
    }

    /// A full log disk cannot make advisory cycle reporting terminate the collector.
    #[test]
    fn cycle_reporting_tolerates_failed_status_and_log_writes() {
        struct FullDisk;
        impl Write for FullDisk {
            fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
                Err(std::io::ErrorKind::StorageFull.into())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("cycle.json");
        fs::create_dir(&path).unwrap();
        let result = Err(anyhow::Error::new(std::io::Error::new(
            std::io::ErrorKind::StorageFull,
            "secret runtime path",
        )));
        write_cycle_report(
            directory.path(),
            &Verdicts::capture(&result),
            None,
            FullDisk,
        );
        let mut output = Vec::new();
        write_cycle_report(
            directory.path(),
            &Verdicts::capture(&result),
            None,
            &mut output,
        );
        let output = String::from_utf8(output).unwrap();
        assert!(output.contains("Sync status could not be saved"));
        assert!(output.contains("Free disk space"));
        assert!(!output.contains("secret"));
        fs::remove_dir(&path).unwrap();
        write_cycle_report(directory.path(), &Verdicts::default(), None, FullDisk);
        let saved: serde_json::Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        assert_eq!(saved["ok"], true);
    }

    /// Passes follow the backlog: back to back while the active job has
    /// queued or unqueued work the last pass moved, two seconds apart while
    /// it could not, twenty once caught up or paused.
    #[test]
    fn pass_interval_follows_the_active_jobs_backlog() {
        let dir = tempfile::tempdir().unwrap();
        let conn = agent_relay_probe::delivery::open_db(&dir.path().join("history.db")).unwrap();
        let job = delivery::create_job(&conn, &job_config(true), now()).unwrap();
        let config = Config {
            version: 1,
            site_url: "https://agentrelay.com".into(),
            account_id: "account".into(),
            account_email: None,
            account_name: None,
            account_avatar_url: None,
            workspace_name: None,
            org_id: "org".into(),
            workspace_id: "workspace".into(),
            history_url: "https://history.agentrelay.com".into(),
            delivery_account: job.config.account_id,
            job_id: job.job_id,
            include_existing: true,
            sharing_mode: None,
            acknowledge_uninspected_schedules: false,
        };
        // An empty database still owes one bootstrap scan before it is caught up.
        assert!(backlog_pending(dir.path(), &config));
        let prepared = delivery::prepare_batch(&conn, &config.job_id, now()).unwrap();
        assert!(prepared.bootstrap_complete && prepared.batch_id.is_none());
        assert!(!backlog_pending(dir.path(), &config));
        assert_eq!(pass_interval(false, false), Duration::from_secs(20));
        assert_eq!(pass_interval(false, true), Duration::from_secs(20));
        conn.execute(
            "INSERT INTO sessions(source,session_id) VALUES ('claude','queued')",
            [],
        )
        .unwrap();
        assert!(backlog_pending(dir.path(), &config));
        assert_eq!(pass_interval(true, false), Duration::from_secs(2));
        assert_eq!(pass_interval(true, true), Duration::ZERO);
        // A job in receiver backoff cannot attempt anything yet: passes two
        // seconds apart would repeat the same local work for an idle drain.
        conn.execute(
            "UPDATE delivery_jobs SET next_attempt_ms=? WHERE id=?",
            rusqlite::params![now() + 60_000, config.job_id],
        )
        .unwrap();
        assert!(!backlog_pending(dir.path(), &config));
        conn.execute(
            "UPDATE delivery_jobs SET next_attempt_ms=0 WHERE id=?",
            [&config.job_id],
        )
        .unwrap();
        assert!(backlog_pending(dir.path(), &config));
        delivery::pause_job(&conn, &config.job_id).unwrap();
        assert!(!backlog_pending(dir.path(), &config));
        assert!(!backlog_pending(
            tempfile::tempdir().unwrap().path(),
            &config
        ));
    }

    fn saved_cycle(directory: &Path) -> serde_json::Value {
        serde_json::from_slice(&fs::read(directory.join("cycle.json")).unwrap()).unwrap()
    }

    fn disk_full() -> anyhow::Error {
        anyhow::Error::new(std::io::Error::from(std::io::ErrorKind::StorageFull))
    }
    const DISK_FULL: &str = "The local disk is full. Free disk space to resume session uploads.";
    const RUN: &str = "1-1";

    /// Capture and delivery are observed at different cadences: a pass that
    /// only delivered leaves the capture verdict, and the desktop banner it
    /// drives, exactly where the capture cycle put it.
    #[test]
    fn a_delivery_only_pass_keeps_the_last_capture_verdict() {
        let directory = tempfile::tempdir().unwrap();
        let full = PassOutcome {
            capture: Some(Err(disk_full())),
            delivery: Ok(()),
        };
        persist_cycle_report(directory.path(), RUN, &full, Vec::new());
        assert_eq!(saved_cycle(directory.path())["error_class"], "disk_full");

        for _ in 0..20 {
            persist_cycle_report(
                directory.path(),
                RUN,
                &PassOutcome::delivery_only(Ok(())),
                Vec::new(),
            );
        }
        let report = saved_cycle(directory.path());
        assert_eq!(report["ok"], false);
        assert_eq!(report["error_class"], "disk_full");
        assert_eq!(report["message"], DISK_FULL);
        assert_eq!(report["capture"]["error_class"], "disk_full");
        assert_eq!(report["delivery"]["ok"], true);
        assert!(report["delivery"]["message"].is_null());

        // A capture pass is what rewrites the capture verdict.
        persist_cycle_report(
            directory.path(),
            RUN,
            &PassOutcome {
                capture: Some(Ok(())),
                delivery: Ok(()),
            },
            Vec::new(),
        );
        let report = saved_cycle(directory.path());
        assert_eq!(report["ok"], true);
        assert!(report["error_class"].is_null());
        assert!(report["message"].is_null());
    }

    /// A collector restarted on a large history runs its first capture pass
    /// for minutes. The report the previous run left says nothing about this
    /// one: status hides it, and this run's first report carries no capture
    /// verdict it has not measured.
    #[test]
    fn a_report_from_another_collector_run_is_not_current() {
        let directory = tempfile::tempdir().unwrap();
        let runtime = |run: &str| {
            save_json(
                &directory.path().join("runtime.json"),
                &json!({"startup_id":run,"pid":1,"ready":true}),
            )
            .unwrap()
        };
        runtime("old");
        persist_cycle_report(
            directory.path(),
            "old",
            &PassOutcome {
                capture: Some(Err(disk_full())),
                delivery: Ok(()),
            },
            Vec::new(),
        );
        assert_eq!(
            current_cycle_report(directory.path()).unwrap()["error_class"],
            "disk_full"
        );

        runtime("new");
        assert!(current_cycle_report(directory.path()).is_none());
        persist_cycle_report(
            directory.path(),
            "new",
            &PassOutcome::delivery_only(Ok(())),
            Vec::new(),
        );
        let report = current_cycle_report(directory.path()).unwrap();
        assert_eq!(report["ok"], true);
        assert!(report["capture"]["error_class"].is_null());

        // A report from before reports named their run is never current.
        save_json(
            &directory.path().join("cycle.json"),
            &json!({"at_ms":1,"ok":false,"error_class":"capture_error"}),
        )
        .unwrap();
        assert!(current_cycle_report(directory.path()).is_none());
    }

    /// A delivery fault of its own is reported while the capture verdict is
    /// healthy, and never outranks a capture fault the user can act on.
    #[test]
    fn a_delivery_fault_reports_under_a_healthy_capture_verdict() {
        let directory = tempfile::tempdir().unwrap();
        persist_cycle_report(
            directory.path(),
            RUN,
            &PassOutcome {
                capture: Some(Ok(())),
                delivery: Err(anyhow::anyhow!("synthetic transport failure")),
            },
            Vec::new(),
        );
        let report = saved_cycle(directory.path());
        assert_eq!(report["ok"], false);
        assert_eq!(report["error_class"], "capture_error");
        assert_eq!(
            report["message"],
            "Sync paused or offline. Retrying; local data remains queued."
        );
        assert!(!report.to_string().contains("synthetic"));

        persist_cycle_report(
            directory.path(),
            RUN,
            &PassOutcome {
                capture: Some(Err(disk_full())),
                delivery: Err(anyhow::anyhow!("synthetic transport failure")),
            },
            Vec::new(),
        );
        let report = saved_cycle(directory.path());
        assert_eq!(report["error_class"], "disk_full");
        assert_eq!(report["delivery"]["error_class"], "capture_error");
    }

    /// An install's store in a fresh directory, opened as its collector.
    fn test_db() -> (tempfile::TempDir, Connection) {
        let dir = tempfile::tempdir().unwrap();
        let conn = delivery::open_db(&dir.path().join("history.db")).unwrap();
        (dir, conn)
    }

    /// A one-shot selected run, which starts no capture thread, keeps only
    /// its members' evidence as the capture thread does.
    #[test]
    fn a_one_shot_selected_capture_keeps_only_its_members_evidence() {
        use crate::live::tests::{append, isolated_home, transcript_line};
        let Some(home) = isolated_home(
            "collector::tests::a_one_shot_selected_capture_keeps_only_its_members_evidence",
        ) else {
            return;
        };
        let directory = home.join("probe");
        let db = directory.join("history.db");
        let conn = agent_relay_probe::delivery::open_db(&db).unwrap();
        let project = home.join(".claude/projects/once");
        std::fs::create_dir_all(&project).unwrap();
        for session in ["kept", "other"] {
            append(
                &project.join(format!("{session}.jsonl")),
                &transcript_line(session, &format!("{session}-1")),
            );
        }
        super::super::history::discover(&db, None, || false).unwrap();
        super::super::history::hydrate(&db, "claude", "other", || false).unwrap();
        let job = delivery::create_session_job(&conn, &job_config(false), now()).unwrap();
        delivery::set_job_session(
            &conn,
            &job.job_id,
            &delivery::SessionIdentity {
                source: "claude".into(),
                session_id: "kept".into(),
            },
            true,
        )
        .unwrap();
        let events = |session: &str| -> i64 {
            conn.query_row(
                "SELECT COUNT(*) FROM session_events WHERE session_id=?",
                [session],
                |row| row.get(0),
            )
            .unwrap()
        };
        assert_eq!(events("other"), 1);
        let config = crate::live::tests::config(&job, true);
        capture_selected(&directory, &config, &Arc::new(AtomicBool::new(false))).unwrap();
        assert_eq!(events("kept"), 1, "the member was captured");
        assert_eq!(
            events("other"),
            0,
            "evidence outside the selection was kept"
        );
    }

    fn job_config(include_existing: bool) -> delivery::DeliveryJobConfig {
        delivery::DeliveryJobConfig {
            destination_id: DESTINATION.into(),
            instance_id: INSTANCE.into(),
            account_id: destination::account_id("org", Some("workspace")),
            mapping_version: destination::MAPPING_VERSION.into(),
            selection: selection(include_existing),
            limits: Default::default(),
        }
    }
    #[test]
    fn a_batch_that_cannot_be_prepared_reaches_the_cycle_report_as_such() {
        struct Unreached;
        impl worker::Receiver for Unreached {
            fn mapping_version(&self) -> &str {
                destination::MAPPING_VERSION
            }
            fn supported_kinds(&self) -> &[&str] {
                delivery::SUPPORTED_KINDS
            }
            fn supports_tombstones(&self) -> bool {
                true
            }
            fn prepare(
                &self,
                _: &delivery::HistoryExportBatch,
                _: &worker::ReceiverContext<'_>,
            ) -> std::result::Result<worker::PreparedBody, worker::ReceiverFailure> {
                panic!("no batch can be prepared")
            }
            fn send(
                &self,
                _: &delivery::PreparedPayload,
                _: &delivery::HistoryExportBatch,
                _: &worker::ReceiverContext<'_>,
            ) -> std::result::Result<delivery::DeliveryAcknowledgment, worker::ReceiverFailure>
            {
                panic!("no batch can be sent")
            }
        }
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("history.db");
        let conn = agent_relay_probe::delivery::open_db(&db_path).unwrap();
        conn.execute(
            "INSERT INTO sessions(source,session_id) VALUES ('claude','stuck')",
            [],
        )
        .unwrap();
        let job = delivery::create_job(&conn, &job_config(true), now()).unwrap();
        // No record revision can be numbered past this base.
        conn.execute("UPDATE delivery_origin SET revision_base=?", [i64::MAX])
            .unwrap();
        let config = Config {
            version: 1,
            site_url: "https://agentrelay.com".into(),
            account_id: "account".into(),
            account_email: None,
            account_name: None,
            account_avatar_url: None,
            workspace_name: None,
            org_id: "org".into(),
            workspace_id: "workspace".into(),
            history_url: "https://history.agentrelay.com".into(),
            delivery_account: job.config.account_id,
            job_id: job.job_id,
            include_existing: true,
            sharing_mode: None,
            acknowledge_uninspected_schedules: false,
        };
        let failed = deliver_with_receiver(&db_path, &config, &Unreached, &|| false).unwrap_err();
        assert_eq!(capture_error_class(&failed), "upload_preparation_failed");
        let report = cycle_report(&Verdicts {
            capture: None,
            delivery: verdict(&Err(failed)),
            run: None,
        });
        assert_eq!(
            report["delivery"]["error_class"],
            "upload_preparation_failed"
        );
        assert!(!report.to_string().contains("offline"));
    }

    #[test]
    fn a_store_failure_while_preparing_is_reported_as_the_store_condition() {
        struct Unreached;
        impl worker::Receiver for Unreached {
            fn mapping_version(&self) -> &str {
                destination::MAPPING_VERSION
            }
            fn supported_kinds(&self) -> &[&str] {
                delivery::SUPPORTED_KINDS
            }
            fn supports_tombstones(&self) -> bool {
                true
            }
            fn prepare(
                &self,
                _: &delivery::HistoryExportBatch,
                _: &worker::ReceiverContext<'_>,
            ) -> std::result::Result<worker::PreparedBody, worker::ReceiverFailure> {
                panic!("no batch can be prepared")
            }
            fn send(
                &self,
                _: &delivery::PreparedPayload,
                _: &delivery::HistoryExportBatch,
                _: &worker::ReceiverContext<'_>,
            ) -> std::result::Result<delivery::DeliveryAcknowledgment, worker::ReceiverFailure>
            {
                panic!("no batch can be sent")
            }
        }
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("history.db");
        let conn = agent_relay_probe::delivery::open_db(&db_path).unwrap();
        conn.execute(
            "INSERT INTO sessions(source,session_id) VALUES ('claude','stuck')",
            [],
        )
        .unwrap();
        let job = delivery::create_job(&conn, &job_config(true), now()).unwrap();
        // The job stands past the feed's head, which the store refuses to
        // read from: the store's error, not the preparation, is reported.
        conn.execute(
            "UPDATE delivery_jobs SET journal_cursor=1000000 WHERE id=?",
            [&job.job_id],
        )
        .unwrap();
        let config = Config {
            version: 1,
            site_url: "https://agentrelay.com".into(),
            account_id: "account".into(),
            account_email: None,
            account_name: None,
            account_avatar_url: None,
            workspace_name: None,
            org_id: "org".into(),
            workspace_id: "workspace".into(),
            history_url: "https://history.agentrelay.com".into(),
            delivery_account: job.config.account_id,
            job_id: job.job_id,
            include_existing: true,
            sharing_mode: None,
            acknowledge_uninspected_schedules: false,
        };
        let failed = deliver_with_receiver(&db_path, &config, &Unreached, &|| false).unwrap_err();
        let store = failed
            .chain()
            .find_map(|cause| cause.downcast_ref::<ai_hist::Error>())
            .unwrap_or_else(|| panic!("{failed:#}"));
        let class = store_error_class(store);
        assert_ne!(class, "upload_preparation_failed");
        assert_eq!(capture_error_class(&failed), class);
        let report = cycle_report(&Verdicts {
            capture: None,
            delivery: verdict(&Err(failed)),
            run: None,
        });
        assert_eq!(report["delivery"]["error_class"], class);
    }

    #[test]
    fn pause_during_drain_is_successful_without_acknowledging_the_batch() {
        struct PausingReceiver<'a> {
            conn: &'a Connection,
            job_id: &'a str,
            sent: std::cell::Cell<bool>,
        }
        impl worker::Receiver for PausingReceiver<'_> {
            fn mapping_version(&self) -> &str {
                destination::MAPPING_VERSION
            }
            fn supported_kinds(&self) -> &[&str] {
                delivery::SUPPORTED_KINDS
            }
            fn supports_tombstones(&self) -> bool {
                true
            }
            fn prepare(
                &self,
                _: &delivery::HistoryExportBatch,
                _: &worker::ReceiverContext<'_>,
            ) -> std::result::Result<worker::PreparedBody, worker::ReceiverFailure> {
                Ok(worker::PreparedBody {
                    content_type: "application/json".into(),
                    body: "{}".into(),
                })
            }
            fn send(
                &self,
                _: &delivery::PreparedPayload,
                _: &delivery::HistoryExportBatch,
                _: &worker::ReceiverContext<'_>,
            ) -> std::result::Result<delivery::DeliveryAcknowledgment, worker::ReceiverFailure>
            {
                self.sent.set(true);
                delivery::pause_job(self.conn, self.job_id).unwrap();
                Err(delivery::DeliveryFailure::Transient.into())
            }
        }
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("history.db");
        let conn = agent_relay_probe::delivery::open_db(&db_path).unwrap();
        conn.execute(
            "INSERT INTO sessions(source,session_id) VALUES ('claude','in-flight')",
            [],
        )
        .unwrap();
        let job = delivery::create_job(&conn, &job_config(true), now()).unwrap();
        let config = Config {
            version: 1,
            site_url: "https://agentrelay.com".into(),
            account_id: "account".into(),
            account_email: None,
            account_name: None,
            account_avatar_url: None,
            workspace_name: None,
            org_id: "org".into(),
            workspace_id: "workspace".into(),
            history_url: "https://history.agentrelay.com".into(),
            delivery_account: job.config.account_id,
            job_id: job.job_id,
            include_existing: true,
            sharing_mode: None,
            acknowledge_uninspected_schedules: false,
        };
        let receiver = PausingReceiver {
            conn: &conn,
            job_id: &config.job_id,
            sent: std::cell::Cell::new(false),
        };
        let status = deliver_with_receiver(&db_path, &config, &receiver, &|| false).unwrap();
        assert!(receiver.sent.get());
        assert_eq!(status.state, "paused");
        assert_eq!(status.acknowledged_records, 0);
        assert!(status.pending_records > 0);
        delivery::cancel_job(&conn, &config.job_id).unwrap();
        assert!(deliver_with_receiver(&db_path, &config, &receiver, &|| false).is_err());
    }

    /// A pass that drained reports what it moved and the queue it left, as
    /// numbers only; a pass that ran no drain reports no metrics.
    #[test]
    fn the_pass_report_carries_content_free_delivery_metrics() {
        struct Accepting;
        impl worker::Receiver for Accepting {
            fn mapping_version(&self) -> &str {
                destination::MAPPING_VERSION
            }
            fn supported_kinds(&self) -> &[&str] {
                delivery::SUPPORTED_KINDS
            }
            fn supports_tombstones(&self) -> bool {
                true
            }
            fn prepare(
                &self,
                _: &delivery::HistoryExportBatch,
                _: &worker::ReceiverContext<'_>,
            ) -> std::result::Result<worker::PreparedBody, worker::ReceiverFailure> {
                Ok(worker::PreparedBody {
                    content_type: "application/json".into(),
                    body: "{}".into(),
                })
            }
            fn send(
                &self,
                _: &delivery::PreparedPayload,
                batch: &delivery::HistoryExportBatch,
                _: &worker::ReceiverContext<'_>,
            ) -> std::result::Result<delivery::DeliveryAcknowledgment, worker::ReceiverFailure>
            {
                Ok(delivery::DeliveryAcknowledgment {
                    batch_id: batch.batch_id.clone(),
                    accepted_revision_ids: batch
                        .records
                        .iter()
                        .map(|record| record.revision_id.clone())
                        .collect(),
                    unsupported_revision_ids: vec![],
                    suppressed_revision_ids: vec![],
                    rejected_revision_ids: vec![],
                    isolation_frontier: vec![],
                    acceptance_level: delivery::AcceptanceLevel::Durable,
                })
            }
        }
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("history.db");
        let conn = agent_relay_probe::delivery::open_db(&db_path).unwrap();
        for n in 0..150 {
            conn.execute(
                "INSERT INTO session_events(source,session_id,event_uid,ts_ms,role,kind,text) VALUES ('claude','private-session',?1,?2,'user','text','private transcript text')",
                rusqlite::params![format!("event-{n}"), now() - 5_000],
            )
            .unwrap();
        }
        let job = delivery::create_job(&conn, &job_config(true), now()).unwrap();
        let config = Config {
            version: 1,
            site_url: "https://agentrelay.com".into(),
            account_id: "account".into(),
            account_email: None,
            account_name: None,
            account_avatar_url: None,
            workspace_name: None,
            org_id: "org".into(),
            workspace_id: "workspace".into(),
            history_url: "https://history.agentrelay.com".into(),
            delivery_account: job.config.account_id,
            job_id: job.job_id,
            include_existing: true,
            sharing_mode: None,
            acknowledge_uninspected_schedules: false,
        };
        deliver_with_receiver(&db_path, &config, &Accepting, &|| false).unwrap();
        // The drain's own status says the job is caught up, so the loop
        // need not read it again to choose the next pass's gap.
        PASS_METRICS.with(|pass| assert!(!pass.borrow().as_ref().unwrap().backlog));
        let pass = PassOutcome::delivery_only(Ok(()));
        persist_cycle_report(dir.path(), "run", &pass, Vec::new());
        let report: serde_json::Value =
            serde_json::from_slice(&fs::read(dir.path().join("cycle.json")).unwrap()).unwrap();
        let metrics = &report["delivery_metrics"];
        assert_eq!(metrics["drains"], 1);
        assert_eq!(metrics["records_acknowledged"], 150);
        assert_eq!(metrics["batches_acknowledged"], metrics["batches_sent"]);
        assert_eq!(metrics["pending_records"], 0);
        assert!(metrics["event_lag_ms"].as_u64().unwrap() >= 5_000);
        // This receiver sends one batch at a time, and nothing was retried.
        assert_eq!(metrics["in_flight_limit"], DELIVERY_CONCURRENCY);
        assert_eq!(metrics["max_in_flight"], 1);
        assert_eq!(metrics["batches_retried"], 0);
        let text = report.to_string();
        assert!(!text.contains("private"), "{text}");
        assert!(!text.contains(&dir.path().display().to_string()));
        // The next pass ran no drain: its report carries no metrics.
        persist_cycle_report(dir.path(), "run", &pass, Vec::new());
        let report: serde_json::Value =
            serde_json::from_slice(&fs::read(dir.path().join("cycle.json")).unwrap()).unwrap();
        assert!(report.get("delivery_metrics").is_none());
    }

    /// Only a job blocked on sign-in is renewed, and only a renewed session
    /// unblocks it; every other verdict and outcome is left as it was.
    #[test]
    fn a_job_blocked_on_sign_in_resumes_after_agent_relay_renews_it() {
        let dir = tempfile::tempdir().unwrap();
        let conn = agent_relay_probe::delivery::open_db(&dir.path().join("history.db")).unwrap();
        let job = delivery::create_job(&conn, &job_config(true), now()).unwrap();
        let config = Config {
            version: 1,
            site_url: "https://agentrelay.com".into(),
            account_id: "account".into(),
            account_email: None,
            account_name: None,
            account_avatar_url: None,
            workspace_name: None,
            org_id: "org".into(),
            workspace_id: "workspace".into(),
            history_url: "https://history.agentrelay.com".into(),
            delivery_account: job.config.account_id,
            job_id: job.job_id.clone(),
            include_existing: true,
            sharing_mode: None,
            acknowledge_uninspected_schedules: false,
        };
        let block = |failure: &str| {
            conn.execute(
                "UPDATE delivery_jobs SET state='blocked',failure=?1 WHERE id=?2",
                [failure, &job.job_id],
            )
            .unwrap();
        };
        let state = || delivery::status(&conn, &job.job_id).unwrap();

        let at = dir.path();
        // Active jobs and other verdicts never ask for a credential.
        recover_authentication(&conn, at, &config, || panic!("active job renewed")).unwrap();
        block("invalid_payload");
        recover_authentication(&conn, at, &config, || panic!("wrong verdict renewed")).unwrap();
        assert_eq!(state().state, "blocked");

        // No Agent Relay sign-in, or one Cloud refused: still blocked on
        // sign-in, with the cause kept for status.
        block("authentication_required");
        let failed = |failure| move || Ok(Renewal::Failed(failure));
        recover_authentication(&conn, at, &config, failed(RenewalFailure::NoCloudSession)).unwrap();
        assert_eq!(state().failure.as_deref(), Some("authentication_required"));
        assert_eq!(renewal_failure(at), Some(RenewalFailure::NoCloudSession));
        recover_authentication(&conn, at, &config, failed(RenewalFailure::CloudRefused)).unwrap();
        assert_eq!(state().failure.as_deref(), Some("authentication_required"));
        assert_eq!(renewal_failure(at), Some(RenewalFailure::CloudRefused));
        // Waiting on another rotation leaves the cause as it was.
        recover_authentication(&conn, at, &config, || Ok(Renewal::Busy)).unwrap();
        assert_eq!(renewal_failure(at), Some(RenewalFailure::CloudRefused));
        recover_authentication(&conn, at, &config, || anyhow::bail!("lock")).unwrap();
        assert_eq!(state().failure.as_deref(), Some("authentication_required"));

        recover_authentication(&conn, at, &config, || {
            Ok(Renewal::Renewed(Default::default()))
        })
        .unwrap();
        assert_eq!(state().state, "active");
        assert_eq!(state().failure, None);
        assert_eq!(renewal_failure(at), None);
    }

    /// Only an answer from Cloud starts the gap before the next ask; a
    /// rotation lock held elsewhere does not.
    #[test]
    fn a_busy_rotation_lock_does_not_delay_the_next_renewal() {
        let last = std::sync::Mutex::new(None);
        let interval = Duration::from_secs(60);
        let asked = std::cell::Cell::new(0);
        let ask = |answer: fn() -> Renewal| {
            ask_at_most_every(&last, interval, || {
                asked.set(asked.get() + 1);
                Ok(answer())
            })
            .unwrap()
        };
        assert!(matches!(ask(|| Renewal::Busy), Renewal::Busy));
        assert!(matches!(
            ask(|| Renewal::Failed(RenewalFailure::CloudRefused)),
            Renewal::Failed(_)
        ));
        assert_eq!(asked.get(), 2);
        // Cloud answered: the next ask waits out the interval.
        assert!(matches!(ask(|| panic!("asked too soon")), Renewal::Busy));
        assert_eq!(asked.get(), 2);
    }

    #[test]
    fn a_new_build_retries_a_blocked_job_once() {
        let dir = tempfile::tempdir().unwrap();
        let conn = agent_relay_probe::delivery::open_db(&dir.path().join("history.db")).unwrap();
        let job = delivery::create_job(&conn, &job_config(true), now()).unwrap();
        let block = || {
            conn.execute(
                "UPDATE delivery_jobs SET state='blocked',failure='invalid_payload' WHERE id=?",
                [&job.job_id],
            )
            .unwrap();
        };
        let state = || delivery::status(&conn, &job.job_id).unwrap();

        block();
        retry_verdict_of_another_build(dir.path(), &job.job_id, "1.0.0").unwrap();
        assert_eq!(state().state, "active");
        assert_eq!(state().failure, None);

        // The same build reaching the same verdict keeps it.
        block();
        retry_verdict_of_another_build(dir.path(), &job.job_id, "1.0.0").unwrap();
        assert_eq!(state().state, "blocked");

        retry_verdict_of_another_build(dir.path(), &job.job_id, "1.0.1").unwrap();
        assert_eq!(state().state, "active");
    }

    #[test]
    fn unwritable_retry_marker_is_advisory_and_remembers_the_build() {
        for initial_state in ["active", "blocked", "paused", "cancelled"] {
            let dir = tempfile::tempdir().unwrap();
            let conn = delivery::open_db(&dir.path().join("history.db")).unwrap();
            let job = delivery::create_job(&conn, &job_config(true), now()).unwrap();
            conn.execute(
                "UPDATE delivery_jobs SET state=? WHERE id=?",
                [initial_state, &job.job_id],
            )
            .unwrap();
            // A directory at the marker path makes atomic replacement fail on
            // every platform, without making the database itself unwritable.
            let marker = dir.path().join("verdict-retry.json");
            fs::create_dir(&marker).unwrap();
            retry_verdict_of_another_build(dir.path(), &job.job_id, "1.0.0").unwrap();
            assert_eq!(
                delivery::status(&conn, &job.job_id).unwrap().state,
                if initial_state == "blocked" {
                    "active"
                } else {
                    initial_state
                }
            );
            conn.execute(
                "UPDATE delivery_jobs SET state='blocked',failure='invalid_payload' WHERE id=?",
                [&job.job_id],
            )
            .unwrap();
            retry_verdict_of_another_build(dir.path(), &job.job_id, "1.0.0").unwrap();
            assert_eq!(
                delivery::status(&conn, &job.job_id).unwrap().state,
                "blocked"
            );

            // Once file storage recovers, mirror the recorded version without
            // granting another retry, including on subsequent invocations.
            fs::remove_dir(&marker).unwrap();
            retry_verdict_of_another_build(dir.path(), &job.job_id, "1.0.0").unwrap();
            assert!(marker.is_file());
            retry_verdict_of_another_build(dir.path(), &job.job_id, "1.0.0").unwrap();
            assert_eq!(
                delivery::status(&conn, &job.job_id).unwrap().state,
                "blocked"
            );
            retry_verdict_of_another_build(dir.path(), &job.job_id, "1.0.1").unwrap();
            assert_eq!(
                delivery::status(&conn, &job.job_id).unwrap().state,
                "active"
            );
        }
    }

    #[test]
    fn unwritable_retry_marker_keeps_verdict_across_processes() {
        const DIRECTORY: &str = "RELAYHISTORY_TEST_RETRY_DIRECTORY";
        const JOB: &str = "RELAYHISTORY_TEST_RETRY_JOB";
        const BUILD: &str = "RELAYHISTORY_TEST_RETRY_BUILD";
        if let Some(directory) = std::env::var_os(DIRECTORY) {
            retry_verdict_of_another_build(
                Path::new(&directory),
                &std::env::var(JOB).unwrap(),
                &std::env::var(BUILD).unwrap(),
            )
            .unwrap();
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let conn = delivery::open_db(&dir.path().join("history.db")).unwrap();
        let job = delivery::create_job(&conn, &job_config(true), now()).unwrap();
        fs::create_dir(dir.path().join("verdict-retry.json")).unwrap();
        let run = |build| {
            let output = Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "collector::tests::unwritable_retry_marker_keeps_verdict_across_processes",
                ])
                .env(DIRECTORY, dir.path())
                .env(JOB, &job.job_id)
                .env(BUILD, build)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        let block = || {
            conn.execute(
                "UPDATE delivery_jobs SET state='blocked',failure='invalid_payload' WHERE id=?",
                [&job.job_id],
            )
            .unwrap();
        };
        block();
        run("0.26.1");
        assert_eq!(
            delivery::status(&conn, &job.job_id).unwrap().state,
            "active"
        );
        block();
        for _ in 0..2 {
            run("0.26.1");
            assert_eq!(
                delivery::status(&conn, &job.job_id).unwrap().state,
                "blocked"
            );
        }
        run("0.26.2");
        assert_eq!(
            delivery::status(&conn, &job.job_id).unwrap().state,
            "active"
        );
        block();
        for build in ["0.26.1", "0.26.2"] {
            run(build);
            assert_eq!(
                delivery::status(&conn, &job.job_id).unwrap().state,
                "blocked"
            );
        }
    }

    #[test]
    fn retry_file_from_a_disconnected_job_does_not_suppress_its_replacement() {
        for scoped in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let conn = delivery::open_db(&dir.path().join("history.db")).unwrap();
            let old = delivery::create_job(&conn, &job_config(true), now()).unwrap();
            retry_verdict_of_another_build(dir.path(), &old.job_id, "0.26.1").unwrap();
            delivery::cancel_job(&conn, &old.job_id).unwrap();
            let mut marker = json!({ "probe_version": "0.26.1" });
            if scoped {
                marker["job_id"] = json!(old.job_id);
            }
            save_json(&dir.path().join("verdict-retry.json"), &marker).unwrap();

            let new = delivery::create_job(&conn, &job_config(true), now()).unwrap();
            assert_ne!(new.job_id, old.job_id);
            let block = || {
                conn.execute(
                    "UPDATE delivery_jobs SET state='blocked',failure='invalid_payload' WHERE id=?",
                    [&new.job_id],
                )
                .unwrap();
            };
            block();
            retry_verdict_of_another_build(dir.path(), &new.job_id, "0.26.1").unwrap();
            assert_eq!(
                delivery::status(&conn, &new.job_id).unwrap().state,
                "active"
            );
            let saved: serde_json::Value =
                serde_json::from_slice(&fs::read(dir.path().join("verdict-retry.json")).unwrap())
                    .unwrap();
            assert_eq!(saved["job_id"], new.job_id);
            block();
            retry_verdict_of_another_build(dir.path(), &new.job_id, "0.26.1").unwrap();
            assert_eq!(
                delivery::status(&conn, &new.job_id).unwrap().state,
                "blocked"
            );
        }
    }

    #[test]
    fn retry_file_for_the_same_job_preserves_its_verdict() {
        let dir = tempfile::tempdir().unwrap();
        let conn = delivery::open_db(&dir.path().join("history.db")).unwrap();
        let job = delivery::create_job(&conn, &job_config(true), now()).unwrap();
        conn.execute(
            "UPDATE delivery_jobs SET state='blocked',failure='invalid_payload' WHERE id=?",
            [&job.job_id],
        )
        .unwrap();
        let marker = dir.path().join("verdict-retry.json");
        save_json(
            &marker,
            &json!({ "job_id": job.job_id, "probe_version": "0.26.1" }),
        )
        .unwrap();
        retry_verdict_of_another_build(dir.path(), &job.job_id, "0.26.1").unwrap();
        assert_eq!(
            delivery::status(&conn, &job.job_id).unwrap().state,
            "blocked"
        );
        fs::remove_file(marker).unwrap();
        retry_verdict_of_another_build(dir.path(), &job.job_id, "0.26.1").unwrap();
        assert_eq!(
            delivery::status(&conn, &job.job_id).unwrap().state,
            "blocked"
        );
    }

    #[test]
    fn failed_build_record_defers_recovery_without_stopping_collection() {
        let dir = tempfile::tempdir().unwrap();
        let conn = delivery::open_db(&dir.path().join("history.db")).unwrap();
        let job = delivery::create_job(&conn, &job_config(true), now()).unwrap();
        conn.execute_batch("CREATE TRIGGER reject_retry_build BEFORE UPDATE OF retry_build ON delivery_jobs BEGIN SELECT RAISE(ABORT, 'synthetic marker failure'); END;").unwrap();
        for state in ["active", "blocked"] {
            conn.execute(
                "UPDATE delivery_jobs SET state=? WHERE id=?",
                [state, &job.job_id],
            )
            .unwrap();
            retry_verdict_of_another_build(dir.path(), &job.job_id, "0.26.1").unwrap();
            assert_eq!(delivery::status(&conn, &job.job_id).unwrap().state, state);
            assert!(!dir.path().join("verdict-retry.json").exists());
        }
        conn.execute_batch("DROP TRIGGER reject_retry_build")
            .unwrap();
        retry_verdict_of_another_build(dir.path(), &job.job_id, "0.26.1").unwrap();
        assert_eq!(
            delivery::status(&conn, &job.job_id).unwrap().state,
            "active"
        );
    }

    #[test]
    fn setup_retries_an_older_build_before_attempting_delivery() {
        for once in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let conn = delivery::open_db(&dir.path().join("history.db")).unwrap();
            let job = delivery::create_job(&conn, &job_config(true), now()).unwrap();
            let config = Config {
                version: 1,
                site_url: "https://synthetic.invalid".into(),
                account_id: "account".into(),
                account_email: None,
                account_name: None,
                account_avatar_url: None,
                workspace_name: None,
                org_id: "org".into(),
                workspace_id: "workspace".into(),
                // Stop at destination validation, before credentials/network.
                history_url: "invalid synthetic URL".into(),
                delivery_account: job.config.account_id,
                job_id: job.job_id,
                include_existing: true,
                sharing_mode: None,
                acknowledge_uninspected_schedules: false,
            };
            let block = || {
                conn.execute(
                    "UPDATE delivery_jobs SET state='blocked',failure='invalid_payload' WHERE id=?",
                    [&config.job_id],
                )
                .unwrap();
            };
            save_json(
                &dir.path().join("verdict-retry.json"),
                &json!({ "probe_version": "0.26.0" }),
            )
            .unwrap();
            block();
            assert!(finish_setup(dir.path(), &config, once).is_err());
            let status = delivery::status(&conn, &config.job_id).unwrap();
            assert_eq!(status.state, "active");
            assert_eq!(status.failure, None);

            block();
            assert!(finish_setup(dir.path(), &config, once).is_err());
            assert_eq!(
                delivery::status(&conn, &config.job_id).unwrap().state,
                "blocked"
            );
        }
    }

    #[test]
    fn stop_watch_ignores_other_generations_and_cancels_capture() {
        let dir = tempfile::tempdir().unwrap();
        save_json(&dir.path().join("stop.json"), &json!({"startup_id":"old"})).unwrap();
        let watch = StopWatch::start(dir.path(), "current");
        std::thread::sleep(Duration::from_millis(150));
        assert!(!stopping(&watch.cancelled));
        let started = Instant::now();
        save_json(
            &dir.path().join("stop.json"),
            &json!({"startup_id":"current"}),
        )
        .unwrap();
        while !stopping(&watch.cancelled) && started.elapsed() < Duration::from_secs(2) {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(stopping(&watch.cancelled));
        // The same token used by capture is also passed to the delivery drain.
        let stop = watch.cancelled.clone();
        let error = super::super::history::sync(
            &dir.path().join("history.db"),
            Duration::ZERO,
            false,
            |_| {},
            move || stopping(&stop),
        )
        .unwrap_err();
        assert!(matches!(
            error.downcast_ref::<ai_hist::Error>(),
            Some(ai_hist::Error::Cancelled(_))
        ));
        assert_eq!(capture_error_class(&error), "cancelled");
        assert!(!dir.path().join("history.db").exists());
    }

    #[test]
    fn development_revisions_do_not_order_by_hash() {
        assert_eq!(release("2026.10.4-dev+aaaa"), release("2026.10.4-dev+ffff"));
        assert!(release("2026.10.4-dev+ffff") < release("2026.10.4"));
        assert!(release("2026.10.4-dev+ffff") < release("2026.10.4-rc.1"));
        if agent_relay_probe::VERSION.contains("-dev+") {
            let dir = tempfile::tempdir().unwrap();
            let base = agent_relay_probe::VERSION.split('+').next().unwrap();
            save_json(
                &dir.path().join("runtime.json"),
                &json!({"version": format!("{base}+another-revision")}),
            )
            .unwrap();
            assert!(outdated(dir.path()));
            assert!(!newer_build(dir.path()));
        }
    }

    #[test]
    fn build_versions_order_by_release() {
        assert!(release("0.26.0") < release("0.26.2"));
        assert!(release("0.9.9") < release("0.26.0"));
        // A prerelease precedes its release, in semver order.
        assert!(release("0.27.0-rc.1") < release("0.27.0"));
        assert!(release("0.26.2") < release("0.27.0-rc.1"));
        assert!(release("1.0.0-alpha") < release("1.0.0-alpha.1"));
        assert!(release("1.0.0-alpha.1") < release("1.0.0-alpha.beta"));
        assert!(release("1.0.0-beta.2") < release("1.0.0-beta.11"));
        assert!(release("1.0.0-rc.1") < release("1.0.0"));
        assert_eq!(release("1.0.0+build.5"), release("1.0.0"));
        assert_eq!(release("older-build"), None);
        assert_eq!(release("1.0.0-"), None);
        assert_eq!(release("1.2"), None);
        assert_eq!(release("1.2.3.4"), None);
    }

    #[test]
    fn replacement_status_requires_an_outdated_live_run_and_matching_stop() {
        let dir = tempfile::tempdir().unwrap();
        let lock = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(dir.path().join("collector.lock"))
            .unwrap();
        lock.lock_exclusive().unwrap();
        save_json(
            &dir.path().join("runtime.json"),
            &json!({"startup_id":"old-run","version":"older-build"}),
        )
        .unwrap();
        assert!(!replacement_in_progress(dir.path()));
        save_json(
            &dir.path().join("stop.json"),
            &json!({"startup_id":"another-run"}),
        )
        .unwrap();
        assert!(!replacement_in_progress(dir.path()));
        save_json(
            &dir.path().join("stop.json"),
            &json!({"startup_id":"old-run"}),
        )
        .unwrap();
        // A stop file alone may be stale after an interrupted replacement.
        assert!(!replacement_in_progress(dir.path()));
        let control = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(dir.path().join("desktop.lock"))
            .unwrap();
        control.lock_exclusive().unwrap();
        assert!(replacement_in_progress(dir.path()));
        FileExt::unlock(&control).unwrap();
        assert!(!replacement_in_progress(dir.path()));
        FileExt::unlock(&lock).unwrap();
        assert!(!replacement_in_progress(dir.path()));
    }

    #[test]
    fn a_dead_newer_claim_does_not_suppress_supervision() {
        let dir = tempfile::tempdir().unwrap();
        save_json(
            &dir.path().join("runtime.json"),
            &json!({"startup_id":"phantom","pid":99999999,"ready":false,
                    "version":"999999.0.0"}),
        )
        .unwrap();
        assert!(newer_build(dir.path()));
        assert!(!newer_build_live(dir.path()));
        // A live pid alone does not own the claim: pids get recycled to
        // unrelated processes, so only the held collector lock proves the
        // claiming run still lives.
        save_json(
            &dir.path().join("runtime.json"),
            &json!({"startup_id":"self","pid":std::process::id(),"ready":true,
                    "version":"999999.0.0"}),
        )
        .unwrap();
        assert!(!newer_build_live(dir.path()));
        let lock = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(dir.path().join("collector.lock"))
            .unwrap();
        lock.lock_exclusive().unwrap();
        assert!(newer_build_live(dir.path()));
        FileExt::unlock(&lock).unwrap();
        assert!(!newer_build_live(dir.path()));
    }

    #[test]
    fn timed_out_replacement_keeps_ownership_through_a_handoff() {
        let dir = tempfile::tempdir().unwrap();
        let lock = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(dir.path().join("collector.lock"))
            .unwrap();
        lock.lock_exclusive().unwrap();
        save_json(
            &dir.path().join("runtime.json"),
            &json!({"startup_id":"old-run","version":"older-build"}),
        )
        .unwrap();
        let control = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(dir.path().join("desktop.lock"))
            .unwrap();
        control.lock_exclusive().unwrap();
        let handed_off = AtomicBool::new(false);
        let error = stop_for_replacement_with_timeout_and_handoff(
            dir.path(),
            Duration::ZERO,
            &|directory, startup_id| {
                assert_eq!(directory, dir.path());
                assert_eq!(startup_id, "old-run");
                handed_off.store(true, Ordering::Relaxed);
                Ok(())
            },
        )
        .unwrap_err();
        assert!(error
            .to_string()
            .contains("continue safely in the background"));
        assert!(handed_off.load(Ordering::Relaxed));
        assert!(running(dir.path()).unwrap());
        assert!(dir.path().join("stop.json").exists());
        assert!(replacement_in_progress(dir.path()));
    }

    #[test]
    fn stop_file_during_batch_preparation_prevents_send_and_keeps_pending_records() {
        struct StoppingReceiver<'a>(&'a Path);
        impl worker::Receiver for StoppingReceiver<'_> {
            fn mapping_version(&self) -> &str {
                destination::MAPPING_VERSION
            }
            fn supported_kinds(&self) -> &[&str] {
                delivery::SUPPORTED_KINDS
            }
            fn supports_tombstones(&self) -> bool {
                true
            }
            fn prepare(
                &self,
                _: &delivery::HistoryExportBatch,
                ctx: &worker::ReceiverContext<'_>,
            ) -> std::result::Result<worker::PreparedBody, worker::ReceiverFailure> {
                save_json(&self.0.join("stop.json"), &json!({"startup_id":"drain"})).unwrap();
                let deadline = Instant::now() + Duration::from_secs(2);
                while !(ctx.cancelled)() && Instant::now() < deadline {
                    std::thread::sleep(Duration::from_millis(10));
                }
                assert!(
                    (ctx.cancelled)(),
                    "normal stop must reach the receiver context"
                );
                Ok(worker::PreparedBody {
                    content_type: "application/json".into(),
                    body: "{}".into(),
                })
            }
            fn send(
                &self,
                _: &delivery::PreparedPayload,
                _: &delivery::HistoryExportBatch,
                _: &worker::ReceiverContext<'_>,
            ) -> std::result::Result<delivery::DeliveryAcknowledgment, worker::ReceiverFailure>
            {
                panic!("must not send after stop");
            }
        }
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("history.db");
        let conn = agent_relay_probe::delivery::open_db(&db).unwrap();
        conn.execute(
            "INSERT INTO sessions(source,session_id) VALUES ('claude','queued')",
            [],
        )
        .unwrap();
        let job = delivery::create_job(&conn, &job_config(true), now()).unwrap();
        let config = Config {
            version: 1,
            site_url: "https://agentrelay.com".into(),
            account_id: "account".into(),
            account_email: None,
            account_name: None,
            account_avatar_url: None,
            workspace_name: None,
            org_id: "org".into(),
            workspace_id: "workspace".into(),
            history_url: "https://history.agentrelay.com".into(),
            delivery_account: job.config.account_id,
            job_id: job.job_id,
            include_existing: true,
            sharing_mode: None,
            acknowledge_uninspected_schedules: false,
        };
        let stop = StopWatch::start(dir.path(), "drain");
        let status = deliver_with_receiver(&db, &config, &StoppingReceiver(dir.path()), &|| {
            stopping(&stop.cancelled)
        })
        .unwrap();
        assert!(stopping(&stop.cancelled));
        assert_eq!(status.state, "active");
        assert_eq!(status.acknowledged_records, 0);
        assert!(status.pending_records > 0);
        assert_eq!(status.failure, None);
        assert_eq!(status.next_attempt_ms, 0);
        let attempts: i64 = conn
            .query_row(
                "SELECT attempts FROM delivery_jobs WHERE id=?",
                [&config.job_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(attempts, 0);
        assert!(
            delivery::claim_batch(&conn, &config.job_id, "restarted", 60_000, &now)
                .unwrap()
                .is_some()
        );
    }

    #[test]
    fn sharing_stop_waits_for_collector_lock_release() {
        let dir = tempfile::tempdir().unwrap();
        let lock = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(dir.path().join("collector.lock"))
            .unwrap();
        lock.lock_exclusive().unwrap();
        save_json(
            &dir.path().join("runtime.json"),
            &json!({"startup_id":"test-run"}),
        )
        .unwrap();
        let release = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            FileExt::unlock(&lock).unwrap();
        });

        stop_for_change(dir.path()).unwrap();

        release.join().unwrap();
        assert!(stop_requested(dir.path(), "test-run"));
        assert!(!running(dir.path()).unwrap());
    }
    /// Claim batches until one survives exclusion, and report its sessions.
    fn claim_sessions(conn: &Connection, job_id: &str) -> Vec<String> {
        for _ in 0..500 {
            let prepared = delivery::prepare_batch(conn, job_id, now()).unwrap();
            if prepared.batch_id.is_none() {
                if prepared.bootstrap_complete && prepared.scanned_records == 0 {
                    break;
                }
                continue;
            }
            if let Some(claim) = delivery::claim_batch(conn, job_id, "test", 60_000, &now).unwrap()
            {
                return claim
                    .batch
                    .records
                    .iter()
                    .filter_map(|record| record.session_id.clone())
                    .collect();
            }
        }
        vec![]
    }
    /// A store failure keeps the class its typed cause had before the store
    /// flattened it, so the desktop still offers the matching action.
    #[test]
    fn store_failures_classify_like_their_causes() {
        use ai_hist::Error;
        for (error, class) in [
            (
                Error::Cancelled("local capture cancelled".into()),
                "cancelled",
            ),
            (
                Error::SyncFailed("database is locked".into()),
                "database_busy",
            ),
            (
                Error::SyncFailed("database or disk is full".into()),
                "disk_full",
            ),
            (
                Error::Query("database disk image is malformed".into()),
                "database_corrupt",
            ),
            (
                Error::SyncFailed("attempt to write a readonly database".into()),
                "permission_denied",
            ),
            (
                Error::DatabaseOpen("unable to open database file".into()),
                "database_unavailable",
            ),
            (
                Error::DatabaseOpen("migration failed".into()),
                "database_error",
            ),
            (
                Error::HydrationFailed("parser gave up".into()),
                "capture_error",
            ),
        ] {
            let error = anyhow::Error::from(error).context("selected session capture incomplete");
            assert_eq!(capture_error_class(&error), class);
        }
    }

    #[test]
    fn a_batch_that_cannot_be_prepared_is_not_reported_as_offline() {
        let failed = anyhow::anyhow!("feed upsert without its stored row")
            .context(delivery::PreparationFailed)
            .context("delivery pass");
        assert_eq!(capture_error_class(&failed), "upload_preparation_failed");
        let report = cycle_report(&Verdicts {
            capture: None,
            delivery: Some(capture_error_class(&failed).into()),
            run: None,
        });
        assert!(!report.to_string().contains("offline"));
        assert!(report["message"]
            .as_str()
            .unwrap()
            .contains("prepare local history"));
        // A typed cause under the marker still names the local condition.
        let busy = anyhow::Error::from(rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_BUSY),
            None,
        ))
        .context(delivery::PreparationFailed);
        assert_eq!(capture_error_class(&busy), "database_busy");
    }

    /// A session with prompts or events but no catalog row yet existed before
    /// setup all the same, so a new-only baseline withholds it.
    #[test]
    fn new_only_baseline_excludes_sessions_the_catalog_has_not_seen() {
        let (_dir, conn) = test_db();
        conn.execute(
            "INSERT INTO history(source, session_id, prompt, prompt_hash, timestamp_ms) \
             VALUES ('claude', 'history-only', 'before setup', 'h1', 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO session_events(source, session_id, ts_ms, role, kind, text, event_uid) \
             VALUES ('claude', 'events-only', 1, 'user', 'text', 'before setup', 'e1')",
            [],
        )
        .unwrap();
        let catalogued: i64 = conn
            .query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(catalogued, 0);
        assert_eq!(record_baseline(&conn, false).unwrap(), 2);
        for session_id in ["history-only", "events-only"] {
            let identity = delivery::SessionIdentity {
                source: "claude".into(),
                session_id: session_id.into(),
            };
            assert!(
                !delivery::is_shareable(&conn, &identity).unwrap(),
                "{session_id}"
            );
        }
        let job = delivery::create_job(&conn, &job_config(false), now()).unwrap();
        assert!(claim_sessions(&conn, &job.job_id).is_empty());
    }

    #[test]
    fn new_only_baseline_is_durable_and_independent_of_history_size() {
        let (_dir, conn) = test_db();
        for index in 0..1200 {
            conn.execute(
                "INSERT INTO sessions(source, session_id) VALUES ('claude', ?1)",
                [format!("11111111-2222-3333-4444-{index:012}")],
            )
            .unwrap();
        }
        let baseline = delivery::session_identities(&conn).unwrap();
        // The same identities carried inline would exceed the 64 KiB cap that
        // create_job enforces on a delivery configuration.
        assert!(serde_json::to_vec(&baseline).unwrap().len() > 65_536);
        assert_eq!(record_baseline(&conn, false).unwrap(), baseline.len());
        let config = job_config(false);
        assert!(!config.selection.sessionless);
        assert!(config.selection.excluded_sessions.is_empty());
        let job = delivery::create_job(&conn, &config, now()).unwrap();
        assert!(claim_sessions(&conn, &job.job_id).is_empty());
        assert!(
            delivery::status(&conn, &job.job_id)
                .unwrap()
                .suppressed_records
                > 0
        );
        conn.execute(
            "INSERT INTO sessions(source, session_id) VALUES ('claude','after')",
            [],
        )
        .unwrap();
        assert_eq!(
            claim_sessions(&conn, &job.job_id),
            vec!["after".to_string()]
        );
    }
    #[test]
    fn include_existing_records_no_baseline() {
        let (_dir, conn) = test_db();
        conn.execute(
            "INSERT INTO sessions(source, session_id) VALUES ('claude','before')",
            [],
        )
        .unwrap();
        assert_eq!(record_baseline(&conn, true).unwrap(), 0);
        let job = delivery::create_job(&conn, &job_config(true), now()).unwrap();
        assert_eq!(
            claim_sessions(&conn, &job.job_id),
            vec!["before".to_string()]
        );
    }
    #[test]
    fn an_abandoned_baseline_does_not_outlive_a_later_include_existing_setup() {
        let (_dir, conn) = test_db();
        conn.execute(
            "INSERT INTO sessions(source, session_id) VALUES ('claude','before')",
            [],
        )
        .unwrap();
        // Setup is interrupted after the snapshot, before any generation exists.
        assert_eq!(record_baseline(&conn, false).unwrap(), 1);
        // The next attempt chooses to share existing sessions instead.
        assert_eq!(record_baseline(&conn, true).unwrap(), 0);
        let job = delivery::create_job(&conn, &job_config(true), now()).unwrap();
        assert_eq!(
            claim_sessions(&conn, &job.job_id),
            vec!["before".to_string()]
        );
    }
    #[test]
    fn os_lock_releases_after_owner_exit_without_pid_reuse() {
        let directory = tempfile::tempdir().unwrap();
        let guard = lock(directory.path()).unwrap();
        assert!(running(directory.path()).unwrap());
        assert!(lock(directory.path()).is_err());
        drop(guard);
        assert!(!running(directory.path()).unwrap());
    }

    /// Capture and delivery now write the store from two threads at once:
    /// the watch's ticks hold the sync lock and write evidence while drains
    /// read the feed and write their own upload tables. The busy handlers
    /// on both sides absorb the overlap, so neither reports a locked
    /// database, and every captured record is delivered.
    #[test]
    fn a_capture_tick_and_a_drain_run_concurrently_without_lock_errors() {
        use super::super::live::{self, tests as support};
        struct Accepting(std::sync::atomic::AtomicU64);
        impl worker::Receiver for Accepting {
            fn mapping_version(&self) -> &str {
                destination::MAPPING_VERSION
            }
            fn supported_kinds(&self) -> &[&str] {
                delivery::SUPPORTED_KINDS
            }
            fn supports_tombstones(&self) -> bool {
                true
            }
            fn prepare(
                &self,
                _: &delivery::HistoryExportBatch,
                _: &worker::ReceiverContext<'_>,
            ) -> std::result::Result<worker::PreparedBody, worker::ReceiverFailure> {
                Ok(worker::PreparedBody {
                    content_type: "application/json".into(),
                    body: "{}".into(),
                })
            }
            fn send(
                &self,
                _: &delivery::PreparedPayload,
                batch: &delivery::HistoryExportBatch,
                _: &worker::ReceiverContext<'_>,
            ) -> std::result::Result<delivery::DeliveryAcknowledgment, worker::ReceiverFailure>
            {
                self.0.fetch_add(
                    batch
                        .records
                        .iter()
                        .filter(|record| record.kind == "session_event")
                        .count() as u64,
                    Ordering::SeqCst,
                );
                Ok(delivery::DeliveryAcknowledgment {
                    batch_id: batch.batch_id.clone(),
                    accepted_revision_ids: batch
                        .records
                        .iter()
                        .map(|record| record.revision_id.clone())
                        .collect(),
                    unsupported_revision_ids: vec![],
                    suppressed_revision_ids: vec![],
                    rejected_revision_ids: vec![],
                    isolation_frontier: vec![],
                    acceptance_level: delivery::AcceptanceLevel::Durable,
                })
            }
        }
        let Some(home) = support::isolated_home(
            "collector::tests::a_capture_tick_and_a_drain_run_concurrently_without_lock_errors",
        ) else {
            return;
        };
        let directory = home.join("probe");
        let db = directory.join("history.db");
        let job = delivery::create_job(&delivery::open_db(&db).unwrap(), &job_config(true), now())
            .unwrap();
        let config = support::config(&job, false);
        let project = home.join(".claude/projects/busy");
        fs::create_dir_all(&project).unwrap();
        const SESSIONS: usize = 8;
        const LINES: usize = 40;
        let cancelled = Arc::new(AtomicBool::new(false));
        let shared = Arc::new(live::Shared::default());
        let capture = live::start(
            &directory,
            &config,
            cancelled.clone(),
            shared.clone(),
            support::options(),
        );
        // Writes start once the thread follows the watch: the watcher is
        // attached and the forced catch-up sweep after it (the thread's
        // second sweep) has run. A write during the catch-up is read by that
        // sweep, or by a tick folded into the report only once it ends, so
        // it would not exercise a tick beside a drain.
        support::eventually("the catch-up sweep", Duration::from_secs(30), || {
            let report = shared.report().unwrap_or_default();
            report["driver"] == "fs-events" && report["sweeps"] == 2
        });
        let writer = {
            let project = project.clone();
            std::thread::spawn(move || {
                for line in 0..LINES {
                    for session in 0..SESSIONS {
                        support::append(
                            &project.join(format!("busy-{session}.jsonl")),
                            &support::transcript_line(
                                &format!("busy-{session}"),
                                &format!("line-{session}-{line}"),
                            ),
                        );
                    }
                    std::thread::sleep(Duration::from_millis(25));
                }
            })
        };
        let receiver = Accepting(std::sync::atomic::AtomicU64::new(0));
        let mut drains = 0;
        let expected = (SESSIONS * LINES) as u64;
        let start = Instant::now();
        while receiver.0.load(Ordering::SeqCst) < expected {
            assert!(
                start.elapsed() < Duration::from_secs(60),
                "delivered {} of {expected}: {:?}",
                receiver.0.load(Ordering::SeqCst),
                shared.report()
            );
            if let Err(error) = deliver_with_receiver(&db, &config, &receiver, &|| false) {
                panic!("drain {drains} failed: {}", capture_error_class(&error));
            }
            drains += 1;
            assert_ne!(
                shared.verdict(),
                Some(Some("database_busy".into())),
                "{:?}",
                shared.report()
            );
        }
        writer.join().unwrap();
        // A tick writes the store before the capture thread folds it into
        // the report, so a drain can deliver every line first. The fold of a
        // tick that wrote signals the wake, so wait on it for that fold.
        let deadline = Instant::now() + Duration::from_secs(30);
        let report = loop {
            let report = shared.report().unwrap();
            if report["ticks_waking_delivery"].as_u64() >= Some(1) {
                break report;
            }
            assert!(
                shared.wait(deadline, || false),
                "no tick that wrote was folded: {report}"
            );
        };
        assert_eq!(report["ticks_failed"], 0, "{report}");
        assert!(
            report["ticks_by_trigger"]["fs-event"].as_u64() >= Some(1),
            "{report}"
        );
        assert_eq!(shared.verdict(), Some(None));
        // How the burst splits is timing, not a contract: a drain keeps
        // preparing batches while records arrive, up to its time budget, and
        // a tick slowed by a loaded machine can read the whole burst, so one
        // drain or one tick may carry every line.
        drop(capture);
    }
}
