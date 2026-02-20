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
            return (
                CrashCategory::Signal,
                format!("Killed by signal {}", sig),
            );
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
            Some(code) if code != 0 => (
                CrashCategory::Error,
                format!("Exited with code {}", code),
            ),
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
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(path, json)?;
        Ok(())
    }

    /// Export as JSON value for API responses.
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "total_crashes": self.total(),
            "recent": self.recent(20),
            "patterns": self.patterns(),
            "health_score": self.health_score(),
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
