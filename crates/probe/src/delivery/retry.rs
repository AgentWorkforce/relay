//! How long a failed delivery waits before its next attempt, and how an
//! explicit retry or an update shortens that wait.
use super::{job, status, write_transaction, DeliveryFailure, DeliveryStatus};
use anyhow::{ensure, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};

/// Longest wait after a transient failure (a 5xx, a non-conflict 409, a
/// transport or local error). A receiver that recovers is tried again within
/// this, plus jitter, however long it was down: an outage of hours used to
/// leave the uploader idle for up to the twenty-minute step it had reached.
/// It matches `SUSTAINED_FAILURE_MS`, so a failing upload is retried about as
/// often as the app re-evaluates whether it is stalled, and one request every
/// five minutes per computer is no load on a receiver that is down.
pub const TRANSIENT_BACKOFF_CEILING_MS: i64 = 5 * 60 * 1_000;
/// Longest wait after a rate limit (HTTP 408, 425 or 429) that named no wait
/// of its own. The receiver asked for less traffic, so the backoff keeps
/// growing to an hour. A receiver `Retry-After` replaces this backoff.
pub const RATE_LIMITED_BACKOFF_CEILING_MS: i64 = 60 * 60 * 1_000;

/// The wait before the next attempt after `attempts` consecutive claims:
/// 1 s doubled per attempt up to the failure's ceiling, plus up to a fifth
/// of jitter, seeded by the batch so concurrent computers spread out.
pub(super) fn retry_backoff_ms(failure: DeliveryFailure, attempts: i64, seed: &str) -> i64 {
    let ceiling = match failure {
        DeliveryFailure::RateLimited => RATE_LIMITED_BACKOFF_CEILING_MS,
        _ => TRANSIENT_BACKOFF_CEILING_MS,
    };
    let backoff = 1_000_i64
        .saturating_mul(1_i64 << attempts.clamp(0, 12))
        .min(ceiling);
    let digest = Sha256::digest(format!("{seed}:{attempts}"));
    let jitter = (u16::from_be_bytes([digest[0], digest[1]]) as i64) * backoff / 327_675;
    backoff + jitter
}

/// An explicit retry from the person: restart a blocked job, or wake an
/// active one waiting out a transient failure's backoff so a receiver that
/// has recovered is tried at once instead of after the rest of the wait.
/// Returns whether the job changed.
///
/// The check and the reset share one write transaction. A paused or
/// cancelled job is left as it is, and so is a job with a live lease: a
/// batch is in flight and its own outcome decides what happens next, so the
/// wake must not fence it. A receiver-directed wait stands, however long it
/// is. A client-generated rate-limit wait longer than
/// `TRANSIENT_BACKOFF_CEILING_MS` is woken: it is doubling backoff an older
/// build grew, and would otherwise idle uploads for up to an hour after the
/// contention passed. The wake keeps `attempts`, so a receiver that is still
/// down fails straight back to its ceiling rather than starting over.
pub fn retry_requested(conn: &Connection, job_id: &str, now_ms: i64) -> Result<bool> {
    let tx = write_transaction(conn)?;
    let (state, failure, next_attempt_ms, receiver_retry_after_ms, lease_until_ms): (
        String,
        Option<String>,
        i64,
        i64,
        Option<i64>,
    ) = tx
        .query_row(
            "SELECT state,failure,next_attempt_ms,receiver_retry_after_ms,lease_until_ms FROM delivery_jobs WHERE id=?",
            [job_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .optional()?
        .context("delivery job not found")?;
    let receiver_directed = receiver_retry_after_ms == next_attempt_ms;
    let wakes = !receiver_directed
        && match failure.as_deref() {
            Some(code) if code == DeliveryFailure::Transient.code() => next_attempt_ms > now_ms,
            Some(code) if code == DeliveryFailure::RateLimited.code() => {
                next_attempt_ms > now_ms.saturating_add(TRANSIENT_BACKOFF_CEILING_MS)
            }
            _ => false,
        };
    let waiting_out_backoff =
        state == "active" && wakes && lease_until_ms.is_none_or(|until| until <= now_ms);
    let retried = state == "blocked" || waiting_out_backoff;
    if retried {
        reset_job_retry(&tx, job_id)?;
    }
    tx.commit()?;
    Ok(retried)
}

/// Bring a client-generated transient or rate-limited wait, whose backoff an
/// older build grew to an hour, within the transient ceiling. A receiver's
/// explicit Retry-After, a paused or blocked job and a live lease stand. The
/// collector does this as it starts (`retry_job_for_build`).
///
/// Builds before 2026.10.62 never honored a server `Retry-After`: every
/// rate limit's wait came from the attempts-based schedule, out to an hour,
/// and installing a build that honors it left that wait standing. The new
/// column defaults legacy rows to client-generated; all newly explicit
/// waits are marked and never shortened. `attempts` is kept, so a receiver
/// still answering 429 restores either its Retry-After or the full schedule.
pub fn clamp_retry_wait(conn: &Connection, job_id: &str, now_ms: i64) -> Result<bool> {
    let tx = write_transaction(conn)?;
    let changed = clamp_in(&tx, job_id, now_ms)?;
    tx.commit()?;
    Ok(changed)
}

fn clamp_in(conn: &Connection, job_id: &str, now_ms: i64) -> Result<bool> {
    let latest = now_ms.saturating_add(TRANSIENT_BACKOFF_CEILING_MS);
    Ok(conn.execute(
        "UPDATE delivery_jobs SET next_attempt_ms=?2 WHERE id=?1 AND state='active' AND failure IN ('transient','rate_limited') AND receiver_retry_after_ms<>next_attempt_ms AND next_attempt_ms>?2 AND COALESCE(lease_until_ms<=?3,1)",
        params![job_id, latest, now_ms],
    )? == 1)
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
/// Active, paused and cancelled jobs record the build without changing state,
/// except that a long retry wait is clamped (`clamp_retry_wait`): the
/// collector runs this as it starts, which an update always does.
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
    clamp_in(&tx, job_id, chrono::Utc::now().timestamp_millis())?;
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
    conn.execute("UPDATE delivery_jobs SET state='active',failure=NULL,next_attempt_ms=0,receiver_retry_after_ms=0,fence=fence+1,worker_id=NULL,lease_until_ms=NULL WHERE id=?",[job_id])?;
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
