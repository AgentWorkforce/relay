use std::collections::VecDeque;
use std::time::{Duration, Instant};

use crate::helpers::strip_ansi;

/// Window after echo verification to wait for agent activity.
pub(crate) const ACTIVITY_WINDOW: Duration = Duration::from_secs(10);

/// Minimum bytes of non-echo output to count as agent activity.
const MIN_ACTIVITY_BYTES: usize = 20;

/// Tracks a single delivery awaiting activity confirmation.
#[derive(Debug, Clone)]
pub(crate) struct PendingActivity {
    pub delivery_id: String,
    pub event_id: String,
    pub request_id: Option<String>,
    /// The echo text to exclude from activity detection.
    pub echo_text: String,
    /// When the echo was verified (activity window starts here).
    pub verified_at: Instant,
    /// Bytes of non-echo output observed since verification.
    pub activity_bytes: usize,
}

/// Result of checking activity for a pending delivery.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ActivityResult {
    /// Agent produced significant output — message was processed.
    Confirmed {
        delivery_id: String,
        event_id: String,
        request_id: Option<String>,
        response_time_ms: u64,
    },
    /// Activity window expired without sufficient output.
    TimedOut {
        delivery_id: String,
        event_id: String,
        request_id: Option<String>,
    },
    /// Still waiting.
    Pending,
}

/// Monitors PTY output after echo verification to confirm
/// that the agent actually processed the injected message.
#[derive(Debug)]
pub(crate) struct ActivityMonitor {
    pending: VecDeque<PendingActivity>,
    activity_window: Duration,
}

impl ActivityMonitor {
    pub(crate) fn new() -> Self {
        Self {
            pending: VecDeque::new(),
            activity_window: ACTIVITY_WINDOW,
        }
    }

    #[cfg(test)]
    pub(crate) fn with_window(window: Duration) -> Self {
        Self {
            pending: VecDeque::new(),
            activity_window: window,
        }
    }

    /// Start tracking activity for a delivery after echo was verified.
    pub(crate) fn track(
        &mut self,
        delivery_id: String,
        event_id: String,
        request_id: Option<String>,
        echo_text: String,
    ) {
        self.pending.push_back(PendingActivity {
            delivery_id,
            event_id,
            request_id,
            echo_text,
            verified_at: Instant::now(),
            activity_bytes: 0,
        });
    }

    /// Feed new PTY output. Returns any deliveries that are now confirmed.
    pub(crate) fn feed_output(&mut self, raw_output: &str) -> Vec<ActivityResult> {
        let clean = strip_ansi(raw_output);
        let mut results = Vec::new();

        let mut i = 0;
        while i < self.pending.len() {
            let pa = &mut self.pending[i];

            // Count output bytes that aren't part of the echo itself.
            // The echo text may appear in output; subtract it.
            let relevant_bytes = count_non_echo_bytes(&clean, &pa.echo_text);
            pa.activity_bytes += relevant_bytes;

            if pa.activity_bytes >= MIN_ACTIVITY_BYTES {
                let pa = self.pending.remove(i).unwrap();
                let response_time_ms = pa.verified_at.elapsed().as_millis() as u64;
                results.push(ActivityResult::Confirmed {
                    delivery_id: pa.delivery_id,
                    event_id: pa.event_id,
                    request_id: pa.request_id,
                    response_time_ms,
                });
            } else {
                i += 1;
            }
        }

        results
    }

    /// Check for timed-out activity windows. Call periodically.
    pub(crate) fn check_timeouts(&mut self) -> Vec<ActivityResult> {
        let mut results = Vec::new();
        let mut i = 0;
        while i < self.pending.len() {
            if self.pending[i].verified_at.elapsed() >= self.activity_window {
                let pa = self.pending.remove(i).unwrap();
                results.push(ActivityResult::TimedOut {
                    delivery_id: pa.delivery_id,
                    event_id: pa.event_id,
                    request_id: pa.request_id,
                });
            } else {
                i += 1;
            }
        }
        results
    }

    /// Number of deliveries currently being monitored.
    pub(crate) fn pending_count(&self) -> usize {
        self.pending.len()
    }
}

/// Count bytes of output that aren't part of the echo text.
/// Simple heuristic: remove the first occurrence of echo_text from
/// the clean output and count remaining non-whitespace bytes.
fn count_non_echo_bytes(clean_output: &str, echo_text: &str) -> usize {
    // Remove echo text if present
    let remaining = if let Some(pos) = clean_output.find(echo_text) {
        let before = &clean_output[..pos];
        let after = &clean_output[pos + echo_text.len()..];
        format!("{}{}", before, after)
    } else {
        clean_output.to_string()
    };

    // Count non-whitespace, non-prompt characters
    remaining
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '>' && *c != '$' && *c != '%')
        .count()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn activity_confirmed_on_significant_output() {
        let mut monitor = ActivityMonitor::new();
        monitor.track(
            "d1".into(),
            "e1".into(),
            None,
            "Relay message from Alice [e1]: hello".into(),
        );

        // Feed the echo itself — shouldn't count
        let results = monitor.feed_output("Relay message from Alice [e1]: hello\n");
        assert!(results.is_empty());

        // Feed actual agent response
        let results = monitor.feed_output("I received your message and will process it now.\n");
        assert_eq!(results.len(), 1);
        match &results[0] {
            ActivityResult::Confirmed { delivery_id, .. } => {
                assert_eq!(delivery_id, "d1");
            }
            _ => panic!("expected Confirmed"),
        }
    }

    #[test]
    fn activity_not_confirmed_on_echo_only() {
        let mut monitor = ActivityMonitor::new();
        monitor.track(
            "d1".into(),
            "e1".into(),
            None,
            "Relay message from Alice [e1]: hello".into(),
        );

        let results = monitor.feed_output("Relay message from Alice [e1]: hello\n");
        assert!(results.is_empty());
        assert_eq!(monitor.pending_count(), 1);
    }

    #[test]
    fn activity_timeout() {
        let mut monitor = ActivityMonitor::with_window(Duration::from_millis(10));
        monitor.track("d1".into(), "e1".into(), None, "echo text".into());

        std::thread::sleep(Duration::from_millis(15));

        let results = monitor.check_timeouts();
        assert_eq!(results.len(), 1);
        match &results[0] {
            ActivityResult::TimedOut { delivery_id, .. } => {
                assert_eq!(delivery_id, "d1");
            }
            _ => panic!("expected TimedOut"),
        }
    }

    #[test]
    fn multiple_deliveries_tracked() {
        let mut monitor = ActivityMonitor::new();
        monitor.track("d1".into(), "e1".into(), None, "echo1".into());
        monitor.track("d2".into(), "e2".into(), None, "echo2".into());
        assert_eq!(monitor.pending_count(), 2);

        // Confirm first with enough output
        let results = monitor.feed_output("This is a long response from the agent for delivery one.");
        assert_eq!(results.len(), 2); // Both get confirmed since output is sufficient
    }

    #[test]
    fn count_non_echo_bytes_strips_echo() {
        let echo = "Relay message from Alice [e1]: hello";
        let output = "Relay message from Alice [e1]: hello\nACK: Starting task";
        assert!(count_non_echo_bytes(output, echo) >= 15);
    }

    #[test]
    fn count_non_echo_bytes_no_match() {
        let echo = "something else";
        let output = "actual agent output here";
        assert!(count_non_echo_bytes(output, echo) > 0);
    }
}
