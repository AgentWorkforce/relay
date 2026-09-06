use std::{collections::HashMap, io::Write, path::Path};

use crate::{
    ids::{ChannelName, WorkerName},
    protocol::{AgentRuntime, AgentSpec},
    supervisor::RestartPolicy,
};
use anyhow::{Context, Result};
use serde::{Deserialize, Deserializer, Serialize};

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
    pub(crate) agents: HashMap<WorkerName, PersistedAgent>,
    /// Identities whose local process has been released but whose Relaycast
    /// terminal release still needs a retry. This is deliberately separate
    /// from `agents`: a stale persisted worker entry is not evidence that a
    /// name-based remote release is safe (the name may have been reused).
    #[serde(
        default,
        deserialize_with = "deserialize_pending_identity_releases",
        skip_serializing_if = "HashMap::is_empty"
    )]
    pub(crate) pending_identity_releases: HashMap<WorkerName, PendingIdentityRelease>,
}

fn deserialize_pending_identity_releases<'de, D>(
    deserializer: D,
) -> std::result::Result<HashMap<WorkerName, PendingIdentityRelease>, D::Error>
where
    D: Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum StoredPendingIdentityReleases {
        Exact(HashMap<WorkerName, PendingIdentityRelease>),
        LegacyNames(Vec<WorkerName>),
    }

    match StoredPendingIdentityReleases::deserialize(deserializer)? {
        StoredPendingIdentityReleases::Exact(exact) => Ok(exact),
        // The unpublished name-only shape has no identity/generation proof.
        // Discard it rather than either refusing to start or reviving an unsafe
        // name-based release after upgrade.
        StoredPendingIdentityReleases::LegacyNames(names) => {
            tracing::warn!(
                count = names.len(),
                "discarding legacy name-only pending identity releases"
            );
            Ok(HashMap::new())
        }
    }
}

/// The exact Relaycast identity owned by one local worker process generation.
///
/// Relaycast's release endpoint is name-addressed, so a retry must first prove
/// that the name still resolves to this immutable id. The local generation is
/// an independent guard against a stale handle releasing a replacement process
/// that recovered the same Relaycast identity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct PendingIdentityRelease {
    pub(crate) agent_id: String,
    pub(crate) generation: uuid::Uuid,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct PersistedAgent {
    pub(crate) runtime: AgentRuntime,
    pub(crate) parent: Option<String>,
    pub(crate) channels: Vec<ChannelName>,
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
    /// Immutable Relaycast id bound by `agent.register` for this process.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) relaycast_agent_id: Option<String>,
    /// Broker-local process generation that owns `relaycast_agent_id`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) generation: Option<uuid::Uuid>,
}

impl BrokerState {
    /// Preserve the exact remote identity before removing an exited worker.
    ///
    /// `fallback_agent_id` is the authoritative in-memory fleet binding. It
    /// covers state files written before these fields existed while never
    /// falling back to a name-only remote release.
    pub(crate) fn defer_identity_release(
        &mut self,
        name: &WorkerName,
        generation: uuid::Uuid,
        fallback_agent_id: Option<&str>,
    ) -> Option<PendingIdentityRelease> {
        let persisted = self.agents.get(name);
        if persisted
            .and_then(|agent| agent.generation)
            .is_some_and(|stored| stored != generation)
        {
            return None;
        }
        let agent_id = persisted
            .and_then(|agent| agent.relaycast_agent_id.as_deref())
            .or(fallback_agent_id)?
            .trim();
        if agent_id.is_empty() {
            return None;
        }
        let pending = PendingIdentityRelease {
            agent_id: agent_id.to_string(),
            generation,
        };
        self.pending_identity_releases
            .insert(name.clone(), pending.clone());
        Some(pending)
    }

    pub(crate) fn clear_pending_identity_release(
        &mut self,
        name: &WorkerName,
        released: &PendingIdentityRelease,
    ) {
        if self.pending_identity_releases.get(name) == Some(released) {
            self.pending_identity_releases.remove(name);
        }
    }

    /// Remove one exited process while atomically retaining the exact cleanup
    /// lease in broker state. Callers save the state after this returns, so a
    /// restart can never observe the agent removed without its pending release.
    pub(crate) fn remove_agent_after_exit(
        &mut self,
        name: &WorkerName,
        generation: uuid::Uuid,
        fallback_agent_id: Option<&str>,
    ) -> Option<PersistedAgent> {
        self.defer_identity_release(name, generation, fallback_agent_id);
        self.agents.remove(name)
    }

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
    pub(crate) fn reap_dead_agents(&mut self) -> Vec<WorkerName> {
        let dead: Vec<WorkerName> = self
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
            if let Some(generation) = self.agents.get(name).and_then(|agent| agent.generation) {
                self.remove_agent_after_exit(name, generation, None);
            } else {
                self.agents.remove(name);
            }
        }
        dead
    }

    #[cfg(not(unix))]
    pub(crate) fn reap_dead_agents(&mut self) -> Vec<WorkerName> {
        // On non-Unix platforms, clear all agents without PID info
        let dead: Vec<WorkerName> = self
            .agents
            .iter()
            .filter(|(_, agent)| agent.pid.is_none())
            .map(|(name, _)| name.clone())
            .collect();
        for name in &dead {
            if let Some(generation) = self.agents.get(name).and_then(|agent| agent.generation) {
                self.remove_agent_after_exit(name, generation, None);
            } else {
                self.agents.remove(name);
            }
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
        let pending = PendingIdentityRelease {
            agent_id: "agent-pending".into(),
            generation: uuid::Uuid::new_v4(),
        };
        state
            .pending_identity_releases
            .insert("pending".into(), pending.clone());
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
                relaycast_agent_id: Some("agent-w1".into()),
                generation: Some(uuid::Uuid::new_v4()),
            },
        );
        state.save(&path).unwrap();
        let loaded = BrokerState::load(&path).unwrap();
        assert_eq!(loaded.agents.len(), 1);
        assert!(loaded.agents.contains_key("w1"));
        assert_eq!(
            loaded.pending_identity_releases.get("pending"),
            Some(&pending)
        );
    }

    #[test]
    fn broker_state_load_missing_file_errors() {
        let result = BrokerState::load(Path::new("/nonexistent/state.json"));
        assert!(result.is_err());
    }

    #[test]
    fn broker_state_load_discards_unverifiable_name_only_pending_releases() {
        let state: BrokerState = serde_json::from_value(serde_json::json!({
            "agents": {},
            "pending_identity_releases": ["stale-name"]
        }))
        .expect("legacy pending-release state should remain loadable");

        assert!(state.pending_identity_releases.is_empty());
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
                relaycast_agent_id: None,
                generation: None,
            },
        );
        let reaped = state.reap_dead_agents();
        assert_eq!(reaped, vec!["ghost"]);
        assert!(state.agents.is_empty());
    }

    #[test]
    fn reap_dead_agents_retains_exact_identity_cleanup_for_first_release() {
        let generation = uuid::Uuid::new_v4();
        let mut state = BrokerState::default();
        state.agents.insert(
            "exited".into(),
            PersistedAgent {
                runtime: AgentRuntime::Pty,
                parent: None,
                channels: vec![],
                pid: None,
                started_at: None,
                spec: None,
                restart_policy: None,
                initial_task: None,
                relaycast_agent_id: Some("agent-old-generation".into()),
                generation: Some(generation),
            },
        );

        assert_eq!(state.reap_dead_agents(), vec![WorkerName::from("exited")]);
        assert_eq!(
            state.pending_identity_releases.get("exited"),
            Some(&PendingIdentityRelease {
                agent_id: "agent-old-generation".into(),
                generation,
            })
        );
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
                relaycast_agent_id: None,
                generation: None,
            },
        );
        assert!(state.reap_dead_agents().is_empty());
        assert_eq!(state.agents.len(), 1);
    }
}
