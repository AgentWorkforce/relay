use std::{collections::HashMap, io::Write, path::Path};

use crate::{
    protocol::{AgentRuntime, AgentSpec},
    supervisor::RestartPolicy,
};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

pub(crate) mod continuity;
pub(crate) mod delivery_verification;
pub(crate) mod injection_format;

/// Check if a process with the given PID is alive.
#[cfg(unix)]
pub(crate) fn is_pid_alive(pid: u32) -> bool {
    // kill(pid, 0) checks existence without sending a signal
    let rc = unsafe { nix::libc::kill(pid as i32, 0) };
    if rc == 0 {
        return true;
    }
    // EPERM means the process exists but we can't signal it (different user)
    let err = std::io::Error::last_os_error();
    err.raw_os_error() == Some(nix::libc::EPERM)
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub(crate) struct BrokerState {
    pub(crate) agents: HashMap<String, PersistedAgent>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct PersistedAgent {
    pub(crate) runtime: AgentRuntime,
    pub(crate) parent: Option<String>,
    pub(crate) channels: Vec<String>,
    #[serde(default)]
    pub(crate) pid: Option<u32>,
    #[serde(default)]
    pub(crate) started_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) spec: Option<AgentSpec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) restart_policy: Option<RestartPolicy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) initial_task: Option<String>,
}

impl BrokerState {
    pub(crate) fn load(path: &Path) -> Result<Self> {
        let body = std::fs::read_to_string(path)
            .with_context(|| format!("failed reading state file {}", path.display()))?;
        let state = serde_json::from_str::<Self>(&body)
            .with_context(|| format!("failed parsing state file {}", path.display()))?;
        Ok(state)
    }

    pub(crate) fn save(&self, path: &Path) -> Result<()> {
        let body = serde_json::to_vec_pretty(self)?;
        let dir = path
            .parent()
            .with_context(|| format!("state path has no parent: {}", path.display()))?;
        let mut tmp = tempfile::NamedTempFile::new_in(dir)
            .with_context(|| format!("failed creating temp file in {}", dir.display()))?;
        tmp.write_all(&body)
            .with_context(|| "failed writing to temp state file")?;
        tmp.persist(path)
            .with_context(|| format!("failed persisting state file to {}", path.display()))?;
        Ok(())
    }

    /// Remove persisted agents whose PIDs are no longer alive.
    /// Returns the names of agents that were cleaned up.
    #[cfg(unix)]
    pub(crate) fn reap_dead_agents(&mut self) -> Vec<String> {
        let dead: Vec<String> = self
            .agents
            .iter()
            .filter(|(_, agent)| {
                if let Some(pid) = agent.pid {
                    !is_pid_alive(pid)
                } else {
                    // No PID recorded — stale entry from before PID tracking, remove it
                    true
                }
            })
            .map(|(name, _)| name.clone())
            .collect();

        for name in &dead {
            self.agents.remove(name);
        }
        dead
    }

    #[cfg(not(unix))]
    pub(crate) fn reap_dead_agents(&mut self) -> Vec<String> {
        // On non-Unix platforms, clear all agents without PID info
        let dead: Vec<String> = self
            .agents
            .iter()
            .filter(|(_, agent)| agent.pid.is_none())
            .map(|(name, _)| name.clone())
            .collect();
        for name in &dead {
            self.agents.remove(name);
        }
        dead
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::AgentRuntime;

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
