//! When upload delivery counts as stalled or failing: pure rules over the
//! collector's reported counters, shared by the upload queue (`delivery`,
//! with the `history` feature) and the relay core's uploader status, which
//! builds without it.

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
