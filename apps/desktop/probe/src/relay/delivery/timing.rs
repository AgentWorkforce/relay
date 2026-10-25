//! Delivery timing: fixed in production, shortened in tests.

use std::time::Duration;

/// Timing, fixed in production and shortened in tests.
#[derive(Clone, Copy, Debug)]
pub struct DeliveryTiming {
    /// Safety-net queue read while push is live; push wakes bypass this.
    pub safety_poll: Duration,
    /// Initial fallback queue cadence; empty queues back off below heartbeat.
    pub fast_poll: Duration,
    pub heartbeat: Duration,
    /// Retry unit: a failed injection waits `min(30, 3 × 2^(n−1))` units, a
    /// waiting one 5.
    pub retry_unit: Duration,
    /// How often transcripts are checked for automatic final answers.
    pub replies: Duration,
    /// How often a terminal Claude Code session holding relay messages has
    /// its transcript checked for them (`claude::inbox`).
    pub inbox_check: Duration,
    /// How long such a session may hold one without progress before it is
    /// reported stalled.
    pub inbox_stall: Duration,
}

impl Default for DeliveryTiming {
    fn default() -> DeliveryTiming {
        DeliveryTiming {
            safety_poll: Duration::from_secs(5 * 60),
            fast_poll: Duration::from_secs(3),
            heartbeat: Duration::from_secs(30),
            retry_unit: Duration::from_secs(1),
            replies: Duration::from_secs(3),
            inbox_check: Duration::from_secs(30),
            inbox_stall: crate::relay::claude::inbox::DEFAULT_THRESHOLD,
        }
    }
}

impl DeliveryTiming {
    /// The defaults, with the inbox stall threshold from
    /// `RELAY_DESKTOP_CLAUDE_INBOX_STALL_SECS` when set.
    pub fn from_env(env: &dyn Fn(&str) -> Option<String>) -> DeliveryTiming {
        DeliveryTiming {
            inbox_stall: crate::relay::claude::inbox::threshold_from_env(env),
            ..DeliveryTiming::default()
        }
    }
}
