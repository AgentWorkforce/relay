//! A harness adapter for tests: it starts nothing and records what it is
//! asked, standing in for a known harness's descriptor. The registry-level
//! spawner and observer are tested with it.

use super::{Descriptor, HarnessAdapter, Installed, SpawnFacet};
use crate::relay::spawn::intents::Intent;
use crate::relay::spawn::launch::{
    Launch, LaunchError, Launched, SpawnedProcess, Started, TaskHandoff,
};
use crate::relay::spawn::lifecycle::Observation;
use crate::relay::spawn::observe::Watched;
use crate::relay::state::{ProcessLiveness, WorkState};
use crate::relay::store::{SessionKind, Target};
use std::sync::{Mutex, PoisonError};

pub struct FakeAdapter {
    pub descriptor: &'static Descriptor,
    pub installed: Installed,
    /// The sessions it starts, and so owns.
    pub kind: SessionKind,
    /// False makes a harness that is known but does not spawn.
    pub spawns: bool,
    pub launched: Mutex<Vec<Launch>>,
    pub stopped: Mutex<Vec<Target>>,
    /// What each observation answers.
    pub work: WorkState,
}

impl FakeAdapter {
    pub fn new(descriptor: &'static Descriptor, kind: SessionKind) -> FakeAdapter {
        FakeAdapter {
            descriptor,
            installed: Installed::Yes,
            kind,
            spawns: true,
            launched: Mutex::default(),
            stopped: Mutex::default(),
            work: WorkState::Idle,
        }
    }
}

impl HarnessAdapter for FakeAdapter {
    fn descriptor(&self) -> &'static Descriptor {
        self.descriptor
    }

    fn detect(&self) -> Installed {
        self.installed.clone()
    }

    fn spawn(&self) -> Option<&dyn SpawnFacet> {
        self.spawns.then_some(self as &dyn SpawnFacet)
    }
}

impl SpawnFacet for FakeAdapter {
    fn owns(&self, target: &Target) -> bool {
        target.kind == self.kind
    }

    fn launch(&self, launch: &Launch, started: Started) -> Result<Launched, LaunchError> {
        self.launched
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(launch.clone());
        let target = Target::new(self.kind, launch.session_id.clone());
        started(&target, None);
        Ok(Launched {
            target,
            process: None,
            task: TaskHandoff::Confirmed,
        })
    }

    fn find(&self, intent: &Intent) -> Option<(Target, Option<SpawnedProcess>)> {
        Some((Target::new(self.kind, intent.session_id.clone()), None))
    }

    fn alive(&self, target: &Target, _: Option<&SpawnedProcess>) -> bool {
        !self
            .stopped
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .contains(target)
    }

    fn stop(&self, target: &Target, _: Option<&SpawnedProcess>) {
        self.stopped
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(target.clone());
    }

    fn observe(&self, agents: &[Watched]) -> Vec<Observation> {
        agents
            .iter()
            .map(|agent| Observation {
                process: if agent.alive {
                    ProcessLiveness::Running
                } else {
                    ProcessLiveness::Exited
                },
                work: self.work,
                turn_in_progress: false,
            })
            .collect()
    }
}
