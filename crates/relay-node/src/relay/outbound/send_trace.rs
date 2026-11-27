//! One diagnostic line for every send through the session socket
//! (`POST /send`), so support can trace a send a session says it made
//! (#2289): a hash of its idempotency key, the message id or the failure code,
//! the recipient, the total time and each stage's time. Never the text. The
//! line goes to the core's diagnostic log (`relay::diagnostics`, `core.log`).
//!
//! A send also has a deadline (`DEADLINE`), well under the session socket
//! client's own wait (`cli::SOCKET_TIMEOUT`) and Codex's 300 s tool-call
//! limit: past it the caller is told the send's state instead of waiting on.

use super::OutboundError;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::future::Future;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

/// How long one send may take, from the request to its receipt. The probe's
/// socket client waits 60 s (`cli::SOCKET_TIMEOUT`): answering first means
/// the caller learns whether anything was sent, instead of a client timeout
/// that cannot say.
pub(crate) const DEADLINE: Duration = Duration::from_secs(45);

/// Where a send is, in order. A send that never got further than
/// `Accepting` or `Uploading` sent nothing; one that reached `Writing` may
/// have been sent.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum Stage {
    /// Identifying the caller and checking the request.
    Accepting,
    /// Uploading its files.
    Uploading,
    /// Writing the message to Relaycast.
    Writing,
    /// Reading the answer: the message id, or why the recipient is unknown.
    Receipt,
}

#[derive(Default)]
struct Marks {
    /// When each stage after `Accepting` began.
    stages: Vec<(Stage, Instant)>,
    /// `@name`, `name@machine` or `#channel`.
    recipient: Option<String>,
    /// The key a retry generated, when the caller gave none.
    retry_key: Option<String>,
}

/// A send being traced. Cheap to clone: the clones share their marks.
#[derive(Clone)]
pub(crate) struct Trace {
    started: Instant,
    /// The caller's `Idempotency-Key`.
    key: Option<String>,
    marks: Arc<Mutex<Marks>>,
}

tokio::task_local! {
    static TRACE: Trace;
}

impl Trace {
    pub(crate) fn start(key: Option<&str>) -> Trace {
        Trace {
            started: Instant::now(),
            key: key.map(str::to_string),
            marks: Arc::default(),
        }
    }

    /// Runs `send` with this trace as the one `mark`, `recipient` and
    /// `retry_key` note on, under `DEADLINE`; logs the outcome and returns
    /// it.
    pub(crate) async fn run(
        self,
        deadline: Duration,
        send: impl Future<Output = Result<Value, OutboundError>>,
    ) -> Result<Value, OutboundError> {
        let outcome = match TRACE
            .scope(self.clone(), tokio::time::timeout(deadline, send))
            .await
        {
            Ok(outcome) => outcome,
            Err(_) => Err(self.timed_out(deadline)),
        };
        crate::relay::diagnostics::write(format_args!("{}", self.line(&outcome, Instant::now())));
        outcome
    }

    fn marks(&self) -> std::sync::MutexGuard<'_, Marks> {
        self.marks.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn stage(&self) -> Stage {
        self.marks()
            .stages
            .last()
            .map_or(Stage::Accepting, |(stage, _)| *stage)
    }

    /// What the caller is told when the send ran out of time: nothing was
    /// sent if it never began writing to Relaycast; otherwise it may have
    /// been, and sending it again with the same `Idempotency-Key` sends it
    /// once.
    fn timed_out(&self, deadline: Duration) -> OutboundError {
        let seconds = deadline.as_secs();
        if self.stage() >= Stage::Writing {
            OutboundError::new(
                504,
                "send_in_doubt",
                format!(
                    "Agent Relay did not get Relaycast's answer within {seconds} seconds: the message may have been sent. Check the conversation before sending it again; with the same Idempotency-Key it is sent at most once."
                ),
            )
        } else {
            OutboundError::new(
                504,
                "send_timed_out",
                format!(
                    "Agent Relay could not send within {seconds} seconds, and nothing was sent. Try again."
                ),
            )
        }
    }

    /// The diagnostic line for `outcome`, the send having ended at `now`.
    fn line(&self, outcome: &Result<Value, OutboundError>, now: Instant) -> String {
        let marks = self.marks();
        let millis = |from: Instant, to: Instant| to.saturating_duration_since(from).as_millis();
        // Each stage runs until the next one begins, or until the end.
        let mut stages = Vec::new();
        let mut from = (Stage::Accepting, self.started);
        for (stage, when) in marks.stages.iter().copied() {
            stages.push(format!("{}_ms={}", name(from.0), millis(from.1, when)));
            from = (stage, when);
        }
        stages.push(format!("{}_ms={}", name(from.0), millis(from.1, now)));
        let result = match outcome {
            Ok(answer) => format!(
                "outcome=sent message_id={}",
                answer["message_id"].as_str().unwrap_or("none")
            ),
            Err(error) => format!("outcome=failed code={} status={}", error.code, error.status),
        };
        let mut line = format!(
            "[send] idempotency={} to={} {result} total_ms={} {}",
            hashed(self.key.as_deref()),
            marks.recipient.as_deref().unwrap_or("none"),
            millis(self.started, now),
            stages.join(" "),
        );
        if let Some(retry) = &marks.retry_key {
            line.push_str(&format!(" retry_idempotency={}", hashed(Some(retry))));
        }
        line
    }
}

fn name(stage: Stage) -> &'static str {
    match stage {
        Stage::Accepting => "accept",
        Stage::Uploading => "upload",
        Stage::Writing => "write",
        Stage::Receipt => "receipt",
    }
}

/// An idempotency key as support can match it: the first 16 hex digits of
/// its SHA-256, so the key itself never reaches a log.
fn hashed(key: Option<&str>) -> String {
    match key {
        Some(key) => {
            let digest = Sha256::digest(key.as_bytes());
            let hex: String = digest.iter().take(8).map(|b| format!("{b:02x}")).collect();
            format!("sha256:{hex}")
        }
        None => "none".into(),
    }
}

/// The send under way has begun `stage`. Outside a traced send, nothing.
pub(crate) fn mark(stage: Stage) {
    let _ = TRACE.try_with(|trace| trace.marks().stages.push((stage, Instant::now())));
}

/// The send under way goes to `recipient`.
pub(crate) fn recipient(recipient: &str) {
    let _ = TRACE.try_with(|trace| trace.marks().recipient = Some(recipient.to_string()));
}

/// The send under way was retried with `key`, which it generated.
pub(crate) fn retry_key(key: &str) {
    let _ = TRACE.try_with(|trace| trace.marks().retry_key = Some(key.to_string()));
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn trace_at(stages: &[(Stage, u64)]) -> (Trace, Instant) {
        let trace = Trace::start(Some("probe-send-v1-abc"));
        let started = trace.started;
        {
            let mut marks = trace.marks();
            for (stage, at) in stages {
                marks
                    .stages
                    .push((*stage, started + Duration::from_millis(*at)));
            }
            marks.recipient = Some("alice@laptop".into());
        }
        (trace, started)
    }

    #[test]
    fn a_sent_message_is_logged_with_its_id_and_each_stage() {
        let (trace, started) = trace_at(&[
            (Stage::Uploading, 10),
            (Stage::Writing, 30),
            (Stage::Receipt, 130),
        ]);
        let line = trace.line(
            &Ok(json!({"message_id": "252146838325899264"})),
            started + Duration::from_millis(135),
        );
        assert_eq!(
            line,
            format!(
                "[send] idempotency={} to=alice@laptop outcome=sent message_id=252146838325899264 \
                 total_ms=135 accept_ms=10 upload_ms=20 write_ms=100 receipt_ms=5",
                hashed(Some("probe-send-v1-abc"))
            )
        );
        assert!(!line.contains("probe-send-v1-abc"), "never the key itself");
    }

    #[test]
    fn a_failure_is_logged_with_its_code_and_the_stage_it_stopped_in() {
        let (trace, started) = trace_at(&[(Stage::Uploading, 5)]);
        let line = trace.line(
            &Err(OutboundError::new(429, "rate_limited", "wait")),
            started + Duration::from_millis(7),
        );
        assert!(
            line.contains("outcome=failed code=rate_limited status=429"),
            "{line}"
        );
        assert!(line.ends_with("accept_ms=5 upload_ms=2"), "{line}");
        assert_eq!(hashed(None), "none");
    }

    // #2289: a send that runs out of time says whether anything was sent.
    #[test]
    fn running_out_of_time_says_whether_the_message_may_have_been_sent() {
        let (before, _) = trace_at(&[(Stage::Uploading, 5)]);
        assert_eq!(before.timed_out(DEADLINE).code, "send_timed_out");
        let (during, _) = trace_at(&[(Stage::Uploading, 5), (Stage::Writing, 9)]);
        let error = during.timed_out(DEADLINE);
        assert_eq!((error.status, error.code.as_str()), (504, "send_in_doubt"));
        assert!(DEADLINE < crate::relay::cli::SOCKET_TIMEOUT);
    }

    #[tokio::test]
    async fn a_send_past_its_deadline_is_answered_and_logged() {
        let trace = Trace::start(None);
        let outcome = trace
            .run(Duration::from_millis(20), async {
                mark(Stage::Writing);
                std::future::pending::<()>().await;
                unreachable!()
            })
            .await;
        assert_eq!(outcome.unwrap_err().code, "send_in_doubt");
    }
}
