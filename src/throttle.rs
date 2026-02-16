use std::collections::VecDeque;
use std::time::{Duration, Instant};

/// Default injection interval (50ms).
const DEFAULT_INTERVAL_MS: u64 = 50;
/// Minimum injection interval (20ms) — floor for fast agents.
const MIN_INTERVAL_MS: u64 = 20;
/// Maximum injection interval (500ms) — ceiling for slow agents.
const MAX_INTERVAL_MS: u64 = 500;

/// Number of recent samples to keep for moving average.
const WINDOW_SIZE: usize = 20;

/// Success rate below which we slow down.
const SLOW_DOWN_THRESHOLD: f64 = 0.7;
/// Success rate above which we speed up.
const SPEED_UP_THRESHOLD: f64 = 0.9;

/// Multiplicative factor for slowing down.
const SLOW_DOWN_FACTOR: f64 = 1.3;
/// Multiplicative factor for speeding up.
const SPEED_UP_FACTOR: f64 = 0.85;

/// A sample recording the outcome of a delivery.
#[derive(Debug, Clone, Copy)]
struct DeliverySample {
    /// Whether echo verification succeeded.
    echo_verified: bool,
    /// Whether activity was confirmed (None if still pending or not tracked).
    activity_confirmed: Option<bool>,
    /// Time from injection to echo verification (if verified).
    echo_latency_ms: Option<u64>,
    /// Time from echo to activity confirmation (if confirmed).
    activity_latency_ms: Option<u64>,
    /// When this sample was recorded.
    recorded_at: Instant,
}

/// Adaptive throttle that adjusts the PTY injection interval
/// based on echo verification and activity confirmation success rates.
#[derive(Debug)]
pub(crate) struct AdaptiveThrottle {
    /// Current injection interval.
    current_interval: Duration,
    /// Recent delivery samples.
    samples: VecDeque<DeliverySample>,
    /// Last time the interval was adjusted.
    last_adjustment: Instant,
    /// Minimum time between adjustments to avoid oscillation.
    adjustment_cooldown: Duration,
}

impl AdaptiveThrottle {
    pub(crate) fn new() -> Self {
        Self {
            current_interval: Duration::from_millis(DEFAULT_INTERVAL_MS),
            samples: VecDeque::with_capacity(WINDOW_SIZE + 1),
            last_adjustment: Instant::now(),
            adjustment_cooldown: Duration::from_secs(5),
        }
    }

    #[cfg(test)]
    pub(crate) fn with_cooldown(cooldown: Duration) -> Self {
        Self {
            current_interval: Duration::from_millis(DEFAULT_INTERVAL_MS),
            samples: VecDeque::with_capacity(WINDOW_SIZE + 1),
            last_adjustment: Instant::now() - cooldown, // allow immediate adjustment in tests
            adjustment_cooldown: cooldown,
        }
    }

    /// Get the current recommended injection interval.
    pub(crate) fn interval(&self) -> Duration {
        self.current_interval
    }

    /// Record that echo verification succeeded for a delivery.
    pub(crate) fn record_echo_success(&mut self, echo_latency_ms: u64) {
        self.push_sample(DeliverySample {
            echo_verified: true,
            activity_confirmed: None,
            echo_latency_ms: Some(echo_latency_ms),
            activity_latency_ms: None,
            recorded_at: Instant::now(),
        });
        self.maybe_adjust();
    }

    /// Record that echo verification failed for a delivery.
    pub(crate) fn record_echo_failure(&mut self) {
        self.push_sample(DeliverySample {
            echo_verified: false,
            activity_confirmed: None,
            echo_latency_ms: None,
            activity_latency_ms: None,
            recorded_at: Instant::now(),
        });
        self.maybe_adjust();
    }

    /// Record that activity was confirmed for a delivery.
    pub(crate) fn record_activity_confirmed(&mut self, activity_latency_ms: u64) {
        // Update the most recent matching sample if possible
        for sample in self.samples.iter_mut().rev() {
            if sample.echo_verified && sample.activity_confirmed.is_none() {
                sample.activity_confirmed = Some(true);
                sample.activity_latency_ms = Some(activity_latency_ms);
                break;
            }
        }
        self.maybe_adjust();
    }

    /// Record that activity timed out for a delivery.
    pub(crate) fn record_activity_timeout(&mut self) {
        for sample in self.samples.iter_mut().rev() {
            if sample.echo_verified && sample.activity_confirmed.is_none() {
                sample.activity_confirmed = Some(false);
                break;
            }
        }
        self.maybe_adjust();
    }

    /// Get current echo verification success rate (0.0 to 1.0).
    pub(crate) fn echo_success_rate(&self) -> f64 {
        if self.samples.is_empty() {
            return 1.0;
        }
        let successes = self.samples.iter().filter(|s| s.echo_verified).count();
        successes as f64 / self.samples.len() as f64
    }

    /// Get average echo latency in milliseconds (for successful deliveries).
    pub(crate) fn avg_echo_latency_ms(&self) -> Option<u64> {
        let latencies: Vec<u64> = self
            .samples
            .iter()
            .filter_map(|s| s.echo_latency_ms)
            .collect();
        if latencies.is_empty() {
            return None;
        }
        Some(latencies.iter().sum::<u64>() / latencies.len() as u64)
    }

    fn push_sample(&mut self, sample: DeliverySample) {
        self.samples.push_back(sample);
        if self.samples.len() > WINDOW_SIZE {
            self.samples.pop_front();
        }
    }

    fn maybe_adjust(&mut self) {
        if self.last_adjustment.elapsed() < self.adjustment_cooldown {
            return;
        }
        if self.samples.len() < 3 {
            return;
        }

        let rate = self.echo_success_rate();
        let old = self.current_interval;

        if rate < SLOW_DOWN_THRESHOLD {
            let new_ms = (self.current_interval.as_millis() as f64 * SLOW_DOWN_FACTOR) as u64;
            self.current_interval = Duration::from_millis(new_ms.min(MAX_INTERVAL_MS));
        } else if rate > SPEED_UP_THRESHOLD {
            let new_ms = (self.current_interval.as_millis() as f64 * SPEED_UP_FACTOR) as u64;
            self.current_interval = Duration::from_millis(new_ms.max(MIN_INTERVAL_MS));
        }

        if self.current_interval != old {
            self.last_adjustment = Instant::now();
            tracing::debug!(
                old_ms = old.as_millis() as u64,
                new_ms = self.current_interval.as_millis() as u64,
                echo_rate = format!("{:.2}", rate),
                "adaptive throttle adjusted injection interval"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_interval() {
        let throttle = AdaptiveThrottle::new();
        assert_eq!(throttle.interval(), Duration::from_millis(DEFAULT_INTERVAL_MS));
    }

    #[test]
    fn success_rate_starts_at_one() {
        let throttle = AdaptiveThrottle::new();
        assert_eq!(throttle.echo_success_rate(), 1.0);
    }

    #[test]
    fn success_rate_tracks_correctly() {
        let mut throttle = AdaptiveThrottle::with_cooldown(Duration::ZERO);
        throttle.record_echo_success(100);
        throttle.record_echo_success(150);
        throttle.record_echo_failure();
        assert!((throttle.echo_success_rate() - 2.0 / 3.0).abs() < 0.01);
    }

    #[test]
    fn slows_down_on_failures() {
        let mut throttle = AdaptiveThrottle::with_cooldown(Duration::ZERO);
        // Push 3+ failures to trigger adjustment
        for _ in 0..5 {
            throttle.record_echo_failure();
        }
        assert!(throttle.interval() > Duration::from_millis(DEFAULT_INTERVAL_MS));
    }

    #[test]
    fn speeds_up_on_success() {
        let mut throttle = AdaptiveThrottle::with_cooldown(Duration::ZERO);
        // Start with a higher interval
        throttle.current_interval = Duration::from_millis(200);
        for _ in 0..5 {
            throttle.record_echo_success(50);
        }
        assert!(throttle.interval() < Duration::from_millis(200));
    }

    #[test]
    fn interval_respects_floor() {
        let mut throttle = AdaptiveThrottle::with_cooldown(Duration::ZERO);
        throttle.current_interval = Duration::from_millis(MIN_INTERVAL_MS);
        for _ in 0..10 {
            throttle.record_echo_success(10);
        }
        assert!(throttle.interval() >= Duration::from_millis(MIN_INTERVAL_MS));
    }

    #[test]
    fn interval_respects_ceiling() {
        let mut throttle = AdaptiveThrottle::with_cooldown(Duration::ZERO);
        throttle.current_interval = Duration::from_millis(MAX_INTERVAL_MS);
        for _ in 0..10 {
            throttle.record_echo_failure();
        }
        assert!(throttle.interval() <= Duration::from_millis(MAX_INTERVAL_MS));
    }

    #[test]
    fn avg_latency_computed() {
        let mut throttle = AdaptiveThrottle::with_cooldown(Duration::ZERO);
        throttle.record_echo_success(100);
        throttle.record_echo_success(200);
        assert_eq!(throttle.avg_echo_latency_ms(), Some(150));
    }

    #[test]
    fn avg_latency_none_when_empty() {
        let throttle = AdaptiveThrottle::new();
        assert_eq!(throttle.avg_echo_latency_ms(), None);
    }

    #[test]
    fn window_size_caps_samples() {
        let mut throttle = AdaptiveThrottle::with_cooldown(Duration::ZERO);
        for i in 0..30 {
            throttle.record_echo_success(i * 10);
        }
        assert!(throttle.samples.len() <= WINDOW_SIZE);
    }

    #[test]
    fn activity_confirmation_updates_sample() {
        let mut throttle = AdaptiveThrottle::with_cooldown(Duration::ZERO);
        throttle.record_echo_success(100);
        throttle.record_activity_confirmed(500);
        let last = throttle.samples.back().unwrap();
        assert_eq!(last.activity_confirmed, Some(true));
        assert_eq!(last.activity_latency_ms, Some(500));
    }

    #[test]
    fn activity_timeout_updates_sample() {
        let mut throttle = AdaptiveThrottle::with_cooldown(Duration::ZERO);
        throttle.record_echo_success(100);
        throttle.record_activity_timeout();
        let last = throttle.samples.back().unwrap();
        assert_eq!(last.activity_confirmed, Some(false));
    }
}
