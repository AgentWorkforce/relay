//! Crash recording, analysis, and pattern detection.
//!
//! Classifies agent crashes by exit code and signal, maintains a bounded
//! history, detects patterns, and computes a health score.

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
        self.records.push(crash);
        if self.records.len() > self.max_records {
            let excess = self.records.len() - self.max_records;
            self.records.drain(..excess);
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
                return true;
            }
        }
        false
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
    fn records_trimmed_to_max() {
        let mut ci = CrashInsights {
            records: Vec::new(),
            max_records: 3,
        };

        for i in 0..5 {
            ci.record(make_record(&format!("w{}", i), Some(1), None));
        }

        assert_eq!(ci.total(), 3);
        // Should keep the 3 most recent
        assert_eq!(ci.records[0].agent_name, "w2");
        assert_eq!(ci.records[1].agent_name, "w3");
        assert_eq!(ci.records[2].agent_name, "w4");
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
        // Explicit retention bound: if pending deliveries pile up past
        // `max_records`, the oldest are evicted along with the rest of the
        // ring buffer rather than growing the outbox file without limit.
        let mut ci = CrashInsights {
            records: Vec::new(),
            max_records: 3,
        };
        for i in 0..5 {
            let mut record = make_record(&format!("w{}", i), Some(1), None);
            record.generation = format!("gen-{}", i);
            ci.record(record);
        }

        assert_eq!(ci.pending_hosted_deliveries().len(), 3);
        let names: Vec<&str> = ci
            .pending_hosted_deliveries()
            .iter()
            .map(|r| r.agent_name.as_str())
            .collect();
        assert_eq!(names, vec!["w2", "w3", "w4"]);
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
