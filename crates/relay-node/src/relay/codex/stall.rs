//! Progress and waiting-message accounting for app-server delivery.

use crate::relay::claude::inbox::InboxStall;
use std::collections::HashMap;
use std::time::{Duration, Instant};

pub const STALL_ENV: &str = "RELAY_DESKTOP_CODEX_INBOX_STALL_SECS";
pub const INTERRUPT_ENV: &str = "RELAY_DESKTOP_CODEX_INBOX_INTERRUPT_SECS";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Progress {
    pub turn: String,
    /// Latest rollout write or app-server event, in Unix milliseconds.
    pub at_ms: i64,
}

#[derive(Clone, Copy)]
pub struct Timing {
    pub stall: Duration,
    pub interrupt: Duration,
}

impl Timing {
    pub fn from_env(env: &dyn Fn(&str) -> Option<String>) -> Self {
        let seconds = |key, default| {
            env(key)
                .and_then(|s| s.parse::<u64>().ok())
                .filter(|s| *s > 0 && *s <= 86_400)
                .unwrap_or(default)
        };
        let stall = seconds(STALL_ENV, 600);
        Self {
            stall: Duration::from_secs(stall),
            interrupt: Duration::from_secs(seconds(INTERRUPT_ENV, 1800).max(stall + 1)),
        }
    }
}

#[derive(Default)]
pub struct Watch {
    pending: HashMap<String, (Instant, Instant)>,
    progress: Option<Progress>,
    since: Option<Instant>,
    /// One recovery RPC at a time; a successful interrupt is never repeated
    /// against the same progress snapshot, even before its rollout catches up.
    pub recovering: bool,
    pub interrupted: bool,
    /// A steer whose answer was lost may have been accepted, so nothing
    /// recovers this progress snapshot again, by steer or interrupt.
    pub in_doubt: bool,
}

impl Watch {
    pub fn finished(&self) -> bool {
        self.pending.is_empty() && !self.recovering && !self.in_doubt
    }

    pub fn waiting(&mut self, id: &str, now: Instant) {
        self.pending.entry(id.into()).or_insert((now, now)).1 = now;
    }

    pub fn forget(&mut self, id: &str) {
        self.pending.remove(id);
    }

    pub fn refresh(&mut self, progress: Option<Progress>, now: Instant) {
        // Delivery retries every five seconds. Expired/cancelled queue entries
        // must not leave a permanent badge if their final callback was lost.
        self.pending
            .retain(|_, (_, seen)| now.saturating_duration_since(*seen) < Duration::from_secs(120));
        if self.progress != progress {
            self.since = progress.as_ref().map(|_| now);
            self.progress = progress;
            self.interrupted = false;
            self.in_doubt = false;
        }
    }

    pub fn turn(&self) -> Option<&str> {
        self.progress.as_ref().map(|p| p.turn.as_str())
    }

    pub fn report(&self, now: Instant, threshold: Duration) -> Option<InboxStall> {
        let oldest = self.pending.values().map(|(first, _)| *first).min()?;
        let since = self.since?.max(oldest);
        if now.saturating_duration_since(since) < threshold {
            return None;
        }
        Some(InboxStall {
            undrained_count: self.pending.len().min(u32::MAX as usize) as u32,
            oldest_undrained_age_ms: now
                .saturating_duration_since(oldest)
                .as_millis()
                .min(i64::MAX as u128) as i64,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stall_requires_waiting_and_silence_and_clears_on_progress() {
        let start = Instant::now();
        let threshold = Duration::from_secs(10);
        let mut watch = Watch::default();
        let mut progress = Progress {
            turn: "turn-1".into(),
            at_ms: 1,
        };
        watch.refresh(Some(progress.clone()), start);
        assert!(watch.report(start + threshold, threshold).is_none());
        watch.waiting("a", start);
        watch.waiting("b", start + Duration::from_secs(2));
        assert!(watch
            .report(start + threshold - Duration::from_millis(1), threshold)
            .is_none());
        let report = watch.report(start + threshold, threshold).expect("stalled");
        assert_eq!(report.undrained_count, 2);
        assert_eq!(report.oldest_undrained_age_ms, 10_000);
        progress.at_ms += 1;
        watch.refresh(Some(progress), start + threshold);
        assert!(watch.report(start + threshold, threshold).is_none());
        watch.refresh(None, start + threshold);
        assert!(watch.report(start + threshold * 4, threshold).is_none());
    }

    #[test]
    fn stale_or_cancelled_messages_do_not_leave_a_stall() {
        let start = Instant::now();
        let mut watch = Watch::default();
        let progress = Some(Progress {
            turn: "t".into(),
            at_ms: 1,
        });
        watch.refresh(progress.clone(), start);
        watch.waiting("a", start);
        watch.forget("a");
        assert!(watch
            .report(start + Duration::from_secs(10), Duration::ZERO)
            .is_none());
        watch.waiting("b", start);
        watch.refresh(progress, start + Duration::from_secs(120));
        assert!(watch
            .report(start + Duration::from_secs(120), Duration::ZERO)
            .is_none());
    }

    #[test]
    fn interrupt_threshold_is_longer_and_invalid_overrides_use_defaults() {
        let timing = Timing::from_env(&|_| None);
        assert_eq!(timing.stall.as_secs(), 600);
        assert_eq!(timing.interrupt.as_secs(), 1800);
        let timing = Timing::from_env(&|_| Some("0".into()));
        assert_eq!(timing.stall.as_secs(), 600);
        let timing = Timing::from_env(&|_| Some("5".into()));
        assert_eq!(timing.interrupt.as_secs(), 6);
    }
}
