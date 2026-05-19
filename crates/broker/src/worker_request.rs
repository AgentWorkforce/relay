//! Worker request/response correlation for the broker.
//!
//! Several broker → worker operations follow the same shape: the broker
//! sends a typed request frame to a wrapped worker over its
//! JSON-over-stdio pipe, then waits for a typed response frame back so it
//! can fulfil an HTTP / CLI caller's `oneshot`. `snapshot_pty` and the
//! session-mode routes (`mode` / `pending` / `flush`) all ride this
//! pattern, and new request/response routes are expected to as well.
//!
//! This module factors out the bookkeeping so each new route costs ~5
//! lines instead of ~80:
//!
//! * [`PendingRequest`] — one entry in the broker's correlation map,
//!   carrying the awaiter's `oneshot` and the timeout deadline.
//! * [`RequestWorkerError`] — the typed error returned to the awaiter
//!   (mapped to HTTP status codes by `listen_api::classify_error`).
//! * [`fulfil_response_frame`] — collapses the per-feature
//!   `*_response` worker-frame arms into a single dispatch.
//! * [`reap_expired`] — the timeout sweep used by the broker's reap tick.
//!
//! Sending the outbound request frame and parking the `PendingRequest`
//! happens inline in the broker loop's `ListenApiRequest::WorkerRequest`
//! arm — it needs `&mut WorkerRegistry`, `&mut HashMap`, and access to
//! `AgentRuntime` checks that live in `main.rs`, so wrapping it in a
//! helper here would not pay for itself.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use serde_json::Value;
use thiserror::Error;
use tokio::sync::oneshot;

/// Error returned to the broker's HTTP / CLI caller when a request/response
/// round-trip with a worker fails.
///
/// Variants are intentionally narrow so the API layer can map each to a
/// stable status code (see `listen_api::classify_error`). New variants here
/// require a matching arm in the classifier.
#[derive(Debug, Error)]
pub(crate) enum RequestWorkerError {
    /// No worker is registered under the given name.
    #[error("agent_not_found: {0}")]
    WorkerNotFound(String),

    /// The worker exists but its runtime does not support this request
    /// (e.g. `snapshot_pty` against a headless worker).
    #[error("unsupported_runtime: {0}")]
    UnsupportedRuntime(String),

    /// Failed to enqueue the request frame on the worker's stdin pipe.
    /// The worker may have died after the lookup succeeded.
    #[error("send_failed: {0}")]
    SendFailed(String),

    /// The worker did not respond before the deadline.
    #[error("worker_timeout: worker did not respond in time")]
    Timeout,

    /// The worker returned a structured `error` envelope.
    #[error("{code}: {message}")]
    WorkerError { code: String, message: String },

    /// The worker exited (cleanly or otherwise) while the broker was
    /// waiting for its response. The carried `String` is the worker
    /// name, for diagnostics. Mapped to HTTP 503 Service Unavailable
    /// in [`listen_api::classify_error`] — the agent existed when the
    /// request was sent but is no longer there to fulfil it.
    #[error("worker_disappeared: worker '{0}' exited before responding")]
    WorkerDisappeared(String),

    /// The broker dropped the awaiter's `oneshot` before responding
    /// (shutdown race). Reserved for future use: the API layer currently
    /// maps `oneshot::error::RecvError` from the broker channel directly
    /// to an internal-server-error response, but new call sites will
    /// need this variant once `request_worker` is wrapped in a fully
    /// async helper.
    #[allow(dead_code)]
    #[error("channel_closed: broker shut down before responding")]
    ChannelClosed,
}

/// One outstanding worker request, keyed by `request_id` in the broker's
/// correlation map. The awaiter's `oneshot` fires when the matching
/// `*_response` frame arrives or the deadline elapses (whichever first).
pub(crate) struct PendingRequest {
    /// What kind of request this is — only used for diagnostic logging
    /// when a response arrives with no matching caller.
    pub(crate) kind: String,
    /// Worker that the request was sent to — used for diagnostics on
    /// timeout.
    pub(crate) worker_name: String,
    /// Reply channel to the HTTP / CLI handler awaiting the response.
    pub(crate) reply: oneshot::Sender<Result<Value, RequestWorkerError>>,
    /// Wall-clock instant after which the request is considered timed
    /// out and the entry is dropped by the reap tick sweep.
    pub(crate) deadline: Instant,
}

/// Default deadline for worker request/response round-trips when callers
/// don't specify one explicitly. Matches the previous `snapshot` timeout.
pub(crate) const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(5);

/// Route a `*_response` worker frame to the matching parked
/// [`PendingRequest`].
///
/// Returns `true` if a pending entry was consumed (whether the awaiter
/// is still listening or not) and `false` if the response carried no
/// `request_id` or no entry was parked under it. Callers in the broker's
/// worker-frame handler use the return value purely for tracing.
///
/// Response frame shape:
///
/// ```json
/// { "type": "<kind>_response",
///   "request_id": "...",
///   "payload": { "error": { "code": "...", "message": "..." } } | { ... } }
/// ```
///
/// `payload.error` is treated as a structured worker-side failure and
/// mapped to [`RequestWorkerError::WorkerError`]; any other payload is
/// forwarded verbatim to the awaiter.
pub(crate) fn fulfil_response_frame(
    pending: &mut HashMap<String, PendingRequest>,
    frame: &Value,
) -> bool {
    let Some(request_id) = frame.get("request_id").and_then(Value::as_str) else {
        return false;
    };
    let Some(entry) = pending.remove(request_id) else {
        return false;
    };

    let payload = frame.get("payload").cloned().unwrap_or(Value::Null);
    let result = if let Some(error) = payload.get("error") {
        let code = error
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or("worker_error")
            .to_string();
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("worker reported an error")
            .to_string();
        Err(RequestWorkerError::WorkerError { code, message })
    } else {
        Ok(payload)
    };
    let _ = entry.reply.send(result);
    // `kind` and `worker_name` are read by the timeout sweep below; we
    // drop them here without inspection because the response succeeded
    // before they were needed for diagnostics.
    let _ = (entry.kind, entry.worker_name);
    true
}

/// Drop pending entries whose deadlines have elapsed and notify each
/// awaiter with [`RequestWorkerError::Timeout`]. Called from the broker's
/// reap tick.
///
/// Returns the list of `(request_id, worker_name, kind)` that were
/// reaped, for the caller to emit structured logs.
pub(crate) fn reap_expired(
    pending: &mut HashMap<String, PendingRequest>,
    now: Instant,
) -> Vec<(String, String, String)> {
    let timed_out: Vec<String> = pending
        .iter()
        .filter_map(|(req_id, entry)| {
            if entry.deadline <= now {
                Some(req_id.clone())
            } else {
                None
            }
        })
        .collect();

    let mut reaped = Vec::with_capacity(timed_out.len());
    for req_id in timed_out {
        if let Some(entry) = pending.remove(&req_id) {
            let worker_name = entry.worker_name.clone();
            let kind = entry.kind.clone();
            let _ = entry.reply.send(Err(RequestWorkerError::Timeout));
            reaped.push((req_id, worker_name, kind));
        }
    }
    reaped
}

/// Fail every pending request targeting `worker_name` immediately with
/// [`RequestWorkerError::WorkerDisappeared`]. Called from the broker's
/// worker-teardown paths (explicit release, `worker_exited` frame,
/// `reap_exited` sweep) so that in-flight HTTP callers don't have to
/// wait out the full request deadline when a worker has clearly gone.
///
/// Returns the `(request_id, kind)` pairs that were drained, for the
/// caller to emit structured logs.
pub(crate) fn fail_for_worker(
    pending: &mut HashMap<String, PendingRequest>,
    worker_name: &str,
) -> Vec<(String, String)> {
    let doomed: Vec<String> = pending
        .iter()
        .filter_map(|(req_id, entry)| {
            if entry.worker_name == worker_name {
                Some(req_id.clone())
            } else {
                None
            }
        })
        .collect();

    let mut failed = Vec::with_capacity(doomed.len());
    for req_id in doomed {
        if let Some(entry) = pending.remove(&req_id) {
            let kind = entry.kind.clone();
            let _ = entry.reply.send(Err(RequestWorkerError::WorkerDisappeared(
                worker_name.to_string(),
            )));
            failed.push((req_id, kind));
        }
    }
    failed
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn make_entry(
        kind: &str,
        worker: &str,
        deadline: Instant,
    ) -> (
        PendingRequest,
        oneshot::Receiver<Result<Value, RequestWorkerError>>,
    ) {
        let (tx, rx) = oneshot::channel();
        (
            PendingRequest {
                kind: kind.to_string(),
                worker_name: worker.to_string(),
                reply: tx,
                deadline,
            },
            rx,
        )
    }

    #[tokio::test]
    async fn fail_for_worker_drains_only_matching_entries() {
        let mut pending: HashMap<String, PendingRequest> = HashMap::new();
        let deadline = Instant::now() + Duration::from_secs(60);

        let (entry_a, rx_a) = make_entry("snapshot_pty", "alice", deadline);
        let (entry_b1, rx_b1) = make_entry("mode_get", "bob", deadline);
        let (entry_b2, rx_b2) = make_entry("snapshot_pty", "bob", deadline);
        let (entry_c, rx_c) = make_entry("snapshot_pty", "carol", deadline);
        pending.insert("req-a".to_string(), entry_a);
        pending.insert("req-b1".to_string(), entry_b1);
        pending.insert("req-b2".to_string(), entry_b2);
        pending.insert("req-c".to_string(), entry_c);

        let failed = fail_for_worker(&mut pending, "bob");

        // Both of bob's entries were drained — neither alice nor carol.
        assert_eq!(failed.len(), 2);
        assert_eq!(pending.len(), 2);
        assert!(pending.contains_key("req-a"));
        assert!(pending.contains_key("req-c"));
        assert!(!pending.contains_key("req-b1"));
        assert!(!pending.contains_key("req-b2"));

        // Each drained awaiter received WorkerDisappeared carrying the name.
        let err_b1 = rx_b1.await.expect("awaiter receives").expect_err("error");
        let err_b2 = rx_b2.await.expect("awaiter receives").expect_err("error");
        match (&err_b1, &err_b2) {
            (
                RequestWorkerError::WorkerDisappeared(n1),
                RequestWorkerError::WorkerDisappeared(n2),
            ) => {
                assert_eq!(n1, "bob");
                assert_eq!(n2, "bob");
            }
            other => panic!("expected WorkerDisappeared on both, got {other:?}"),
        }

        // Untouched awaiters' oneshots stay open (we already asserted
        // the map still contains their entries above).
        drop(rx_a);
        drop(rx_c);
    }

    #[tokio::test]
    async fn fulfil_response_frame_routes_payload_to_awaiter() {
        let mut pending: HashMap<String, PendingRequest> = HashMap::new();
        let (entry, rx) = make_entry(
            "snapshot_pty",
            "worker-a",
            Instant::now() + Duration::from_secs(5),
        );
        pending.insert("req-1".to_string(), entry);

        let frame = json!({
            "type": "snapshot_response",
            "request_id": "req-1",
            "payload": { "format": "plain", "screen": "hello" },
        });

        assert!(fulfil_response_frame(&mut pending, &frame));
        assert!(pending.is_empty());

        let received = rx.await.expect("reply channel should fire");
        let value = received.expect("payload should be Ok");
        assert_eq!(value["format"], json!("plain"));
        assert_eq!(value["screen"], json!("hello"));
    }

    #[tokio::test]
    async fn fulfil_response_frame_maps_error_envelope() {
        let mut pending: HashMap<String, PendingRequest> = HashMap::new();
        let (entry, rx) = make_entry(
            "snapshot_pty",
            "worker-a",
            Instant::now() + Duration::from_secs(5),
        );
        pending.insert("req-1".to_string(), entry);

        let frame = json!({
            "type": "snapshot_response",
            "request_id": "req-1",
            "payload": {
                "error": { "code": "invalid_format", "message": "boom" }
            },
        });

        assert!(fulfil_response_frame(&mut pending, &frame));
        let received = rx.await.expect("reply channel should fire");
        match received {
            Err(RequestWorkerError::WorkerError { code, message }) => {
                assert_eq!(code, "invalid_format");
                assert_eq!(message, "boom");
            }
            other => panic!("expected WorkerError, got {other:?}"),
        }
    }

    #[test]
    fn fulfil_response_frame_returns_false_without_request_id() {
        let mut pending: HashMap<String, PendingRequest> = HashMap::new();
        let frame = json!({ "type": "snapshot_response", "payload": {} });
        assert!(!fulfil_response_frame(&mut pending, &frame));
    }

    #[test]
    fn fulfil_response_frame_returns_false_when_no_entry() {
        let mut pending: HashMap<String, PendingRequest> = HashMap::new();
        let frame = json!({
            "type": "snapshot_response",
            "request_id": "missing",
            "payload": {},
        });
        assert!(!fulfil_response_frame(&mut pending, &frame));
    }

    #[tokio::test]
    async fn reap_expired_times_out_overdue_entries() {
        let mut pending: HashMap<String, PendingRequest> = HashMap::new();
        let now = Instant::now();

        let (entry_stale, rx_stale) =
            make_entry("snapshot_pty", "worker-a", now - Duration::from_millis(10));
        let (entry_fresh, _rx_fresh) =
            make_entry("snapshot_pty", "worker-b", now + Duration::from_secs(5));
        pending.insert("stale".to_string(), entry_stale);
        pending.insert("fresh".to_string(), entry_fresh);

        let reaped = reap_expired(&mut pending, now);
        assert_eq!(reaped.len(), 1);
        assert_eq!(reaped[0].0, "stale");
        assert_eq!(reaped[0].1, "worker-a");
        assert_eq!(reaped[0].2, "snapshot_pty");
        assert!(pending.contains_key("fresh"));

        let received = rx_stale.await.expect("reply channel should fire");
        assert!(matches!(received, Err(RequestWorkerError::Timeout)));
    }
}
