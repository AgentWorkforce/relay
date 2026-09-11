//! Crash recording, analysis, and pattern detection.
//!
//! Classifies agent crashes by exit code and signal, maintains a bounded
//! history, detects patterns, and computes a health score.
//!
//! ## Storage tradeoff: diagnostics vs. the durable pending outbox
//!
//! This module deliberately applies two different durability policies to
//! two different halves of the same on-disk file:
//!
//! - **Diagnostics** (patterns, health score, "recent" crash history for
//!   already-delivered exits) are bounded and *lossy by design*: once
//!   [`CrashInsights::record`] pushes the store past `max_records`, the
//!   oldest already-delivered records are evicted to keep the file bounded.
//!   Losing old, already-delivered diagnostic history is an acceptable
//!   tradeoff — it is presentation/analysis data, not the mechanism backing
//!   at-least-once delivery.
//! - **The durable pending outbox** — [`CrashRecord`]s whose
//!   [`HostedDeliveryState`] is still `Pending` — backs at-least-once hosted
//!   `agent_exited` delivery and is **never silently evicted** under
//!   retention pressure, even if that means the on-disk file temporarily
//!   grows past `max_records` while deliveries are outstanding. When
//!   retention pressure hits a store that is entirely (or mostly) pending
//!   records, `record` skips eviction, logs loudly, and increments
//!   [`CrashInsights::retention_pressure_total`] — an explicit,
//!   operator-visible counter (surfaced via [`CrashInsights::to_json`] and
//!   the broker's `GetCrashInsights` API) rather than a silent drop.

use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

/// Category of a crash based on exit code and signal analysis.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CrashCategory {
    /// Out of memory (exit 137, SIGKILL)
    Oom,
    /// Segmentation fault (SIGSEGV / signal 11)
    Segfault,
    /// Nonzero exit code (application error)
    Error,
    /// Killed by signal (other than OOM/segfault)
    Signal,
    /// Unknown cause
    Unknown,
}

/// Delivery state of a crash record's corresponding hosted `agent_exited`
/// event.
///
/// This is the durable half of the hosted-delivery outbox: every exit is
/// recorded [`Pending`](HostedDeliveryState::Pending) in the same atomic
/// write as the rest of the crash record (see [`CrashInsights::record`] /
/// [`CrashInsights::save`]), *before* the broker attempts to hand the event
/// to the hosted publisher channel. It flips to
/// [`Delivered`](HostedDeliveryState::Delivered) only after that handoff
/// actually succeeds (a successful `mpsc::Sender::try_send`), and that
/// transition is itself persisted immediately. A broker crash at any point
/// between the two writes therefore always leaves the on-disk record in
/// exactly one of those two states — never a state that claims delivery
/// happened when it didn't.
///
/// On restart, every still-`Pending` record is a candidate for replay (see
/// `hosted_agent_event_from_crash_record` in the broker crate), giving
/// at-least-once delivery: a record may occasionally be replayed after it
/// was in fact delivered (e.g. the success write raced a crash), which is
/// why replay is keyed by [`CrashRecord::dedupe_key`] so hosted consumers can
/// idempotently discard a duplicate.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum HostedDeliveryState {
    /// Not yet handed off to the hosted publisher channel (or the handoff
    /// failed and was not retried). Eligible for replay on restart.
    #[default]
    Pending,
    /// Successfully handed to the hosted publisher channel at least once.
    Delivered,
}

/// A single crash record.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CrashRecord {
    pub agent_name: String,
    pub exit_code: Option<i32>,
    pub signal: Option<String>,
    pub timestamp: u64,
    pub uptime_secs: u64,
    pub category: CrashCategory,
    pub description: String,
    /// Broker workspace that owned this worker, when the spawn was workspace-scoped.
    #[serde(default)]
    pub workspace_id: Option<String>,
    /// Fleet action invocation that created this worker, when available.
    #[serde(default)]
    pub spawn_invocation_id: Option<String>,
    /// Process generation; same-name workers must remain independently queryable.
    #[serde(default)]
    pub generation: String,
    /// Whether the broker observed `worker_ready` for this process generation.
    #[serde(default)]
    pub became_ready: bool,
    /// Unix timestamp (seconds) at which the wrapper process was spawned.
    #[serde(default)]
    pub spawned_at: u64,
    /// Unix timestamp (seconds) at which the worker reported ready.
    #[serde(default)]
    pub ready_at: Option<u64>,
    /// Unix timestamp (seconds) at which the broker reaped this generation.
    #[serde(default)]
    pub exited_at: u64,
    /// Bounded, broker-derived explanation for why the process was reaped.
    #[serde(default)]
    pub exit_reason: Option<String>,
    /// Fleet node name that hosted this generation.
    #[serde(default)]
    pub fleet_node_name: Option<String>,
    /// Durable delivery state of the corresponding hosted `agent_exited`
    /// event. See [`HostedDeliveryState`]. Defaults to `Pending` so records
    /// written by older brokers (before this field existed) are always
    /// eligible for replay rather than silently treated as delivered.
    #[serde(default)]
    pub hosted_delivery: HostedDeliveryState,
}

impl CrashRecord {
    /// Stable idempotency key for this generation's hosted delivery:
    /// `agent_name` plus `generation`. A same-name replacement worker gets a
    /// new `generation` (see `WorkerHandle`), so this key never collides
    /// across two different process lifetimes of the same agent name, and
    /// is stable across broker restarts (unlike, say, a locally-assigned
    /// sequence number) so hosted consumers can dedupe a replayed delivery
    /// against one they already saw before a restart.
    pub fn dedupe_key(&self) -> String {
        format!("{}::{}", self.agent_name, self.generation)
    }
}

/// A detected crash pattern (grouping).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CrashPattern {
    pub category: CrashCategory,
    pub count: usize,
    pub agents: Vec<String>,
}

/// Persistent crash insights store.
#[derive(Debug, Serialize, Deserialize)]
pub struct CrashInsights {
    records: Vec<CrashRecord>,
    #[serde(default = "default_max_records")]
    max_records: usize,
    /// True when in-memory state has changed since the last confirmed
    /// successful [`save`](CrashInsights::save). Set on every mutation and,
    /// crucially, re-set on a *failed* [`persist`](CrashInsights::persist)
    /// call so a later flush attempt is guaranteed rather than the failure
    /// being silently swallowed after a single log line. Never persisted:
    /// a freshly loaded snapshot is by definition not dirty relative to
    /// itself.
    #[serde(skip)]
    dirty: bool,
    /// Count of [`persist`](CrashInsights::persist) calls whose underlying
    /// [`save`](CrashInsights::save) failed, since process start. Purely
    /// observability — never persisted to disk — so a transient write
    /// failure (full disk, permissions, etc.) is visible to operators via
    /// the broker's status/API surface (`GetCrashInsights`), not only in
    /// logs that can scroll away unnoticed.
    #[serde(skip)]
    save_failures_total: u64,
    /// Count of times [`record`](CrashInsights::record) hit generic
    /// retention pressure (more than `max_records` records) but could not
    /// evict anything because every record above the cap was still a
    /// pending hosted-delivery outbox entry. Never persisted. This is the
    /// operator-visible signal for the documented pressure policy: the
    /// durable pending outbox is *never* silently evicted, so under
    /// sustained pressure the on-disk file grows past `max_records` instead
    /// — this counter says exactly how often that happened, so an operator
    /// (or alert) can see the pressure building rather than discovering an
    /// unbounded file after the fact.
    #[serde(skip)]
    retention_pressure_total: u64,
}

fn default_max_records() -> usize {
    500
}

impl Default for CrashInsights {
    fn default() -> Self {
        Self::new()
    }
}

impl CrashInsights {
    pub fn new() -> Self {
        Self {
            records: Vec::new(),
            max_records: 500,
            dirty: false,
            save_failures_total: 0,
            retention_pressure_total: 0,
        }
    }

    /// Analyze an exit code and signal to determine crash category and description.
    pub fn analyze(exit_code: Option<i32>, signal: Option<&str>) -> (CrashCategory, String) {
        // Check signal first
        if let Some(sig) = signal {
            if sig == "11" || sig.eq_ignore_ascii_case("SIGSEGV") {
                return (
                    CrashCategory::Segfault,
                    format!("Segmentation fault (signal {})", sig),
                );
            }
            if sig == "9" || sig.eq_ignore_ascii_case("SIGKILL") {
                return (
                    CrashCategory::Oom,
                    format!("Killed by signal {} (possible OOM)", sig),
                );
            }
            return (CrashCategory::Signal, format!("Killed by signal {}", sig));
        }

        // Check exit code
        match exit_code {
            Some(137) => (
                CrashCategory::Oom,
                "Exit code 137 (likely OOM killed)".to_string(),
            ),
            Some(139) => (
                CrashCategory::Segfault,
                "Exit code 139 (segmentation fault)".to_string(),
            ),
            Some(code) if code != 0 => (CrashCategory::Error, format!("Exited with code {}", code)),
            Some(code) => (
                CrashCategory::Unknown,
                format!("Exited with unexpected code {}", code),
            ),
            None => (CrashCategory::Unknown, "Unknown exit status".to_string()),
        }
    }

    /// Record a crash. Trims oldest records if over the limit.
    pub fn record(&mut self, crash: CrashRecord) {
        self.dirty = true;
        self.records.push(crash);
        if self.records.len() > self.max_records {
            let mut excess = self.records.len() - self.max_records;
            // Preserve pending hosted exits first: these records are the
            // durable outbox source and must survive long outages even when
            // generic crash retention is under pressure.
            while excess > 0 {
                if let Some(index) = self
                    .records
                    .iter()
                    .position(|record| record.hosted_delivery != HostedDeliveryState::Pending)
                {
                    self.records.remove(index);
                    excess -= 1;
                } else {
                    self.retention_pressure_total += 1;
                    tracing::error!(
                        max_records = self.max_records,
                        pending_hosted_deliveries = self.pending_hosted_deliveries().len(),
                        retention_pressure_total = self.retention_pressure_total,
                        "crash-insights retention is full of pending hosted exits; preserving durable outbox records above the generic cap"
                    );
                    break;
                }
            }
        }
    }

    /// Get recent crash records.
    pub fn recent(&self, limit: usize) -> &[CrashRecord] {
        let start = self.records.len().saturating_sub(limit);
        &self.records[start..]
    }

    /// Detect patterns by grouping crashes by category.
    pub fn patterns(&self) -> Vec<CrashPattern> {
        let mut by_category: HashMap<CrashCategory, (usize, Vec<String>)> = HashMap::new();

        for record in &self.records {
            let entry = by_category
                .entry(record.category.clone())
                .or_insert_with(|| (0, Vec::new()));
            entry.0 += 1;
            if !entry.1.contains(&record.agent_name) {
                entry.1.push(record.agent_name.clone());
            }
        }

        let mut patterns: Vec<CrashPattern> = by_category
            .into_iter()
            .map(|(category, (count, agents))| CrashPattern {
                category,
                count,
                agents,
            })
            .collect();
        patterns.sort_by_key(|p| std::cmp::Reverse(p.count));
        patterns
    }

    /// Compute a health score from 0-100 based on recent crash rate.
    /// 100 = no recent crashes, 0 = many recent crashes.
    pub fn health_score(&self) -> u8 {
        // Look at last 50 records (or all if fewer)
        let window = self.recent(50);
        if window.is_empty() {
            return 100;
        }

        let now_secs = chrono::Utc::now().timestamp() as u64;
        let recent_window_secs = 3600; // last hour

        let recent_crashes = window
            .iter()
            .filter(|r| now_secs.saturating_sub(r.timestamp) < recent_window_secs)
            .count();

        // Scale: 0 crashes = 100, 10+ crashes in last hour = 0
        100u8.saturating_sub((recent_crashes as u8).saturating_mul(10))
    }

    /// Total number of recorded crashes.
    pub fn total(&self) -> usize {
        self.records.len()
    }

    /// Records whose hosted `agent_exited` delivery has not yet succeeded,
    /// in the original (chronological) order they were recorded.
    ///
    /// This is the durable hosted-delivery outbox's replay source: the
    /// broker walks this on startup and on-disk retention (`max_records`,
    /// via [`CrashInsights::record`]) is this outbox's explicit bound on
    /// disk growth — a broker that is offline (or whose hosted channel stays
    /// closed) long enough to accumulate more than `max_records` crashes
    /// will lose the oldest still-pending deliveries rather than grow the
    /// file without limit. That loss is logged loudly wherever eviction
    /// happens; it never happens silently.
    pub fn pending_hosted_deliveries(&self) -> Vec<&CrashRecord> {
        self.records
            .iter()
            .filter(|record| record.hosted_delivery == HostedDeliveryState::Pending)
            .collect()
    }

    /// Mark the most recent record matching `dedupe_key` as delivered and
    /// return whether a matching (still-pending) record was found.
    ///
    /// Callers should persist ([`CrashInsights::save`]) immediately after a
    /// successful call so the transition is durable before the process could
    /// crash again. Searches from the end since the record being
    /// acknowledged was almost always just appended; older duplicates (there
    /// should not normally be more than one record per key) are left
    /// untouched.
    pub fn mark_hosted_delivered(&mut self, dedupe_key: &str) -> bool {
        for record in self.records.iter_mut().rev() {
            if record.hosted_delivery == HostedDeliveryState::Pending
                && record.dedupe_key() == dedupe_key
            {
                record.hosted_delivery = HostedDeliveryState::Delivered;
                self.dirty = true;
                return true;
            }
        }
        false
    }

    /// Whether in-memory state has changed since the last confirmed
    /// successful [`save`]/[`persist`](CrashInsights::persist). Exposed
    /// mainly for tests; production code should prefer
    /// [`take_dirty`](CrashInsights::take_dirty) so a check-and-clear is
    /// atomic.
    pub fn is_dirty(&self) -> bool {
        self.dirty
    }

    /// Read and clear the dirty flag. Callers that get `true` back are
    /// responsible for attempting a [`persist`](CrashInsights::persist); if
    /// that attempt fails, `persist` re-sets the flag itself so the next
    /// caller retries.
    pub fn take_dirty(&mut self) -> bool {
        std::mem::take(&mut self.dirty)
    }

    /// Force the dirty flag on, e.g. after an external caller detects a
    /// failed write through some other path and wants to guarantee a future
    /// retry.
    pub fn mark_dirty(&mut self) {
        self.dirty = true;
    }

    /// Total count of failed [`persist`] attempts since process start. Pure
    /// observability, surfaced via the broker's `GetCrashInsights` API so an
    /// operator can see durability trouble without having to grep logs.
    pub fn save_failures_total(&self) -> u64 {
        self.save_failures_total
    }

    /// Count of retention-pressure events where the durable pending outbox
    /// filled the generic cap and no eviction could happen (see `record`).
    /// Operator-visible pressure signal — pairs with
    /// `pending_hosted_deliveries().len()` to distinguish "growing but
    /// healthy" from "under sustained backpressure."
    pub fn retention_pressure_total(&self) -> u64 {
        self.retention_pressure_total
    }

    /// Attempt to durably persist the current state to `path`, with
    /// built-in failure bookkeeping: a successful write clears the dirty
    /// flag; a failed write increments [`save_failures_total`] and leaves
    /// (or re-sets) the dirty flag so a later call — e.g. from a periodic
    /// maintenance flush — retries automatically. This turns a transient
    /// write failure into a bounded-retry-until-success operation instead
    /// of a silent, one-shot, log-only data loss: the in-memory state (and
    /// therefore the next in-process read of it, e.g. via the API) is never
    /// wrong, and the on-disk copy is guaranteed another attempt as long as
    /// the process keeps calling this on its normal cadence (every
    /// maintenance tick).
    ///
    /// Returns `true` on success, `false` on failure (the error itself is
    /// intentionally not returned — callers that want the error text should
    /// call [`save`](CrashInsights::save) directly and do their own
    /// bookkeeping, as the durable-outbox-critical call sites still do so
    /// they can log full context).
    pub fn persist(&mut self, path: &Path) -> bool {
        match self.save(path) {
            Ok(()) => {
                self.dirty = false;
                true
            }
            Err(_) => {
                self.save_failures_total += 1;
                self.dirty = true;
                false
            }
        }
    }

    /// Load from a JSON file. Returns empty insights if file doesn't exist or is invalid.
    pub fn load(path: &Path) -> Self {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    /// Save to a JSON file.
    pub fn save(&self, path: &Path) -> anyhow::Result<()> {
        let json = serde_json::to_string_pretty(self)?;
        let parent = path.parent().unwrap_or_else(|| Path::new("."));
        std::fs::create_dir_all(parent)?;
        // Replace the snapshot atomically. Exit records are written from the
        // maintenance tick, so a broker crash during persistence must leave
        // either the prior complete snapshot or this complete one, never a
        // truncated JSON file that erases all earlier evidence on restart.
        let mut tmp = tempfile::NamedTempFile::new_in(parent)?;
        std::io::Write::write_all(&mut tmp, json.as_bytes())?;
        tmp.as_file().sync_all()?;
        tmp.persist(path).map_err(|error| error.error)?;
        Ok(())
    }

    /// Export as JSON value for API responses.
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "total_crashes": self.total(),
            "recent": self.recent(20),
            "patterns": self.patterns(),
            "health_score": self.health_score(),
            // Durable hosted-delivery outbox status. `hosted_delivery_pending`
            // counts records not yet handed off to the hosted publisher
            // channel — these are exactly what gets replayed on the next
            // broker restart. Backward-compatible addition: older clients
            // that don't read this field are unaffected.
            "hosted_delivery_pending": self.pending_hosted_deliveries().len(),
            // Durability status for the on-disk snapshot itself (distinct
            // from hosted-delivery status above). Non-zero means at least
            // one `persist` write has failed since process start; `dirty ==
            // true` means the in-memory state is not yet confirmed written
            // to disk and a retry is pending on the next maintenance flush.
            "save_failures_total": self.save_failures_total,
            "dirty": self.dirty,
            // Pressure policy visibility (see `record`): diagnostics
            // (patterns/health_score/recent above) are intentionally
            // bounded/lossy by design — old, already-delivered crash
            // history is dropped once `max_records` is exceeded. The
            // durable pending outbox is the opposite: it is *never*
            // silently evicted under pressure, so this counter increments
            // instead whenever eviction was skipped to protect it.
            "retention_pressure_total": self.retention_pressure_total,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_record(name: &str, code: Option<i32>, signal: Option<&str>) -> CrashRecord {
        let (category, description) = CrashInsights::analyze(code, signal);
        CrashRecord {
            agent_name: name.to_string(),
            exit_code: code,
            signal: signal.map(String::from),
            timestamp: chrono::Utc::now().timestamp() as u64,
            uptime_secs: 60,
            category,
            description,
            workspace_id: None,
            spawn_invocation_id: None,
            generation: String::new(),
            became_ready: true,
            spawned_at: 0,
            ready_at: None,
            exited_at: 0,
            exit_reason: None,
            fleet_node_name: None,
            hosted_delivery: HostedDeliveryState::Pending,
        }
    }

    #[test]
    fn analyze_segfault_by_signal() {
        let (cat, desc) = CrashInsights::analyze(None, Some("11"));
        assert_eq!(cat, CrashCategory::Segfault);
        assert!(desc.contains("Segmentation fault"));
    }

    #[test]
    fn analyze_segfault_by_name() {
        let (cat, _) = CrashInsights::analyze(None, Some("SIGSEGV"));
        assert_eq!(cat, CrashCategory::Segfault);
    }

    #[test]
    fn analyze_oom_by_sigkill() {
        let (cat, _) = CrashInsights::analyze(None, Some("9"));
        assert_eq!(cat, CrashCategory::Oom);
    }

    #[test]
    fn analyze_oom_by_exit_137() {
        let (cat, desc) = CrashInsights::analyze(Some(137), None);
        assert_eq!(cat, CrashCategory::Oom);
        assert!(desc.contains("137"));
    }

    #[test]
    fn analyze_segfault_by_exit_139() {
        let (cat, _) = CrashInsights::analyze(Some(139), None);
        assert_eq!(cat, CrashCategory::Segfault);
    }

    #[test]
    fn analyze_error_nonzero() {
        let (cat, desc) = CrashInsights::analyze(Some(1), None);
        assert_eq!(cat, CrashCategory::Error);
        assert!(desc.contains("1"));
    }

    #[test]
    fn analyze_unknown_exit_zero() {
        let (cat, _) = CrashInsights::analyze(Some(0), None);
        assert_eq!(cat, CrashCategory::Unknown);
    }

    #[test]
    fn analyze_unknown_no_info() {
        let (cat, _) = CrashInsights::analyze(None, None);
        assert_eq!(cat, CrashCategory::Unknown);
    }

    #[test]
    fn analyze_other_signal() {
        let (cat, desc) = CrashInsights::analyze(None, Some("15"));
        assert_eq!(cat, CrashCategory::Signal);
        assert!(desc.contains("15"));
    }

    #[test]
    fn record_and_retrieve() {
        let mut ci = CrashInsights::new();
        let record = make_record("w1", Some(1), None);
        ci.record(record);

        assert_eq!(ci.total(), 1);
        assert_eq!(ci.recent(10).len(), 1);
        assert_eq!(ci.recent(10)[0].agent_name, "w1");
    }

    #[test]
    fn records_trimmed_to_max_when_all_delivered() {
        // Deliberate retention semantics: the generic cap only ever evicts
        // records whose hosted delivery has already succeeded (see
        // `retention_bounds_pending_hosted_delivery_backlog` below for the
        // pending-preserving half of this contract). With none pending,
        // trimming behaves like a plain bounded ring: oldest evicted first.
        let mut ci = CrashInsights {
            records: Vec::new(),
            max_records: 3,
            dirty: false,
            save_failures_total: 0,
            retention_pressure_total: 0,
        };

        for i in 0..5 {
            let mut record = make_record(&format!("w{}", i), Some(1), None);
            record.hosted_delivery = HostedDeliveryState::Delivered;
            ci.record(record);
        }

        assert_eq!(ci.total(), 3);
        // Should keep the 3 most recent
        assert_eq!(ci.records[0].agent_name, "w2");
        assert_eq!(ci.records[1].agent_name, "w3");
        assert_eq!(ci.records[2].agent_name, "w4");
    }

    #[test]
    fn records_over_cap_are_retained_while_pending_hosted_delivery() {
        // Deliberate retention semantics (the other half of the contract
        // above): the durable pending-delivery outbox must never be
        // silently evicted by the generic crash-history cap, even though
        // that means the on-disk file can temporarily grow past
        // `max_records` while deliveries are outstanding. This is
        // documented, bounded-but-not-silently-lossy behavior — see
        // `CrashInsights::record` and `pending_hosted_deliveries`.
        let mut ci = CrashInsights {
            records: Vec::new(),
            max_records: 3,
            dirty: false,
            save_failures_total: 0,
            retention_pressure_total: 0,
        };

        for i in 0..5 {
            // Default `hosted_delivery` is `Pending` (see `make_record`).
            ci.record(make_record(&format!("w{}", i), Some(1), None));
        }

        assert_eq!(
            ci.total(),
            5,
            "pending hosted-delivery records must survive past the generic retention cap"
        );
        assert_eq!(ci.pending_hosted_deliveries().len(), 5);
    }

    #[test]
    fn patterns_group_by_category() {
        let mut ci = CrashInsights::new();
        ci.record(make_record("w1", Some(1), None)); // Error
        ci.record(make_record("w2", Some(1), None)); // Error
        ci.record(make_record("w3", Some(137), None)); // Oom

        let patterns = ci.patterns();
        assert_eq!(patterns.len(), 2);
        // Error should be first (count=2)
        assert_eq!(patterns[0].category, CrashCategory::Error);
        assert_eq!(patterns[0].count, 2);
        assert_eq!(patterns[0].agents.len(), 2);
        // OOM second (count=1)
        assert_eq!(patterns[1].category, CrashCategory::Oom);
        assert_eq!(patterns[1].count, 1);
    }

    #[test]
    fn patterns_dedup_agents() {
        let mut ci = CrashInsights::new();
        ci.record(make_record("w1", Some(1), None));
        ci.record(make_record("w1", Some(1), None)); // same agent, same category

        let patterns = ci.patterns();
        assert_eq!(patterns[0].count, 2);
        assert_eq!(patterns[0].agents.len(), 1); // deduped
    }

    #[test]
    fn health_score_is_100_when_no_crashes() {
        let ci = CrashInsights::new();
        assert_eq!(ci.health_score(), 100);
    }

    #[test]
    fn health_score_decreases_with_recent_crashes() {
        let mut ci = CrashInsights::new();
        // Add 5 very recent crashes
        for _ in 0..5 {
            ci.record(make_record("w1", Some(1), None));
        }
        let score = ci.health_score();
        assert!(score <= 50, "expected score <= 50, got {}", score);
        assert!(score > 0, "expected score > 0, got {}", score);
    }

    #[test]
    fn health_score_zero_with_many_crashes() {
        let mut ci = CrashInsights::new();
        for _ in 0..15 {
            ci.record(make_record("w1", Some(1), None));
        }
        assert_eq!(ci.health_score(), 0);
    }

    #[test]
    fn save_and_load_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("crashes.json");

        let mut ci = CrashInsights::new();
        ci.record(make_record("w1", Some(1), None));
        ci.save(&path).unwrap();

        let loaded = CrashInsights::load(&path);
        assert_eq!(loaded.total(), 1);
        assert_eq!(loaded.records[0].agent_name, "w1");
    }

    #[test]
    fn correlated_exit_metadata_survives_atomic_persistence() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("crashes.json");
        let mut ci = CrashInsights::new();
        let mut record = make_record("w1", Some(137), None);
        record.workspace_id = Some("ws-1".to_string());
        record.spawn_invocation_id = Some("invoke-1".to_string());
        record.generation = "generation-1".to_string();
        record.became_ready = true;
        record.spawned_at = 100;
        record.ready_at = Some(110);
        record.exited_at = 125;
        record.uptime_secs = 25;
        record.exit_reason = Some("worker_write_failed".to_string());
        record.fleet_node_name = Some("node-1".to_string());
        ci.record(record);

        ci.save(&path).unwrap();
        let loaded = CrashInsights::load(&path);
        let loaded = &loaded.records[0];
        assert_eq!(loaded.spawn_invocation_id.as_deref(), Some("invoke-1"));
        assert_eq!(loaded.generation, "generation-1");
        assert_eq!(loaded.ready_at, Some(110));
        assert_eq!(loaded.exited_at, 125);
        assert_eq!(loaded.exit_reason.as_deref(), Some("worker_write_failed"));
    }

    #[test]
    fn legacy_records_load_with_empty_correlation_fields() {
        let record: CrashRecord = serde_json::from_value(serde_json::json!({
            "agent_name": "legacy",
            "exit_code": 1,
            "signal": null,
            "timestamp": 42,
            "uptime_secs": 2,
            "category": "error",
            "description": "Exited with code 1"
        }))
        .unwrap();

        assert_eq!(record.agent_name, "legacy");
        assert!(record.generation.is_empty());
        assert!(!record.became_ready);
        assert_eq!(record.exited_at, 0);
        assert!(record.exit_reason.is_none());
    }

    #[test]
    fn load_missing_file_returns_empty() {
        let ci = CrashInsights::load(Path::new("/nonexistent/crashes.json"));
        assert_eq!(ci.total(), 0);
    }

    #[test]
    fn to_json_has_expected_fields() {
        let mut ci = CrashInsights::new();
        ci.record(make_record("w1", Some(1), None));

        let json = ci.to_json();
        assert_eq!(json["total_crashes"], 1);
        assert!(json.get("recent").is_some());
        assert!(json.get("patterns").is_some());
        assert!(json.get("health_score").is_some());
    }

    #[test]
    fn crash_category_round_trip() {
        let categories = vec![
            CrashCategory::Oom,
            CrashCategory::Segfault,
            CrashCategory::Error,
            CrashCategory::Signal,
            CrashCategory::Unknown,
        ];
        for cat in categories {
            let json = serde_json::to_string(&cat).unwrap();
            let decoded: CrashCategory = serde_json::from_str(&json).unwrap();
            assert_eq!(decoded, cat);
        }
    }

    #[test]
    fn new_record_defaults_to_pending_hosted_delivery() {
        let mut ci = CrashInsights::new();
        let mut record = make_record("w1", Some(1), None);
        record.generation = "gen-1".to_string();
        ci.record(record);

        assert_eq!(ci.pending_hosted_deliveries().len(), 1);
        assert_eq!(
            ci.pending_hosted_deliveries()[0].hosted_delivery,
            HostedDeliveryState::Pending
        );
    }

    #[test]
    fn legacy_records_without_the_field_default_to_pending() {
        // A record persisted by a broker built before `hosted_delivery`
        // existed must still be replayed, never silently treated as
        // already delivered.
        let record: CrashRecord = serde_json::from_value(serde_json::json!({
            "agent_name": "legacy",
            "exit_code": 1,
            "signal": null,
            "timestamp": 42,
            "uptime_secs": 2,
            "category": "error",
            "description": "Exited with code 1",
            "generation": "gen-legacy"
        }))
        .unwrap();

        assert_eq!(record.hosted_delivery, HostedDeliveryState::Pending);
    }

    #[test]
    fn mark_hosted_delivered_flips_state_and_returns_true() {
        let mut ci = CrashInsights::new();
        let mut record = make_record("w1", Some(1), None);
        record.generation = "gen-1".to_string();
        let key = record.dedupe_key();
        ci.record(record);

        assert!(ci.mark_hosted_delivered(&key));
        assert_eq!(ci.pending_hosted_deliveries().len(), 0);
        // Marking again finds no pending match — already delivered.
        assert!(!ci.mark_hosted_delivered(&key));
    }

    #[test]
    fn mark_hosted_delivered_ignores_unknown_key() {
        let mut ci = CrashInsights::new();
        let mut record = make_record("w1", Some(1), None);
        record.generation = "gen-1".to_string();
        ci.record(record);

        assert!(!ci.mark_hosted_delivered("w1::some-other-generation"));
        assert_eq!(ci.pending_hosted_deliveries().len(), 1);
    }

    #[test]
    fn dedupe_key_distinguishes_same_name_different_generation() {
        let mut a = make_record("w1", Some(1), None);
        a.generation = "gen-old".to_string();
        let mut b = make_record("w1", Some(1), None);
        b.generation = "gen-new".to_string();

        assert_ne!(a.dedupe_key(), b.dedupe_key());

        // Marking the old generation delivered must not affect the new
        // generation's own pending record — a same-name replacement worker's
        // exit must remain independently deliverable.
        let mut ci = CrashInsights::new();
        let old_key = a.dedupe_key();
        ci.record(a);
        ci.record(b);
        assert!(ci.mark_hosted_delivered(&old_key));
        assert_eq!(ci.pending_hosted_deliveries().len(), 1);
        assert_eq!(ci.pending_hosted_deliveries()[0].generation, "gen-new");
    }

    #[test]
    fn pending_hosted_deliveries_preserve_chronological_order() {
        let mut ci = CrashInsights::new();
        for i in 0..5 {
            let mut record = make_record(&format!("w{}", i), Some(1), None);
            record.generation = format!("gen-{}", i);
            ci.record(record);
        }

        let pending = ci.pending_hosted_deliveries();
        let names: Vec<&str> = pending.iter().map(|r| r.agent_name.as_str()).collect();
        assert_eq!(names, vec!["w0", "w1", "w2", "w3", "w4"]);
    }

    #[test]
    fn retention_bounds_pending_hosted_delivery_backlog() {
        // Explicit retention bound: once the generic crash history is full,
        // delivered records are evicted before pending hosted exits so the
        // durable outbox survives a prolonged outage.
        let mut ci = CrashInsights {
            records: Vec::new(),
            max_records: 3,
            dirty: false,
            save_failures_total: 0,
            retention_pressure_total: 0,
        };
        let mut delivered = make_record("delivered", Some(1), None);
        delivered.generation = "gen-delivered".to_string();
        delivered.hosted_delivery = HostedDeliveryState::Delivered;
        ci.record(delivered);
        for i in 0..5 {
            let mut record = make_record(&format!("w{}", i), Some(1), None);
            record.generation = format!("gen-{}", i);
            ci.record(record);
        }

        assert_eq!(ci.total(), 5);
        assert_eq!(ci.pending_hosted_deliveries().len(), 5);
        let names: Vec<&str> = ci
            .pending_hosted_deliveries()
            .iter()
            .map(|r| r.agent_name.as_str())
            .collect();
        assert_eq!(names, vec!["w0", "w1", "w2", "w3", "w4"]);
        assert!(ci
            .recent(5)
            .iter()
            .all(|record| record.hosted_delivery == HostedDeliveryState::Pending));
    }

    #[test]
    fn hosted_delivery_state_survives_atomic_persistence_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("crashes.json");
        let mut ci = CrashInsights::new();
        let mut delivered = make_record("delivered-agent", Some(1), None);
        delivered.generation = "gen-delivered".to_string();
        let delivered_key = delivered.dedupe_key();
        ci.record(delivered);
        ci.mark_hosted_delivered(&delivered_key);

        let mut pending = make_record("pending-agent", Some(1), None);
        pending.generation = "gen-pending".to_string();
        ci.record(pending);

        ci.save(&path).unwrap();
        let reloaded = CrashInsights::load(&path);

        assert_eq!(reloaded.pending_hosted_deliveries().len(), 1);
        assert_eq!(
            reloaded.pending_hosted_deliveries()[0].agent_name,
            "pending-agent"
        );
    }

    #[test]
    fn dedupe_key_and_persistence_handle_utf8_agent_names() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("crashes.json");
        let mut ci = CrashInsights::new();
        let mut record = make_record("agent-日本語-🚀", Some(1), None);
        record.generation = "gen-utf8".to_string();
        let key = record.dedupe_key();
        assert_eq!(key, "agent-日本語-🚀::gen-utf8");
        ci.record(record);

        ci.save(&path).unwrap();
        let mut reloaded = CrashInsights::load(&path);
        assert_eq!(reloaded.pending_hosted_deliveries().len(), 1);
        assert!(reloaded.mark_hosted_delivered(&key));
        reloaded.save(&path).unwrap();

        let reloaded_again = CrashInsights::load(&path);
        assert_eq!(reloaded_again.pending_hosted_deliveries().len(), 0);
    }

    #[test]
    fn retention_pressure_counter_increments_when_pending_outbox_blocks_eviction() {
        // Documented pressure policy: when every record above the generic
        // cap is a still-pending durable outbox entry, `record` must not
        // silently evict any of them — instead it must count the pressure
        // event so operators can see it (see `retention_pressure_total`
        // doc comment and the module-level storage-tradeoff docs above).
        let mut ci = CrashInsights {
            records: Vec::new(),
            max_records: 3,
            dirty: false,
            save_failures_total: 0,
            retention_pressure_total: 0,
        };

        for i in 0..6 {
            let mut record = make_record(&format!("w{}", i), Some(1), None);
            record.generation = format!("gen-{}", i);
            ci.record(record);
        }

        assert_eq!(
            ci.total(),
            6,
            "pending outbox records must never be silently evicted under pressure"
        );
        assert_eq!(ci.pending_hosted_deliveries().len(), 6);
        // Pressure fires once per `record` call once the cap is exceeded
        // and nothing evictable is found: records 4, 5, and 6 (indices 3..6)
        // each hit the cap with zero non-pending candidates.
        assert_eq!(
            ci.retention_pressure_total(),
            3,
            "every record call that could not evict anything must count as pressure"
        );

        // Once a delivery is acknowledged, the evictable record is removed
        // (never counted as pressure for that removal); pressure only fires
        // again for the remaining, still-all-pending excess above the cap.
        let delivered_key = ci.records[0].dedupe_key();
        assert!(ci.mark_hosted_delivered(&delivered_key));
        let mut record = make_record("w6", Some(1), None);
        record.generation = "gen-6".to_string();
        ci.record(record);
        assert_eq!(
            ci.retention_pressure_total(),
            4,
            "the one evictable (delivered) record is removed for free; pressure fires \
             again only for the remaining pending excess above the cap"
        );
        assert_eq!(ci.pending_hosted_deliveries().len(), 6);
        assert_eq!(
            ci.total(),
            6,
            "the delivered record was evicted, keeping total at 6"
        );
    }

    #[test]
    fn persist_failure_increments_counter_and_stays_dirty() {
        // Deterministic forced-failure fixture: `parent` is a *file*, not a
        // directory, so `std::fs::create_dir_all(parent)` inside `save`
        // fails every time on every platform — no flaky IO mocking needed.
        let dir = tempfile::tempdir().unwrap();
        let not_a_dir = dir.path().join("not-a-directory");
        std::fs::write(&not_a_dir, b"blocking file").unwrap();
        let path = not_a_dir.join("crashes.json");

        let mut ci = CrashInsights::new();
        ci.record(make_record("w1", Some(1), None));
        assert!(ci.is_dirty());
        assert_eq!(ci.save_failures_total(), 0);

        assert!(!ci.persist(&path), "forced-failure path must fail");
        assert_eq!(
            ci.save_failures_total(),
            1,
            "a failed persist must be counted, not merely logged"
        );
        assert!(
            ci.is_dirty(),
            "a failed persist must leave (or re-set) the dirty flag so a later flush retries"
        );

        // A second failed attempt keeps incrementing and stays dirty —
        // durability is never silently given up on.
        assert!(!ci.persist(&path));
        assert_eq!(ci.save_failures_total(), 2);
        assert!(ci.is_dirty());
    }

    #[test]
    fn persist_recovery_clears_dirty_and_stops_incrementing() {
        let dir = tempfile::tempdir().unwrap();
        let not_a_dir = dir.path().join("not-a-directory");
        std::fs::write(&not_a_dir, b"blocking file").unwrap();
        let bad_path = not_a_dir.join("crashes.json");
        let good_path = dir.path().join("crashes.json");

        let mut ci = CrashInsights::new();
        ci.record(make_record("w1", Some(1), None));

        // Fail twice against the unwritable path.
        assert!(!ci.persist(&bad_path));
        assert!(!ci.persist(&bad_path));
        assert_eq!(ci.save_failures_total(), 2);
        assert!(ci.is_dirty());

        // Recovery: the next attempt against a writable path succeeds,
        // clears the dirty flag, and does not touch the failure counter.
        assert!(ci.persist(&good_path));
        assert_eq!(
            ci.save_failures_total(),
            2,
            "a successful persist must not increment the failure counter"
        );
        assert!(
            !ci.is_dirty(),
            "a confirmed-successful persist must clear the dirty flag"
        );

        // take_dirty() reflects the cleared state and further successful
        // persists remain no-ops on the counter.
        assert!(!ci.take_dirty());
        assert!(ci.persist(&good_path));
        assert_eq!(ci.save_failures_total(), 2);

        let loaded = CrashInsights::load(&good_path);
        assert_eq!(loaded.total(), 1);
        assert_eq!(loaded.records[0].agent_name, "w1");
    }

    #[test]
    fn recent_returns_most_recent() {
        let mut ci = CrashInsights::new();
        for i in 0..10 {
            ci.record(make_record(&format!("w{}", i), Some(1), None));
        }

        let recent = ci.recent(3);
        assert_eq!(recent.len(), 3);
        assert_eq!(recent[0].agent_name, "w7");
        assert_eq!(recent[2].agent_name, "w9");
    }
}
