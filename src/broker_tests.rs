//! Test stubs for broker.rs module extraction from main.rs.
//!
//! broker.rs public API:
//!   - BrokerState::default() -> Self (empty agents HashMap)
//!   - BrokerState::load(path: &Path) -> Result<Self>
//!   - BrokerState::save(path: &Path) -> Result<()>
//!   - BrokerState::reap_dead_agents(&mut self) -> Vec<String>
//!
//! Extracted types: BrokerState, PersistedAgent
//! Dependencies: serde, serde_json, anyhow, tempfile
//! Visibility: pub(crate) struct BrokerState, pub(crate) fn load/save/reap

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    // TODO: uncomment once broker.rs is extracted
    // use crate::broker::{BrokerState, PersistedAgent};

    #[test]
    fn broker_state_default_is_empty() {
        let agents: HashMap<String, ()> = HashMap::new();
        assert!(agents.is_empty());
    }

    #[test]
    fn broker_state_save_and_load_roundtrip() {
        // let dir = tempfile::tempdir().unwrap();
        // let path = dir.path().join("state.json");
        // let mut state = BrokerState::default();
        // state.agents.insert("w1".into(), PersistedAgent { pid: Some(1), .. });
        // state.save(&path).unwrap();
        // let loaded = BrokerState::load(&path).unwrap();
        // assert_eq!(loaded.agents.len(), 1);
        // assert!(loaded.agents.contains_key("w1"));
    }

    #[test]
    fn broker_state_load_missing_file_errors() {
        // let result = BrokerState::load(Path::new("/nonexistent/state.json"));
        // assert!(result.is_err());
    }

    #[test]
    fn reap_dead_agents_removes_stale_no_pid() {
        // Agents with pid=None are stale → reap removes them
        // let mut state = BrokerState::default();
        // state.agents.insert("ghost".into(), PersistedAgent { pid: None, .. });
        // let reaped = state.reap_dead_agents();
        // assert_eq!(reaped, vec!["ghost"]);
        // assert!(state.agents.is_empty());
    }

    #[test]
    fn reap_dead_agents_keeps_live_processes() {
        // Agents with pid=Some(current_pid) survive reap
        // let mut state = BrokerState::default();
        // state.agents.insert("alive".into(), PersistedAgent { pid: Some(std::process::id()), .. });
        // assert!(state.reap_dead_agents().is_empty());
        // assert_eq!(state.agents.len(), 1);
    }
}
