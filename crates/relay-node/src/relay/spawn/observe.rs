//! Looking at spawned agents: whether each one's process runs and what its
//! harness is doing, from what the harness itself leaves on this computer.
//! Each harness's adapter reads its own (`relay::harness`); a session no
//! adapter here owns is unknown and keeps its place.
//!
//! The spawner answers whether a session is alive; this adds what it cannot
//! say. A spawner that can tell more itself (a systemd scope's state, say)
//! would answer through the same `Observe` seam.

use super::lifecycle::Observation;
use crate::relay::harness::Registry;
use crate::relay::spawn::launch::SpawnedProcess;
use crate::relay::state::{ProcessLiveness, WorkState};
use crate::relay::store::Target;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// One spawned agent to look at.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Watched {
    pub name: String,
    pub target: Target,
    pub process: Option<SpawnedProcess>,
    /// What the spawner says: false when its process is gone or its Codex
    /// thread archived.
    pub alive: bool,
}

/// Looks at spawned agents. Blocking: it reads files and may ask a
/// harness, such as Codex's app-server.
pub trait Observe: Send + Sync {
    /// One observation per agent, in order.
    fn observe(&self, agents: &[Watched]) -> Vec<Observation>;
}

/// Looks at agents on this computer, each through the adapter of the
/// harness that started it; each adapter is asked once, for all of its own.
pub struct RegistryObserver(pub Registry);

impl Observe for RegistryObserver {
    fn observe(&self, agents: &[Watched]) -> Vec<Observation> {
        let mut observed: Vec<Option<Observation>> = vec![None; agents.len()];
        for (_, facet) in self.0.spawners() {
            let mine: Vec<usize> = (0..agents.len())
                .filter(|i| observed[*i].is_none() && facet.owns(&agents[*i].target))
                .collect();
            if mine.is_empty() {
                continue;
            }
            let batch: Vec<Watched> = mine.iter().map(|i| agents[*i].clone()).collect();
            for (i, observation) in mine.into_iter().zip(facet.observe(&batch)) {
                observed[i] = Some(observation);
            }
        }
        observed
            .into_iter()
            .map(|observation| observation.unwrap_or_else(unknown))
            .collect()
    }
}

fn unknown() -> Observation {
    Observation {
        process: ProcessLiveness::Unknown,
        work: WorkState::Unknown,
        turn_in_progress: false,
    }
}

/// The last `bytes` of a file.
pub fn read_tail(path: &Path, bytes: u64) -> Option<Vec<u8>> {
    let mut file = std::fs::File::open(path).ok()?;
    let length = file.metadata().ok()?.len();
    file.seek(SeekFrom::Start(length.saturating_sub(bytes)))
        .ok()?;
    let mut tail = Vec::new();
    file.read_to_end(&mut tail).ok()?;
    Some(tail)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::relay::harness::fake::FakeAdapter;
    use crate::relay::harness::{claude, codex, HarnessAdapter};
    use crate::relay::store::SessionKind;
    use std::sync::Arc;

    fn watched(name: &str, kind: SessionKind, alive: bool) -> Watched {
        Watched {
            name: name.into(),
            target: Target::new(kind, name),
            process: None,
            alive,
        }
    }

    #[test]
    fn each_agent_is_observed_by_its_own_harness_in_order() {
        let mut codex_fake = FakeAdapter::new(&codex::DESCRIPTOR, SessionKind::Codex);
        codex_fake.work = WorkState::Working;
        let claude_fake = FakeAdapter::new(&claude::DESCRIPTOR, SessionKind::ClaudeTerminal);
        let adapters: Vec<Arc<dyn HarnessAdapter>> =
            vec![Arc::new(codex_fake), Arc::new(claude_fake)];
        let observer = RegistryObserver(Registry::new(adapters));
        let observed = observer.observe(&[
            watched("c1", SessionKind::ClaudeTerminal, true),
            watched("w1", SessionKind::Codex, true),
            watched("g1", SessionKind::Grok, true),
            watched("w2", SessionKind::Codex, false),
        ]);
        let seen: Vec<(ProcessLiveness, WorkState)> = observed
            .iter()
            .map(|observation| (observation.process, observation.work))
            .collect();
        assert_eq!(
            seen,
            [
                (ProcessLiveness::Running, WorkState::Idle),
                (ProcessLiveness::Running, WorkState::Working),
                // No harness here started it: nothing to say.
                (ProcessLiveness::Unknown, WorkState::Unknown),
                (ProcessLiveness::Exited, WorkState::Working),
            ]
        );
        assert!(observer.observe(&[]).is_empty());
    }

    #[test]
    fn the_tail_of_a_file_is_its_last_bytes() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("log");
        assert_eq!(read_tail(&path, 4), None);
        std::fs::write(&path, "0123456789").unwrap();
        assert_eq!(read_tail(&path, 4), Some(b"6789".to_vec()));
        assert_eq!(read_tail(&path, 64), Some(b"0123456789".to_vec()));
    }
}
