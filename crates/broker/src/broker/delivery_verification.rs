use std::{
    borrow::Cow,
    collections::VecDeque,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde_json::{json, Value};

use crate::{
    ids::{DeliveryId, EventId, MessageTarget, RequestId, WorkspaceAlias, WorkspaceId},
    readiness::{cli_prompt_ready, GridReadinessSnapshot},
    snapshot::Snapshot,
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
    #[allow(dead_code)]
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

/// Maximum number of submit-key attempts for one already-written body.
///
/// A retry never writes the body again: it only nudges a composer that is
/// still proven to contain this delivery. This preserves at-most-once turn
/// creation while giving paste-aware TUIs a bounded recovery path.
pub(crate) const MAX_VERIFICATION_ATTEMPTS: usize = 3;

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
    #[allow(dead_code)]
    pub workspace_id: Option<WorkspaceId>,
    #[allow(dead_code)]
    pub workspace_alias: Option<WorkspaceAlias>,
    #[allow(dead_code)]
    pub from: String,
    #[allow(dead_code)]
    pub body: String,
    #[allow(dead_code)]
    pub target: MessageTarget,
    /// The formatted body appeared in post-submission PTY output. This proves
    /// terminal echo only; it does not prove the harness accepted a turn.
    pub echo_seen: bool,
    /// Post-submission output retained until a harness activity marker proves
    /// the turn started. Kept separately from `VerificationOutput` so matching
    /// remains stable after the global tail trims.
    pub activity_buffer: String,
    pub detector: ActivityDetector,
}

impl PendingVerification {
    pub(crate) fn observe(&mut self, output: &VerificationOutput, text: &str) {
        let echo_now = pending_verification_echo_seen(output, self);
        if !self.echo_seen && echo_now {
            // Ignore activity that preceded the editor echo. A message may be
            // injected while a previous turn is still rendering its own busy
            // marker; that marker cannot prove this delivery was accepted.
            self.echo_seen = true;
            self.activity_buffer.clear();
            let clean = strip_ansi(text);
            if let Some(index) = clean.rfind(&self.expected_echo) {
                self.activity_buffer
                    .push_str(&clean[index + self.expected_echo.len()..]);
            }
        } else if self.echo_seen {
            self.activity_buffer.push_str(text);
        }
        if self.activity_buffer.len() > ACTIVITY_BUFFER_MAX_BYTES {
            let start = crate::util::ansi::floor_char_boundary(
                &self.activity_buffer,
                self.activity_buffer.len() - ACTIVITY_BUFFER_KEEP_BYTES,
            );
            self.activity_buffer = self.activity_buffer[start..].to_string();
        }
    }

    pub(crate) fn accepted_activity(&self) -> Option<String> {
        if !self.echo_seen || !self.detector.has_explicit_patterns() {
            return None;
        }
        self.detector
            .detect_activity(&self.activity_buffer, &self.expected_echo)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum HarnessAcceptance {
    Accepted(String),
    Parked,
    Inconclusive,
}

fn compact_render(text: &str) -> String {
    text.chars()
        .filter(|character| !character.is_whitespace())
        .collect()
}

fn expected_tail(expected: &str) -> String {
    let compact = compact_render(expected);
    let keep = compact.len().min(96);
    let start = crate::util::ansi::floor_char_boundary(&compact, compact.len() - keep);
    compact[start..].to_string()
}

fn current_composer(snapshot: &Snapshot, cli: &str) -> Option<String> {
    let plain = snapshot.to_plain();
    let lines: Vec<_> = plain.lines().collect();
    let end = snapshot.cursor.0.checked_sub(1)? as usize;
    if end >= lines.len() {
        return None;
    }
    let lower = cli.to_ascii_lowercase();
    let is_prompt = |line: &&str| {
        let trimmed = line.trim_start();
        if lower.contains("codex") {
            trimmed == "›"
                || trimmed.starts_with("› ")
                || trimmed == "codex>"
                || trimmed.starts_with("codex> ")
        } else if lower.contains("claude") {
            trimmed == "❯"
                || trimmed.starts_with("❯ ")
                || trimmed == ">"
                || trimmed.starts_with("> ")
        } else if crate::readiness::is_devin_cli(cli) {
            trimmed == "❭" || trimmed.starts_with("❭ ")
        } else {
            trimmed == ">"
                || trimmed.starts_with("> ")
                || trimmed == "$"
                || trimmed.starts_with("$ ")
                || trimmed == ">>>"
                || trimmed.starts_with(">>> ")
                || trimmed == "›"
                || trimmed.starts_with("› ")
                || trimmed == "❯"
                || trimmed.starts_with("❯ ")
        }
    };
    let start = lines.iter().take(end + 1).rposition(is_prompt)?;
    Some(lines[start..=end].join("\n"))
}

fn codex_busy(screen: &str) -> bool {
    screen.lines().any(|line| {
        let lower = line.to_ascii_lowercase();
        lower.contains("working") && lower.contains("esc to interrupt")
    })
}

fn composer_is_idle(snapshot: &Snapshot, cli: &str) -> bool {
    let screen = snapshot.to_plain();
    if cli.to_ascii_lowercase().contains("codex") && codex_busy(&screen) {
        return false;
    }
    cli_prompt_ready(
        cli,
        GridReadinessSnapshot {
            screen: &screen,
            cursor: Some(snapshot.cursor),
        },
    ) && current_composer(snapshot, cli)
        .map(|composer| {
            let trimmed = composer.trim();
            matches!(trimmed, "›" | "codex>" | "❯" | ">" | "$" | ">>>")
                || trimmed.contains("Ask Codex to do anything")
                || trimmed.contains("Type your message or @path/to/file")
                || trimmed.contains("Ask Devin to build features, fix bugs, or work on your code")
        })
        .unwrap_or(false)
}

/// Distinguish terminal echo from actual harness acceptance.
///
/// Activity is definitive acceptance. A body is considered parked only when
/// its tail is still in the live composer at the cursor. Once echo was seen,
/// a proven empty composer is also acceptance. Every other state is
/// inconclusive and must fail or wait — never blindly press a key.
pub(crate) fn assess_harness_acceptance(
    cli: &str,
    verification: &PendingVerification,
    snapshot: &Snapshot,
) -> HarnessAcceptance {
    if let Some(pattern) = verification.accepted_activity() {
        return HarnessAcceptance::Accepted(format!("activity:{pattern}"));
    }

    let tail = expected_tail(&verification.expected_echo);
    let parked = !tail.is_empty()
        && current_composer(snapshot, cli)
            .map(|composer| compact_render(&composer).contains(&tail))
            .unwrap_or(false);
    if parked {
        return HarnessAcceptance::Parked;
    }
    if verification.echo_seen && composer_is_idle(snapshot, cli) {
        return HarnessAcceptance::Accepted("composer_cleared".to_string());
    }
    HarnessAcceptance::Inconclusive
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

/// Start activity detection with every post-submission byte already observed.
///
/// The PTY output arm can receive both the task echo and an activity marker
/// while a compound write is still awaiting its acknowledgement. When that
/// acknowledgement later confirms the delivery, seeding this buffer prevents
/// the already-observed activity from being lost merely because no more output
/// follows.
#[cfg(test)]
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
#[cfg(test)]
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

    fn codex_verification(expected: &str) -> PendingVerification {
        PendingVerification {
            delivery_id: "delivery-acceptance".into(),
            event_id: "event-acceptance".into(),
            expected_echo: expected.to_string(),
            output_boundary: 0,
            injected_at: Instant::now(),
            attempts: 1,
            max_attempts: MAX_VERIFICATION_ATTEMPTS,
            request_id: None,
            workspace_id: None,
            workspace_alias: None,
            from: "Lead".to_string(),
            body: "fix idle injection".to_string(),
            target: "Worker".into(),
            echo_seen: true,
            activity_buffer: String::new(),
            detector: ActivityDetector::for_cli("codex"),
        }
    }

    #[cfg(unix)]
    async fn codex_snapshot(screen: &str) -> (crate::pty::PtySession, Snapshot) {
        let encoded = base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            screen.as_bytes(),
        );
        let script = format!(
            "stty raw -echo; printf '\\033[2J\\033[H'; printf '%s' '{encoded}' | base64 -d; sleep 3"
        );
        let (pty, mut rx) =
            crate::pty::PtySession::spawn("/bin/sh", &["-c".into(), script], 24, 120).unwrap();
        let expected_tail = screen.chars().last().unwrap_or('›');
        for _ in 0..100 {
            let _ = tokio::time::timeout(Duration::from_millis(20), rx.recv()).await;
            if pty.screen_text().contains(expected_tail) {
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(30)).await;
        let snapshot = Snapshot::capture(&pty);
        (pty, snapshot)
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn editor_echo_is_parked_until_codex_accepts_the_turn() {
        let expected = "Relay message from Lead [evt]: fix idle injection";
        let (pty, snapshot) = codex_snapshot(&format!("› {expected}")).await;
        let verification = codex_verification(expected);

        assert_eq!(
            assess_harness_acceptance("codex", &verification, &snapshot),
            HarnessAcceptance::Parked,
            "visible composer text must never be mistaken for acceptance"
        );
        pty.shutdown().unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn codex_activity_and_cleared_composer_prove_acceptance() {
        let expected = "Relay message from Lead [evt]: fix idle injection";
        let (busy_pty, busy_snapshot) = codex_snapshot(&format!("› {expected}")).await;
        let mut active = codex_verification(expected);
        active
            .activity_buffer
            .push_str("Working (1s • esc to interrupt)");
        assert!(matches!(
            assess_harness_acceptance("codex", &active, &busy_snapshot),
            HarnessAcceptance::Accepted(ref evidence) if evidence.starts_with("activity:")
        ));
        busy_pty.shutdown().unwrap();

        let (idle_pty, idle_snapshot) = codex_snapshot("› Ask Codex to do anything").await;
        let cleared = codex_verification(expected);
        assert_eq!(
            assess_harness_acceptance("codex", &cleared, &idle_snapshot),
            HarnessAcceptance::Accepted("composer_cleared".to_string())
        );
        idle_pty.shutdown().unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn generic_redraw_cannot_confirm_a_body_still_parked() {
        let expected = "Relay message from Lead [evt]: fix idle injection";
        let (pty, snapshot) = codex_snapshot(&format!("› {expected}")).await;
        let mut verification = codex_verification(expected);
        verification.detector = ActivityDetector::for_cli("muse");
        verification
            .activity_buffer
            .push_str("composer repaint after echo");

        assert_eq!(
            assess_harness_acceptance("muse", &verification, &snapshot),
            HarnessAcceptance::Parked,
            "generic output must not outrank a visibly parked composer"
        );
        pty.shutdown().unwrap();
    }

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
            echo_seen: false,
            activity_buffer: String::new(),
            detector: ActivityDetector::for_cli("codex"),
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
            echo_seen: false,
            activity_buffer: String::new(),
            detector: ActivityDetector::for_cli("codex"),
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
            echo_seen: false,
            activity_buffer: String::new(),
            detector: ActivityDetector::for_cli("claude"),
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
            echo_seen: false,
            activity_buffer: String::new(),
            detector: ActivityDetector::for_cli("claude"),
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
