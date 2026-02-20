//! Metrics collection for the broker and individual agents.
//!
//! Tracks spawn/crash/restart/release counts and provides JSON and
//! Prometheus text format export.

use std::collections::HashMap;
use std::time::Instant;

use serde::Serialize;

/// Status of an agent from the metrics perspective.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentStatus {
    Healthy,
    Restarting,
    Dead,
    Released,
}

/// Per-agent statistics.
#[derive(Debug, Clone, Serialize)]
pub struct AgentStats {
    pub spawns: u32,
    pub crashes: u32,
    pub restarts: u32,
    pub releases: u32,
    pub status: AgentStatus,
    pub current_uptime_secs: u64,
    pub memory_bytes: u64,
}

/// Broker-wide statistics snapshot.
#[derive(Debug, Clone, Serialize)]
pub struct BrokerStats {
    pub uptime_secs: u64,
    pub total_agents_spawned: u32,
    pub total_crashes: u32,
    pub total_restarts: u32,
    pub active_agents: usize,
}

/// Internal mutable record for each agent seen by the collector.
struct AgentRecord {
    spawns: u32,
    crashes: u32,
    restarts: u32,
    releases: u32,
    status: AgentStatus,
    last_spawn: Option<Instant>,
    memory_bytes: u64,
}

impl AgentRecord {
    fn new() -> Self {
        Self {
            spawns: 0,
            crashes: 0,
            restarts: 0,
            releases: 0,
            status: AgentStatus::Healthy,
            last_spawn: None,
            memory_bytes: 0,
        }
    }

    fn to_stats(&self) -> AgentStats {
        let uptime = self
            .last_spawn
            .map(|t| t.elapsed().as_secs())
            .unwrap_or(0);
        AgentStats {
            spawns: self.spawns,
            crashes: self.crashes,
            restarts: self.restarts,
            releases: self.releases,
            status: self.status,
            current_uptime_secs: uptime,
            memory_bytes: self.memory_bytes,
        }
    }
}

/// Collects metrics for the broker lifecycle.
pub struct MetricsCollector {
    broker_start: Instant,
    agents: HashMap<String, AgentRecord>,
}

impl MetricsCollector {
    pub fn new(broker_start: Instant) -> Self {
        Self {
            broker_start,
            agents: HashMap::new(),
        }
    }

    pub fn on_spawn(&mut self, name: &str) {
        let record = self
            .agents
            .entry(name.to_string())
            .or_insert_with(AgentRecord::new);
        record.spawns += 1;
        record.status = AgentStatus::Healthy;
        record.last_spawn = Some(Instant::now());
    }

    pub fn on_crash(&mut self, name: &str) {
        let record = self
            .agents
            .entry(name.to_string())
            .or_insert_with(AgentRecord::new);
        record.crashes += 1;
        record.status = AgentStatus::Restarting;
    }

    pub fn on_restart(&mut self, name: &str) {
        let record = self
            .agents
            .entry(name.to_string())
            .or_insert_with(AgentRecord::new);
        record.restarts += 1;
        record.status = AgentStatus::Healthy;
        record.last_spawn = Some(Instant::now());
    }

    pub fn on_release(&mut self, name: &str) {
        let record = self
            .agents
            .entry(name.to_string())
            .or_insert_with(AgentRecord::new);
        record.releases += 1;
        record.status = AgentStatus::Released;
    }

    pub fn on_permanent_death(&mut self, name: &str) {
        let record = self
            .agents
            .entry(name.to_string())
            .or_insert_with(AgentRecord::new);
        record.status = AgentStatus::Dead;
    }

    /// Update memory reading for an agent.
    pub fn update_memory(&mut self, name: &str, bytes: u64) {
        if let Some(record) = self.agents.get_mut(name) {
            record.memory_bytes = bytes;
        }
    }

    /// Get stats for a single agent.
    pub fn agent_stats(&self, name: &str) -> Option<AgentStats> {
        self.agents.get(name).map(|r| r.to_stats())
    }

    /// Snapshot of broker-wide stats.
    pub fn snapshot(&self, active_agent_count: usize) -> BrokerStats {
        let mut total_spawned = 0u32;
        let mut total_crashes = 0u32;
        let mut total_restarts = 0u32;
        for record in self.agents.values() {
            total_spawned += record.spawns;
            total_crashes += record.crashes;
            total_restarts += record.restarts;
        }
        BrokerStats {
            uptime_secs: self.broker_start.elapsed().as_secs(),
            total_agents_spawned: total_spawned,
            total_crashes,
            total_restarts,
            active_agents: active_agent_count,
        }
    }

    /// Export metrics in Prometheus text exposition format.
    pub fn to_prometheus(&self, active_agent_count: usize) -> String {
        let broker = self.snapshot(active_agent_count);
        let mut out = String::new();

        out.push_str("# HELP relay_broker_uptime_seconds Broker uptime in seconds.\n");
        out.push_str("# TYPE relay_broker_uptime_seconds gauge\n");
        out.push_str(&format!(
            "relay_broker_uptime_seconds {}\n",
            broker.uptime_secs
        ));

        out.push_str("# HELP relay_broker_agents_spawned_total Total agents spawned.\n");
        out.push_str("# TYPE relay_broker_agents_spawned_total counter\n");
        out.push_str(&format!(
            "relay_broker_agents_spawned_total {}\n",
            broker.total_agents_spawned
        ));

        out.push_str("# HELP relay_broker_crashes_total Total agent crashes.\n");
        out.push_str("# TYPE relay_broker_crashes_total counter\n");
        out.push_str(&format!(
            "relay_broker_crashes_total {}\n",
            broker.total_crashes
        ));

        out.push_str("# HELP relay_broker_restarts_total Total agent restarts.\n");
        out.push_str("# TYPE relay_broker_restarts_total counter\n");
        out.push_str(&format!(
            "relay_broker_restarts_total {}\n",
            broker.total_restarts
        ));

        out.push_str("# HELP relay_broker_active_agents Current active agents.\n");
        out.push_str("# TYPE relay_broker_active_agents gauge\n");
        out.push_str(&format!(
            "relay_broker_active_agents {}\n",
            broker.active_agents
        ));

        // Per-agent metrics
        for (name, record) in &self.agents {
            let stats = record.to_stats();
            out.push_str(&format!(
                "relay_agent_crashes_total{{agent=\"{}\"}} {}\n",
                name, stats.crashes
            ));
            out.push_str(&format!(
                "relay_agent_restarts_total{{agent=\"{}\"}} {}\n",
                name, stats.restarts
            ));
            out.push_str(&format!(
                "relay_agent_memory_bytes{{agent=\"{}\"}} {}\n",
                name, stats.memory_bytes
            ));
        }

        out
    }

    /// Export metrics as a serde_json::Value (for JSON endpoints).
    pub fn to_json(&self, active_agent_count: usize) -> serde_json::Value {
        let broker = self.snapshot(active_agent_count);
        let agents: HashMap<String, AgentStats> = self
            .agents
            .iter()
            .map(|(name, record)| (name.clone(), record.to_stats()))
            .collect();

        serde_json::json!({
            "broker": broker,
            "agents": agents,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_collector_has_zero_stats() {
        let mc = MetricsCollector::new(Instant::now());
        let snap = mc.snapshot(0);
        assert_eq!(snap.total_agents_spawned, 0);
        assert_eq!(snap.total_crashes, 0);
        assert_eq!(snap.total_restarts, 0);
        assert_eq!(snap.active_agents, 0);
    }

    #[test]
    fn on_spawn_increments_count_and_sets_healthy() {
        let mut mc = MetricsCollector::new(Instant::now());
        mc.on_spawn("w1");

        let stats = mc.agent_stats("w1").unwrap();
        assert_eq!(stats.spawns, 1);
        assert_eq!(stats.status, AgentStatus::Healthy);

        let snap = mc.snapshot(1);
        assert_eq!(snap.total_agents_spawned, 1);
    }

    #[test]
    fn on_crash_increments_and_marks_restarting() {
        let mut mc = MetricsCollector::new(Instant::now());
        mc.on_spawn("w1");
        mc.on_crash("w1");

        let stats = mc.agent_stats("w1").unwrap();
        assert_eq!(stats.crashes, 1);
        assert_eq!(stats.status, AgentStatus::Restarting);
    }

    #[test]
    fn on_restart_resets_to_healthy() {
        let mut mc = MetricsCollector::new(Instant::now());
        mc.on_spawn("w1");
        mc.on_crash("w1");
        mc.on_restart("w1");

        let stats = mc.agent_stats("w1").unwrap();
        assert_eq!(stats.restarts, 1);
        assert_eq!(stats.status, AgentStatus::Healthy);
    }

    #[test]
    fn on_release_marks_released() {
        let mut mc = MetricsCollector::new(Instant::now());
        mc.on_spawn("w1");
        mc.on_release("w1");

        let stats = mc.agent_stats("w1").unwrap();
        assert_eq!(stats.releases, 1);
        assert_eq!(stats.status, AgentStatus::Released);
    }

    #[test]
    fn permanent_death_marks_dead() {
        let mut mc = MetricsCollector::new(Instant::now());
        mc.on_spawn("w1");
        mc.on_permanent_death("w1");

        let stats = mc.agent_stats("w1").unwrap();
        assert_eq!(stats.status, AgentStatus::Dead);
    }

    #[test]
    fn snapshot_aggregates_all_agents() {
        let mut mc = MetricsCollector::new(Instant::now());
        mc.on_spawn("w1");
        mc.on_spawn("w2");
        mc.on_crash("w1");
        mc.on_restart("w1");

        let snap = mc.snapshot(2);
        assert_eq!(snap.total_agents_spawned, 2);
        assert_eq!(snap.total_crashes, 1);
        assert_eq!(snap.total_restarts, 1);
        assert_eq!(snap.active_agents, 2);
    }

    #[test]
    fn update_memory_is_reflected_in_stats() {
        let mut mc = MetricsCollector::new(Instant::now());
        mc.on_spawn("w1");
        mc.update_memory("w1", 1024 * 1024);

        let stats = mc.agent_stats("w1").unwrap();
        assert_eq!(stats.memory_bytes, 1024 * 1024);
    }

    #[test]
    fn prometheus_format_contains_expected_metrics() {
        let mut mc = MetricsCollector::new(Instant::now());
        mc.on_spawn("w1");
        mc.on_crash("w1");

        let prom = mc.to_prometheus(1);
        assert!(prom.contains("relay_broker_uptime_seconds"));
        assert!(prom.contains("relay_broker_agents_spawned_total 1"));
        assert!(prom.contains("relay_broker_crashes_total 1"));
        assert!(prom.contains("relay_broker_active_agents 1"));
        assert!(prom.contains("relay_agent_crashes_total{agent=\"w1\"} 1"));
    }

    #[test]
    fn json_export_has_broker_and_agents() {
        let mut mc = MetricsCollector::new(Instant::now());
        mc.on_spawn("w1");

        let json = mc.to_json(1);
        assert!(json.get("broker").is_some());
        assert!(json.get("agents").is_some());
        assert_eq!(json["broker"]["total_agents_spawned"], 1);
    }

    #[test]
    fn unknown_agent_returns_none() {
        let mc = MetricsCollector::new(Instant::now());
        assert!(mc.agent_stats("nope").is_none());
    }

    #[test]
    fn multiple_spawns_of_same_agent_accumulate() {
        let mut mc = MetricsCollector::new(Instant::now());
        mc.on_spawn("w1");
        mc.on_crash("w1");
        mc.on_spawn("w1"); // re-spawn

        let stats = mc.agent_stats("w1").unwrap();
        assert_eq!(stats.spawns, 2);
        assert_eq!(stats.crashes, 1);
    }
}
