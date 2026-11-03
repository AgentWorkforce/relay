//! How `derive` tells an uploader that is retrying a slow receiver from one
//! that stopped trying.
use serde_json::Value;

/// Records have waited with nothing confirmed and nothing tried for
/// `SUSTAINED_FAILURE_MS`. An uploader still sending is not stalled: a
/// receiver that keeps answering 429 or 503 is slow, which the failure's own
/// stage reports.
pub(super) fn stopped_trying(delivery: &Value, pending: i64, now_ms: i64) -> bool {
    let attempting = delivery["last_attempt_ms"]
        .as_i64()
        .is_some_and(|at| now_ms.saturating_sub(at) < crate::delivery_status::SUSTAINED_FAILURE_MS);
    !attempting
        && crate::delivery_status::delivery_is_stalled(
            pending,
            delivery["last_acknowledged_ms"].as_i64(),
            delivery["oldest_pending_ms"].as_i64(),
            now_ms,
        )
}

/// A failure retried on its own: a transient one, or a rate limit, the
/// receiver pacing uploads at the time it names.
pub(super) fn retried(failure_code: &str) -> bool {
    matches!(failure_code, "transient" | "rate_limited")
}

/// The calm sentence while a retried failure is not sustained.
pub(super) fn message(delivery: &Value, failure_code: &str, pending: i64) -> String {
    let sent = delivery["acknowledged_records"]
        .as_i64()
        .unwrap_or(0)
        .max(0);
    let pace = if failure_code == "rate_limited" {
        "busy"
    } else {
        "slow"
    };
    format!("Server is {pace}; retrying. {sent} sent, {pending} queued.")
}
