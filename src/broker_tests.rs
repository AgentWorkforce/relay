//! Tests for broker.rs module.
//!
//! broker.rs public API:
//!   - BrokerState::default() -> Self (empty agents HashMap)
//!   - BrokerState::load(path: &Path) -> Result<Self>
//!   - BrokerState::save(path: &Path) -> Result<()>
//!   - BrokerState::reap_dead_agents(&mut self) -> Vec<String>

#[cfg(test)]
mod tests {
    use std::path::Path;

    use crate::broker::{BrokerState, PersistedAgent};
    use relay_broker::protocol::AgentRuntime;

    #[test]
    fn broker_state_default_is_empty() {
        let state = BrokerState::default();
        assert!(state.agents.is_empty());
    }

    #[test]
    fn broker_state_save_and_load_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        let mut state = BrokerState::default();
        state.agents.insert(
            "w1".into(),
            PersistedAgent {
                runtime: AgentRuntime::Pty,
                parent: None,
                channels: vec![],
                pid: Some(1),
                started_at: None,
                spec: None,
                restart_policy: None,
                initial_task: None,
            },
        );
        state.save(&path).unwrap();
        let loaded = BrokerState::load(&path).unwrap();
        assert_eq!(loaded.agents.len(), 1);
        assert!(loaded.agents.contains_key("w1"));
    }

    #[test]
    fn broker_state_load_missing_file_errors() {
        let result = BrokerState::load(Path::new("/nonexistent/state.json"));
        assert!(result.is_err());
    }

    #[test]
    fn reap_dead_agents_removes_stale_no_pid() {
        // Agents with pid=None are stale → reap removes them
        let mut state = BrokerState::default();
        state.agents.insert(
            "ghost".into(),
            PersistedAgent {
                runtime: AgentRuntime::Pty,
                parent: None,
                channels: vec![],
                pid: None,
                started_at: None,
                spec: None,
                restart_policy: None,
                initial_task: None,
            },
        );
        let reaped = state.reap_dead_agents();
        assert_eq!(reaped, vec!["ghost"]);
        assert!(state.agents.is_empty());
    }

    #[test]
    fn reap_dead_agents_keeps_live_processes() {
        // Agents with pid=Some(current_pid) survive reap
        let mut state = BrokerState::default();
        state.agents.insert(
            "alive".into(),
            PersistedAgent {
                runtime: AgentRuntime::Pty,
                parent: None,
                channels: vec![],
                pid: Some(std::process::id()),
                started_at: None,
                spec: None,
                restart_policy: None,
                initial_task: None,
            },
        );
        assert!(state.reap_dead_agents().is_empty());
        assert_eq!(state.agents.len(), 1);
    }
}
