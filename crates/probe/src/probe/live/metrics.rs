//! Content-free hot/cold capture work accounting.
use super::*;

/// Content-free counts and durations of the capture thread since the run
/// started.
#[derive(Default)]
pub(super) struct Metrics {
    pub(super) cold_slices: u64,
    pub(super) cold_entries: u64,
    pub(super) cold_paths: u64,
    pub(super) cold_slice_ms_last: Option<u64>,
    pub(super) cold_slice_ms_max: u64,
    pub(super) cold_sqlite_busy_wait_ms_last: Option<u64>,
    pub(super) cold_sqlite_busy_wait_ms_total: u64,
    /// `watch`, `timer` or `members`.
    pub(super) mode: Option<&'static str>,
    /// What drives capture: `fs-events` or `polling` for the watch,
    /// `timer` when it could not start; in selected mode `member-events`, or
    /// `member-poll` when no filesystem watch can run.
    pub(super) driver: Option<&'static str>,
    /// Why the watch is not driven by filesystem events, while it is not.
    pub(super) fallback_reason: Option<&'static str>,
    /// When the watcher first reported how it is driven: from then on every
    /// write under a watched root is an event the loop owes a tick.
    pub(super) watching_since_ms: Option<i64>,
    pub(super) ticks: u64,
    pub(super) ticks_by_trigger: BTreeMap<&'static str, u64>,
    pub(super) ticks_swept: u64,
    pub(super) ticks_unchanged: u64,
    pub(super) ticks_contended: u64,
    pub(super) ticks_failed: u64,
    pub(super) ticks_waking_delivery: u64,
    pub(super) sessions_changed: u64,
    /// Completed resumable reconciliation rounds.
    pub(super) sweeps: u64,
    pub(super) sweep_ms_last: Option<u64>,
    pub(super) sweep_ms_max: u64,
    /// How long the watch's last and longest sweep took.
    pub(super) tick_ms_last: Option<u64>,
    pub(super) tick_ms_max: u64,
    /// The event sweeps that waited past their debounce for the pace, and
    /// how long they waited in all.
    pub(super) ticks_paced: u64,
    pub(super) duty_wait_ms_total: u64,
    /// From the newest write a tick captured, by its file's modification
    /// time, to the tick's report: debounce, pace, sweep and hand-off
    /// together.
    pub(super) capture_lag_ms_last: Option<u64>,
    pub(super) capture_lag_ms_max: Option<u64>,
    /// Selected mode: member hydrations, and the rounds that found a change.
    pub(super) hydrations: u64,
    pub(super) member_polls_changed: u64,
    pub(super) last_capture_ms: Option<i64>,
}

impl Metrics {
    pub(super) fn report(&self) -> serde_json::Value {
        json!({
            "cold_slices": self.cold_slices,
            "cold_entries": self.cold_entries,
            "cold_paths": self.cold_paths,
            "cold_slice_ms_last": self.cold_slice_ms_last,
            "cold_slice_ms_max": self.cold_slice_ms_max,
            "cold_sqlite_busy_wait_ms_last": self.cold_sqlite_busy_wait_ms_last,
            "cold_sqlite_busy_wait_ms_total": self.cold_sqlite_busy_wait_ms_total,
            "mode": self.mode,
            "driver": self.driver,
            "fallback_reason": self.fallback_reason,
            "watching_since_ms": self.watching_since_ms,
            "ticks": self.ticks,
            "ticks_by_trigger": self.ticks_by_trigger,
            "ticks_swept": self.ticks_swept,
            "ticks_unchanged": self.ticks_unchanged,
            "ticks_contended": self.ticks_contended,
            "ticks_failed": self.ticks_failed,
            "ticks_waking_delivery": self.ticks_waking_delivery,
            "sessions_changed": self.sessions_changed,
            "sweeps": self.sweeps,
            "sweep_ms_last": self.sweep_ms_last,
            "sweep_ms_max": self.sweep_ms_max,
            "tick_ms_last": self.tick_ms_last,
            "tick_ms_max": self.tick_ms_max,
            "ticks_paced": self.ticks_paced,
            "duty_wait_ms_total": self.duty_wait_ms_total,
            "capture_lag_ms": self.capture_lag_ms_last,
            "capture_lag_ms_max": self.capture_lag_ms_max,
            "hydrations": self.hydrations,
            "member_polls_changed": self.member_polls_changed,
            "last_capture_ms": self.last_capture_ms,
        })
    }
    pub(super) fn lag(&mut self, lag: u64) {
        self.capture_lag_ms_last = Some(lag);
        self.capture_lag_ms_max = Some(self.capture_lag_ms_max.map_or(lag, |max| max.max(lag)));
    }
}
