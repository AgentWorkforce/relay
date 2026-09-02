use std::{
    borrow::Cow,
    collections::VecDeque,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde_json::{json, Value};

use crate::{
    ids::{DeliveryId, EventId, MessageTarget, RequestId, WorkspaceAlias, WorkspaceId},
    util::ansi::strip_ansi,
    worker::detection::ActivityDetector,
};

pub(crate) const ACTIVITY_WINDOW: Duration = Duration::from_secs(5);
pub(crate) const ACTIVITY_BUFFER_MAX_BYTES: usize = 16_000;
pub(crate) const ACTIVITY_BUFFER_KEEP_BYTES: usize = 12_000;
const VERIFICATION_OUTPUT_MAX_BYTES: usize = 16_000;
const VERIFICATION_OUTPUT_KEEP_BYTES: usize = 12_000;

#[derive(Debug, Clone, Copy)]
pub(crate) enum DeliveryOutcome {
    /// Delivery confirmed by echo verification.
    Success,
    /// Delivery acked via timeout fallback without echo verification.
    /// Neither speeds up nor backs off the throttle, but breaks the
    /// consecutive-success streak so unverified deliveries never drive
    /// the delay down.
    Unverified,
    Failed,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct ThrottleState {
    delay: Duration,
    consecutive_failures: u32,
    consecutive_successes: u32,
}

impl Default for ThrottleState {
    fn default() -> Self {
        Self {
            delay: Duration::from_millis(100),
            consecutive_failures: 0,
            consecutive_successes: 0,
        }
    }
}

impl ThrottleState {
    pub(crate) fn delay(&self) -> Duration {
        self.delay
    }

    pub(crate) fn record(&mut self, outcome: DeliveryOutcome) {
        match outcome {
            DeliveryOutcome::Success => {
                self.consecutive_failures = 0;
                self.consecutive_successes += 1;
                if self.consecutive_successes >= 3 {
                    self.consecutive_successes = 0;
                    let halved = Duration::from_millis(self.delay.as_millis() as u64 / 2);
                    self.delay = halved.max(Duration::from_millis(100));
                }
            }
            DeliveryOutcome::Unverified => {
                self.consecutive_successes = 0;
            }
            DeliveryOutcome::Failed => {
                self.consecutive_successes = 0;
                self.consecutive_failures += 1;
                self.delay = match self.consecutive_failures {
                    1 => Duration::from_millis(100),
                    2 => Duration::from_millis(200),
                    3 => Duration::from_millis(500),
                    4 => Duration::from_millis(1_000),
                    5 => Duration::from_millis(2_000),
                    _ => Duration::from_millis(5_000),
                };
            }
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct PendingActivity {
    pub delivery_id: DeliveryId,
    pub event_id: EventId,
    pub expected_echo: String,
    pub verified_at: Instant,
    pub output_buffer: String,
    pub detector: ActivityDetector,
}

/// Maximum number of injection attempts before accepting delivery via timeout.
/// Set to 1 to avoid re-injecting the same message when echo detection fails -
/// duplicate injections cause agents to process messages multiple times,
/// multiplying Relaycast API calls and triggering rate limits.
pub(crate) const MAX_VERIFICATION_ATTEMPTS: usize = 1;

/// Time window to wait for echo verification before accepting delivery.
pub(crate) const VERIFICATION_WINDOW: std::time::Duration = std::time::Duration::from_secs(5);

/// A pending delivery waiting for echo verification in PTY output.
#[derive(Debug)]
pub(crate) struct PendingVerification {
    pub delivery_id: DeliveryId,
    pub event_id: EventId,
    pub expected_echo: String,
    /// Receive-time PTY-output sequence captured atomically with queueing this
    /// delivery. Echo verification must never inspect chunks at or before this
    /// boundary: an identical earlier delivery may still be queued between the
    /// PTY reader and this event loop.
    pub output_boundary: u64,
    pub injected_at: std::time::Instant,
    pub attempts: usize,
    pub max_attempts: usize,
    pub request_id: Option<RequestId>,
    pub workspace_id: Option<WorkspaceId>,
    pub workspace_alias: Option<WorkspaceAlias>,
    pub from: String,
    pub body: String,
    pub target: MessageTarget,
}

#[derive(Debug)]
struct VerificationSegment {
    sequence: u64,
    start_offset: usize,
    end_offset: usize,
}

/// A bounded raw PTY-output tail indexed by producer-assigned read sequence.
///
/// The producer sequence, rather than consumer append position, lets a
/// delivery exclude an earlier chunk that was still queued when its write was
/// submitted. Raw bytes are retained so split UTF-8 cannot move bytes across a
/// sequence boundary; conversion is delayed until matching.
#[derive(Debug, Default)]
pub(crate) struct VerificationOutput {
    buffer: Vec<u8>,
    base_offset: usize,
    end_offset: usize,
    last_sequence: u64,
    segments: VecDeque<VerificationSegment>,
}

impl VerificationOutput {
    /// Producer sequence of the latest output appended by this consumer.
    pub(crate) fn boundary(&self) -> u64 {
        self.last_sequence
    }

    /// Append a producer-tagged raw PTY read.
    pub(crate) fn push_output(&mut self, sequence: u64, bytes: &[u8]) {
        debug_assert!(
            sequence > self.last_sequence,
            "PTY output sequences must be strictly monotonic"
        );
        let start_offset = self.end_offset;
        self.buffer.extend_from_slice(bytes);
        self.end_offset = self.end_offset.saturating_add(bytes.len());
        self.last_sequence = sequence;
        self.segments.push_back(VerificationSegment {
            sequence,
            start_offset,
            end_offset: self.end_offset,
        });
        self.trim();
    }

    /// Test/helper append that behaves like the next producer read.
    #[cfg(test)]
    pub(crate) fn push_str(&mut self, text: &str) {
        self.push_output(self.last_sequence.saturating_add(1), text.as_bytes());
    }

    fn trim(&mut self) {
        if self.buffer.len() > VERIFICATION_OUTPUT_MAX_BYTES {
            let start = self.buffer.len() - VERIFICATION_OUTPUT_KEEP_BYTES;
            self.buffer.drain(..start);
            self.base_offset = self.base_offset.saturating_add(start);
            while self
                .segments
                .front()
                .is_some_and(|segment| segment.end_offset <= self.base_offset)
            {
                self.segments.pop_front();
            }
        }
    }

    /// Retained output read after the supplied producer sequence.
    pub(crate) fn since(&self, boundary: u64) -> Cow<'_, str> {
        let Some(segment) = self
            .segments
            .iter()
            .find(|segment| segment.sequence > boundary)
        else {
            return Cow::Borrowed("");
        };
        let start = segment.start_offset.max(self.base_offset) - self.base_offset;
        String::from_utf8_lossy(&self.buffer[start..])
    }

    pub(crate) fn retained(&self) -> Cow<'_, str> {
        String::from_utf8_lossy(&self.buffer)
    }
}

/// Check a delivery only against output observed after its own submission.
pub(crate) fn pending_verification_echo_seen(
    output: &VerificationOutput,
    verification: &PendingVerification,
) -> bool {
    let observed = output.since(verification.output_boundary);
    check_echo_in_output(&observed, &verification.expected_echo)
}

/// Return a verification whose echo arrived before the PTY write ack was
/// processed, otherwise queue it for later output-driven verification.
///
/// Both wrap-mode and fleet PTY workers use this policy. Keeping the decision
/// here ensures the two delivery paths cannot drift on the echo-before-ack
/// race while still letting each caller perform its own confirmation effects.
pub(crate) fn queue_or_take_confirmed_verification(
    verification: PendingVerification,
    output: &VerificationOutput,
    pending_verifications: &mut std::collections::VecDeque<PendingVerification>,
) -> Option<PendingVerification> {
    if pending_verification_echo_seen(output, &verification) {
        Some(verification)
    } else {
        pending_verifications.push_back(verification);
        None
    }
}

/// Start activity detection with every post-submission byte already observed.
///
/// The PTY output arm can receive both the task echo and an activity marker
/// while a compound write is still awaiting its acknowledgement. When that
/// acknowledgement later confirms the delivery, seeding this buffer prevents
/// the already-observed activity from being lost merely because no more output
/// follows.
pub(crate) fn pending_activity_from_confirmed_output(
    verification: &PendingVerification,
    output: &VerificationOutput,
    detector: &ActivityDetector,
) -> PendingActivity {
    PendingActivity {
        delivery_id: verification.delivery_id.clone(),
        event_id: verification.event_id.clone(),
        expected_echo: verification.expected_echo.clone(),
        verified_at: Instant::now(),
        output_buffer: output.since(verification.output_boundary).into_owned(),
        detector: detector.clone(),
    }
}

/// Detect activity already buffered before confirmation or queue the seeded
/// state for later output. The returned activity carries the matched pattern
/// so each runtime can emit its own protocol event or log without duplicating
/// this race-handling policy.
pub(crate) fn queue_or_take_detected_activity(
    verification: &PendingVerification,
    output: &VerificationOutput,
    detector: &ActivityDetector,
    pending_activities: &mut std::collections::VecDeque<PendingActivity>,
) -> Option<(PendingActivity, String)> {
    let activity = pending_activity_from_confirmed_output(verification, output, detector);
    if let Some(pattern) = activity
        .detector
        .detect_activity(&activity.output_buffer, &activity.expected_echo)
    {
        Some((activity, pattern))
    } else {
        pending_activities.push_back(activity);
        None
    }
}

/// Check if the expected echo string appears in PTY output (after stripping ANSI).
pub(crate) fn check_echo_in_output(output: &str, expected: &str) -> bool {
    let clean = strip_ansi(output);
    clean.contains(expected)
}

pub(crate) fn current_timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis())
        .min(u128::from(u64::MAX)) as u64
}

pub(crate) fn delivery_queued_event_payload(
    delivery_id: &str,
    event_id: &str,
    worker_name: &str,
    timestamp_ms: u64,
) -> Value {
    json!({
        "delivery_id": delivery_id,
        "event_id": event_id,
        "worker_name": worker_name,
        "timestamp": timestamp_ms,
    })
}

pub(crate) fn delivery_injected_event_payload(
    delivery_id: &str,
    event_id: &str,
    worker_name: &str,
    timestamp_ms: u64,
) -> Value {
    json!({
        "delivery_id": delivery_id,
        "event_id": event_id,
        "worker_name": worker_name,
        "timestamp": timestamp_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn check_echo_clean_text() {
        let output = "some preamble\nRelay message from Alice [evt_1]: hello world\nmore output";
        assert!(check_echo_in_output(
            output,
            "Relay message from Alice [evt_1]: hello world"
        ));
    }

    #[test]
    fn check_echo_with_ansi() {
        let output =
            "\x1b[32mRelay message from Alice [evt_1]: hello world\x1b[0m\nsome other text";
        assert!(check_echo_in_output(
            output,
            "Relay message from Alice [evt_1]: hello world"
        ));
    }

    #[test]
    fn check_echo_no_match() {
        let output = "some unrelated output\nprompt> ";
        assert!(!check_echo_in_output(
            output,
            "Relay message from Alice [evt_1]: hello world"
        ));
    }

    #[test]
    fn check_echo_partial_match() {
        let output = "Relay message from Alice [evt_1]: hell";
        assert!(!check_echo_in_output(
            output,
            "Relay message from Alice [evt_1]: hello world"
        ));
    }

    #[test]
    fn check_echo_channel_format() {
        let output = "Relay message from Bob in #general [evt_2]: status update";
        assert!(check_echo_in_output(
            output,
            "Relay message from Bob in #general [evt_2]: status update"
        ));
    }

    #[test]
    fn verification_ignores_an_identical_echo_before_the_submission_boundary() {
        let expected = "Relay message from Alice [evt_repeat]: same body";
        let mut output = VerificationOutput::default();
        output.push_str(expected);
        let output_boundary = output.boundary();
        let verification = PendingVerification {
            delivery_id: "delivery-repeat".into(),
            event_id: "evt-repeat".into(),
            expected_echo: expected.to_string(),
            output_boundary,
            injected_at: Instant::now(),
            attempts: 1,
            max_attempts: 1,
            request_id: None,
            workspace_id: None,
            workspace_alias: None,
            from: "Alice".to_string(),
            body: "same body".to_string(),
            target: "Worker".into(),
        };

        assert!(!pending_verification_echo_seen(&output, &verification));
        output.push_str("\nnew output\n");
        assert!(!pending_verification_echo_seen(&output, &verification));
        output.push_str(expected);
        assert!(pending_verification_echo_seen(&output, &verification));
    }

    #[test]
    fn verification_ignores_matching_output_queued_before_write_submission() {
        let expected = "Relay message from Alice [evt-queued]: same body";
        let mut output = VerificationOutput::default();
        output.push_output(1, b"already consumed\n");

        // The producer has already assigned sequence 2, but this consumer has
        // not dequeued it yet. Queueing the write atomically returns that
        // producer watermark rather than the consumer's older boundary.
        let output_boundary = 2;
        let verification = PendingVerification {
            delivery_id: "delivery-queued".into(),
            event_id: "evt-queued".into(),
            expected_echo: expected.to_string(),
            output_boundary,
            injected_at: Instant::now(),
            attempts: 1,
            max_attempts: 1,
            request_id: None,
            workspace_id: None,
            workspace_alias: None,
            from: "Alice".to_string(),
            body: "same body".to_string(),
            target: "Worker".into(),
        };

        output.push_output(2, expected.as_bytes());
        assert!(
            !pending_verification_echo_seen(&output, &verification),
            "a matching chunk assigned before write submission must stay stale"
        );

        output.push_output(3, expected.as_bytes());
        assert!(
            pending_verification_echo_seen(&output, &verification),
            "the same echo read after write submission must verify"
        );
    }

    #[test]
    fn verification_offsets_remain_monotonic_when_the_tail_is_trimmed() {
        let mut output = VerificationOutput::default();
        output.push_str("old echo");
        let old_boundary = output.boundary();
        output.push_str(&"x".repeat(VERIFICATION_OUTPUT_MAX_BYTES));
        let after_first_trim = output.boundary();

        assert!(after_first_trim > old_boundary);
        assert_eq!(output.since(old_boundary), output.retained());

        let current_boundary = output.boundary();
        output.push_str("fresh echo");
        assert_eq!(output.since(current_boundary), "fresh echo");
        assert!(output.boundary() > after_first_trim);
    }

    #[test]
    fn immediate_confirmation_preserves_post_submission_activity() {
        let expected = "Relay message from Lead [evt-activity]: review this";
        let mut output = VerificationOutput::default();
        output.push_str("Tool: stale activity before this delivery\n");
        let output_boundary = output.boundary();
        output.push_str(expected);
        output.push_str("\nTool: Write(review.md)\n");
        let verification = PendingVerification {
            delivery_id: "delivery-activity".into(),
            event_id: "evt-activity".into(),
            expected_echo: expected.to_string(),
            output_boundary,
            injected_at: Instant::now(),
            attempts: 1,
            max_attempts: 1,
            request_id: None,
            workspace_id: None,
            workspace_alias: None,
            from: "Lead".to_string(),
            body: "review this".to_string(),
            target: "Worker".into(),
        };

        let mut pending_activities = std::collections::VecDeque::new();
        let (activity, pattern) = queue_or_take_detected_activity(
            &verification,
            &output,
            &ActivityDetector::for_cli("claude"),
            &mut pending_activities,
        )
        .expect("the already-buffered activity marker must be detected immediately");

        assert_eq!(pattern, "Tool:");
        assert!(!activity.output_buffer.contains("stale activity"));
        assert!(pending_activities.is_empty());
    }

    #[test]
    fn immediate_confirmation_queues_seeded_output_without_an_activity_marker() {
        let expected = "Relay message from Lead [evt-pending]: review this";
        let mut output = VerificationOutput::default();
        output.push_str("stale output before this delivery\n");
        let output_boundary = output.boundary();
        output.push_str(expected);
        let verification = PendingVerification {
            delivery_id: "delivery-pending".into(),
            event_id: "evt-pending".into(),
            expected_echo: expected.to_string(),
            output_boundary,
            injected_at: Instant::now(),
            attempts: 1,
            max_attempts: 1,
            request_id: None,
            workspace_id: None,
            workspace_alias: None,
            from: "Lead".to_string(),
            body: "review this".to_string(),
            target: "Worker".into(),
        };
        let mut pending_activities = std::collections::VecDeque::new();

        assert!(queue_or_take_detected_activity(
            &verification,
            &output,
            &ActivityDetector::for_cli("claude"),
            &mut pending_activities,
        )
        .is_none());
        let activity = pending_activities
            .pop_front()
            .expect("unmatched seeded output must remain pending");
        assert_eq!(activity.output_buffer, expected);
        assert!(!activity.output_buffer.contains("stale output"));
    }

    #[test]
    fn test_throttle_healthy() {
        let mut throttle = ThrottleState::default();
        for _ in 0..10 {
            throttle.record(DeliveryOutcome::Success);
        }
        assert_eq!(throttle.delay(), Duration::from_millis(100));
    }

    #[test]
    fn test_throttle_backoff() {
        let mut throttle = ThrottleState::default();
        throttle.record(DeliveryOutcome::Failed);
        assert_eq!(throttle.delay(), Duration::from_millis(100));
        throttle.record(DeliveryOutcome::Failed);
        assert_eq!(throttle.delay(), Duration::from_millis(200));
        throttle.record(DeliveryOutcome::Failed);
        assert_eq!(throttle.delay(), Duration::from_millis(500));
        throttle.record(DeliveryOutcome::Failed);
        assert_eq!(throttle.delay(), Duration::from_secs(1));
        throttle.record(DeliveryOutcome::Failed);
        assert_eq!(throttle.delay(), Duration::from_secs(2));
        throttle.record(DeliveryOutcome::Failed);
        assert_eq!(throttle.delay(), Duration::from_secs(5));
    }

    #[test]
    fn test_throttle_recovery() {
        let mut throttle = ThrottleState::default();
        for _ in 0..5 {
            throttle.record(DeliveryOutcome::Failed);
        }
        let failed_delay = throttle.delay();
        for _ in 0..3 {
            throttle.record(DeliveryOutcome::Success);
        }
        let expected = Duration::from_millis(failed_delay.as_millis() as u64 / 2);
        assert_eq!(throttle.delay(), expected);
    }

    #[test]
    fn throttle_delay_floor_never_below_100ms() {
        let mut throttle = ThrottleState::default();
        for _ in 0..100 {
            throttle.record(DeliveryOutcome::Success);
        }
        assert_eq!(throttle.delay(), Duration::from_millis(100));
    }

    #[test]
    fn throttle_cap_at_5s() {
        let mut throttle = ThrottleState::default();
        for _ in 0..20 {
            throttle.record(DeliveryOutcome::Failed);
        }
        assert_eq!(throttle.delay(), Duration::from_secs(5));
    }

    #[test]
    fn throttle_recovery_after_mixed_outcomes() {
        let mut throttle = ThrottleState::default();
        for _ in 0..3 {
            throttle.record(DeliveryOutcome::Failed);
        }
        assert_eq!(throttle.delay(), Duration::from_millis(500));
        throttle.record(DeliveryOutcome::Success);
        assert_eq!(throttle.delay(), Duration::from_millis(500));
        throttle.record(DeliveryOutcome::Success);
        throttle.record(DeliveryOutcome::Success);
        assert_eq!(throttle.delay(), Duration::from_millis(250));
    }

    #[test]
    fn throttle_unverified_keeps_delay_unchanged() {
        let mut throttle = ThrottleState::default();
        for _ in 0..3 {
            throttle.record(DeliveryOutcome::Failed);
        }
        assert_eq!(throttle.delay(), Duration::from_millis(500));
        for _ in 0..10 {
            throttle.record(DeliveryOutcome::Unverified);
        }
        assert_eq!(
            throttle.delay(),
            Duration::from_millis(500),
            "unverified deliveries must not change the delay in either direction"
        );
    }

    #[test]
    fn throttle_unverified_breaks_success_streak() {
        let mut throttle = ThrottleState::default();
        for _ in 0..3 {
            throttle.record(DeliveryOutcome::Failed);
        }
        assert_eq!(throttle.delay(), Duration::from_millis(500));
        throttle.record(DeliveryOutcome::Success);
        throttle.record(DeliveryOutcome::Success);
        throttle.record(DeliveryOutcome::Unverified);
        throttle.record(DeliveryOutcome::Success);
        assert_eq!(
            throttle.delay(),
            Duration::from_millis(500),
            "unverified deliveries must not count toward the success streak"
        );
    }

    #[test]
    fn throttle_failure_resets_success_counter() {
        let mut throttle = ThrottleState::default();
        throttle.record(DeliveryOutcome::Success);
        throttle.record(DeliveryOutcome::Success);
        throttle.record(DeliveryOutcome::Failed);
        throttle.record(DeliveryOutcome::Success);
        throttle.record(DeliveryOutcome::Success);
        assert_eq!(throttle.delay(), Duration::from_millis(100));
    }
}
