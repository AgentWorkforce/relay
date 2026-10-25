//! Harnesses: the agent command lines Agent Relay drives on this computer,
//! one adapter module each behind `HarnessAdapter`.
//!
//! A harness is known by a stable id (`codex`, `claude`), the one Relaycast
//! routes spawns by (`spawn:<id>`) and the settings are keyed by
//! (`spawn_harnesses.<id>`). Each adapter module owns everything particular
//! to its harness: its descriptor (label, full-access wording and default,
//! whether billing may be stated), whether it is installed, and optional
//! facets. Spawning is the one facet so far (`SpawnFacet`): starting an
//! agent headless and watching it, behind the spawn module's `Spawner` and
//! `Observe` seams (`spawn::launch::RegistrySpawner`,
//! `spawn::observe::RegistryObserver`).
//!
//! Adding a harness is one module here and one line in `BUILTINS`; nothing
//! else names harnesses. The apps render the per-harness settings from the
//! descriptors the core publishes (`SpawnStatus::harness_descriptors`).

pub mod claude;
pub mod codex;
pub mod devin;
pub(crate) mod diagnostics;
#[cfg(test)]
pub mod fake;
pub mod grok;
pub mod muse;
pub mod opencode;
pub mod relay_mcp;

use crate::relay::claude::AgentEnvironment;
use crate::relay::contract::transcript::{LocalTranscriptCursor, LocalTranscriptPage};
use crate::relay::inject::InjectOutcome;
use crate::relay::process::{ProcessTable, SystemProcesses};
use crate::relay::spawn::intents::Intent;
use crate::relay::spawn::launch::{
    Launch, LaunchError, Launched, Message, SpawnedProcess, Started,
};
use crate::relay::spawn::lifecycle::Observation;
use crate::relay::spawn::observe::Watched;
use crate::relay::state::{FullAccessDescriptor, HarnessDescriptor};
use crate::relay::store::Target;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Every harness this core knows, in the order the apps list them. Adding
/// a harness adds its module's `BUILTIN` here.
static BUILTINS: &[Builtin] = &[
    codex::BUILTIN,
    claude::BUILTIN,
    opencode::BUILTIN,
    grok::BUILTIN,
    muse::BUILTIN,
    devin::BUILTIN,
];

/// A harness by its stable id, as Relaycast and the settings name it: only
/// ids of known harnesses exist, so a `HarnessId` is always one of
/// `BUILTINS`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct HarnessId(&'static str);

impl HarnessId {
    /// The known harness named `name`.
    pub fn from_name(name: &str) -> Option<HarnessId> {
        BUILTINS
            .iter()
            .map(|builtin| builtin.descriptor.id)
            .find(|id| id.0 == name)
    }

    pub fn name(self) -> &'static str {
        self.0
    }

    /// `spawn:<id>`, the capacity Relaycast routes this harness's spawns by.
    pub fn capability(self) -> String {
        format!("spawn:{}", self.0)
    }

    /// Its descriptor.
    pub fn descriptor(self) -> &'static Descriptor {
        BUILTINS
            .iter()
            .map(|builtin| builtin.descriptor)
            .find(|descriptor| descriptor.id == self)
            .unwrap_or(&UNKNOWN)
    }

    /// The product name, such as `Codex`.
    pub fn label(self) -> &'static str {
        self.descriptor().label
    }
}

/// Never reached: every `HarnessId` is one of `BUILTINS`.
const UNKNOWN: Descriptor = Descriptor {
    id: HarnessId("unknown"),
    label: "Unknown",
    full_access: None,
    billing: false,
};

impl std::fmt::Display for HarnessId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}

impl Serialize for HarnessId {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.0)
    }
}

impl<'de> Deserialize<'de> for HarnessId {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<HarnessId, D::Error> {
        let name = String::deserialize(deserializer)?;
        HarnessId::from_name(&name)
            .ok_or_else(|| serde::de::Error::custom(format!("unknown harness {name}")))
    }
}

/// What a harness is, as the core and the apps show it: fixed facts, the
/// same on every computer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Descriptor {
    pub id: HarnessId,
    /// The product name, such as `Codex`.
    pub label: &'static str,
    /// Its full-access setting (`spawn_harnesses.<id>.full_access`); `None`
    /// when it has none and always runs as it is set up.
    pub full_access: Option<FullAccess>,
    /// Whether how it is paid for may be stated
    /// (`spawn_harnesses.<id>.billing`), as advertised to requesters.
    pub billing: bool,
}

/// A harness's full-access setting.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FullAccess {
    /// What on and off mean for this harness, as Settings says it under
    /// "<label>: full access".
    pub detail: &'static str,
    /// The value until the person chooses.
    pub default: bool,
}

/// Whether a harness can be used on this computer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Installed {
    Yes,
    No,
    /// Installed, but not usable here, with the reason to show.
    Unusable(String),
}

/// What an adapter is built from: the computer it runs on.
#[derive(Clone)]
pub struct HarnessContext {
    pub env: BTreeMap<String, String>,
    pub home: PathBuf,
    pub app_data_dir: PathBuf,
    pub table: Arc<dyn ProcessTable>,
    pub uid: u32,
    /// The environment agent command lines are launched with.
    pub environment: Option<AgentEnvironment>,
    /// `systemd-run`, where a systemd user manager runs this user's
    /// services (`spawn::launch::systemd_run`).
    pub systemd_run: Option<PathBuf>,
}

impl HarnessContext {
    /// This computer, as `env` and `home` describe it.
    pub fn system(
        env: &BTreeMap<String, String>,
        home: &Path,
        app_data_dir: &Path,
        table: Arc<dyn ProcessTable>,
    ) -> HarnessContext {
        let lookup = |key: &str| env.get(key).cloned();
        HarnessContext {
            env: env.clone(),
            home: home.to_path_buf(),
            app_data_dir: app_data_dir.to_path_buf(),
            table,
            uid: crate::relay::peer::current_uid(),
            environment: None,
            systemd_run: crate::relay::spawn::launch::systemd_run(&lookup, &|path| path.exists()),
        }
    }

    /// `system` with this computer's own process table.
    pub fn local(
        env: &BTreeMap<String, String>,
        home: &Path,
        app_data_dir: &Path,
    ) -> HarnessContext {
        HarnessContext::system(
            env,
            home,
            app_data_dir,
            Arc::new(SystemProcesses::default()),
        )
    }

    /// An environment variable, as the context sees it.
    pub fn var(&self, key: &str) -> Option<String> {
        self.env.get(key).cloned()
    }

    /// Where spawned agents write their output, under the app data folder.
    pub fn spawn_logs(&self) -> PathBuf {
        self.app_data_dir
            .join(crate::relay::spawn::launch::SPAWN_LOGS)
    }
}

/// One harness. Facets are optional: a harness without one is known (its
/// descriptor is published) but not offered for it.
pub trait HarnessAdapter: Send + Sync {
    fn descriptor(&self) -> &'static Descriptor;
    /// Whether it is installed and usable here. Files and `PATH` only:
    /// whether it happens to be running must not change what is offered.
    fn detect(&self) -> Installed;
    /// Starting it headless for Agent Relay, and watching what it started.
    fn spawn(&self) -> Option<&dyn SpawnFacet> {
        None
    }
}

/// How long a released agent gets to end before the release fails.
const RELEASE_WAIT: std::time::Duration =
    std::time::Duration::from_secs(if cfg!(test) { 1 } else { 15 });
const RELEASE_POLL: std::time::Duration = std::time::Duration::from_millis(100);

/// Waits up to `RELEASE_WAIT` for `target`'s session, asked to stop, to end:
/// an error when it still runs.
pub(crate) fn await_ended<F: SpawnFacet + ?Sized>(
    facet: &F,
    target: &Target,
    process: Option<&SpawnedProcess>,
) -> Result<(), String> {
    let deadline = std::time::Instant::now() + RELEASE_WAIT;
    while facet.alive(target, process) {
        if std::time::Instant::now() >= deadline {
            return Err("it is still running after being asked to stop".into());
        }
        std::thread::sleep(RELEASE_POLL);
    }
    Ok(())
}

/// Starting agents headless and watching them: the per-harness half of the
/// spawn module's `Spawner` and `Observe`. Every method may block.
pub trait SpawnFacet: Send + Sync {
    /// Whether `target`, a session a spawn saved, is one this harness
    /// started: alive, stop and observe are asked of the facet that owns it.
    fn owns(&self, target: &Target) -> bool;
    /// Starts one agent, for up to about half a minute. The spawner has
    /// checked that `launch.directory` is a folder.
    fn launch(&self, launch: &Launch, started: Started) -> Result<Launched, LaunchError>;
    /// The session and process of a spawn a restart interrupted, from what
    /// its intent recorded.
    fn find(&self, intent: &Intent) -> Option<(Target, Option<SpawnedProcess>)> {
        intent.target.clone().map(|target| (target, intent.process))
    }
    /// Whether the agent's session still runs.
    fn alive(&self, target: &Target, process: Option<&SpawnedProcess>) -> bool;
    /// Ends the agent, idempotently.
    fn stop(&self, target: &Target, process: Option<&SpawnedProcess>);
    /// Ends the agent for a release and confirms it ended: by default, its
    /// session no longer alive within `RELEASE_WAIT` of `stop`.
    fn release(&self, target: &Target, process: Option<&SpawnedProcess>) -> Result<(), String> {
        self.stop(target, process);
        await_ended(self, target, process)
    }
    /// One observation per agent, in order; each is one this facet owns.
    fn observe(&self, agents: &[Watched]) -> Vec<Observation>;
    /// Delivers a later message into an agent it started, when its harness
    /// reaches spawned agents by a route of its own; `None` leaves it to the
    /// session's usual route (Claude's inbox, Codex's app-server).
    fn deliver(&self, _target: &Target, _message: &Message) -> Option<InjectOutcome> {
        None
    }
    /// Whether a message may reach `target`'s agent as its own user turn,
    /// over a channel of its harness (`Message::native`).
    fn native_input(&self, _target: &Target) -> bool {
        false
    }
    /// Takes up `target`'s pending permission requests and writes the
    /// answers due, where its harness's channel carries them: `Some(false)`
    /// once that channel is gone, `None` when it has none. Blocking.
    fn poll_requests(&self, _target: &Target) -> Option<bool> {
        None
    }
    /// Joining and taking over its agents from the apps; `None` when the
    /// apps open its sessions live in its own app instead (Codex).
    fn handover(&self) -> Option<&dyn HandoverFacet> {
        None
    }
}

/// Joining a spawned agent from the apps (following what it says) and
/// taking it over: stopping it headless so the person resumes its session
/// in an interactive client, which then owns the session alone. Every
/// method may block.
pub trait HandoverFacet: Send + Sync {
    /// What the agent has said, from its own output, from `cursor` on.
    fn transcript(
        &self,
        target: &Target,
        cursor: Option<&LocalTranscriptCursor>,
    ) -> Result<LocalTranscriptPage, String>;
    /// The process running `target`'s session now and its folder, found by
    /// the session itself rather than by the process a spawn started: the
    /// headless one before a take over, whichever client the person resumed
    /// it in after.
    fn session(&self, target: &Target) -> Option<RunningSession>;
}

/// A session found running (`HandoverFacet::session`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RunningSession {
    pub process: SpawnedProcess,
    /// The folder it runs in, when known.
    pub directory: Option<PathBuf>,
}

/// A harness in `BUILTINS`: its descriptor and how its adapter is made.
pub struct Builtin {
    pub descriptor: &'static Descriptor,
    pub adapter: fn(&HarnessContext) -> Arc<dyn HarnessAdapter>,
}

/// Every known harness's descriptor, in order.
pub fn descriptors() -> impl Iterator<Item = &'static Descriptor> {
    BUILTINS.iter().map(|builtin| builtin.descriptor)
}

/// Every known harness, in order.
pub fn ids() -> Vec<HarnessId> {
    descriptors().map(|descriptor| descriptor.id).collect()
}

/// Every known harness's descriptor as the apps read it
/// (`SpawnStatus::harness_descriptors`).
pub fn published() -> Vec<HarnessDescriptor> {
    descriptors()
        .map(|descriptor| HarnessDescriptor {
            id: descriptor.id.name().to_string(),
            label: descriptor.label.to_string(),
            full_access: descriptor
                .full_access
                .map(|full_access| FullAccessDescriptor {
                    detail: full_access.detail.to_string(),
                    default_on: full_access.default,
                }),
            billing: descriptor.billing,
        })
        .collect()
}

/// The adapters of a computer, in order.
#[derive(Clone)]
pub struct Registry {
    adapters: Vec<Arc<dyn HarnessAdapter>>,
}

impl Registry {
    /// Every known harness, built for `cx`.
    pub fn builtin(cx: &HarnessContext) -> Registry {
        Registry::new(
            BUILTINS
                .iter()
                .map(|builtin| (builtin.adapter)(cx))
                .collect(),
        )
    }

    pub fn new(adapters: Vec<Arc<dyn HarnessAdapter>>) -> Registry {
        Registry { adapters }
    }

    /// The adapters, in order.
    pub fn adapters(&self) -> impl Iterator<Item = &dyn HarnessAdapter> {
        self.adapters.iter().map(|adapter| adapter.as_ref())
    }

    pub fn get(&self, id: HarnessId) -> Option<&dyn HarnessAdapter> {
        self.adapters()
            .find(|adapter| adapter.descriptor().id == id)
    }

    /// The spawn facets, with their harness, in order.
    pub fn spawners(&self) -> impl Iterator<Item = (HarnessId, &dyn SpawnFacet)> {
        self.adapters()
            .filter_map(|adapter| Some((adapter.descriptor().id, adapter.spawn()?)))
    }

    /// The spawn facet that owns `target`.
    pub fn spawner_of(&self, target: &Target) -> Option<&dyn SpawnFacet> {
        self.spawners()
            .map(|(_, facet)| facet)
            .find(|facet| facet.owns(target))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_the_known_harnesses_in_order() {
        assert_eq!(
            ids(),
            [
                codex::ID,
                claude::ID,
                opencode::ID,
                grok::ID,
                muse::ID,
                devin::ID
            ]
        );
        assert_eq!(HarnessId::from_name("codex"), Some(codex::ID));
        assert_eq!(HarnessId::from_name("claude"), Some(claude::ID));
        assert_eq!(HarnessId::from_name("opencode"), Some(opencode::ID));
        assert_eq!(opencode::ID.capability(), "spawn:opencode");
        assert_eq!(opencode::ID.label(), "OpenCode");
        assert_eq!(HarnessId::from_name("grok"), Some(grok::ID));
        assert_eq!(grok::ID.capability(), "spawn:grok");
        assert_eq!(HarnessId::from_name("Codex"), None);
        assert_eq!(HarnessId::from_name("aider"), None);
        assert_eq!(codex::ID.capability(), "spawn:codex");
        assert_eq!(claude::ID.label(), "Claude");
        assert_eq!(codex::ID.to_string(), "codex");
    }

    #[test]
    fn an_id_serializes_as_its_name_and_only_a_known_one_reads() {
        assert_eq!(serde_json::to_value(codex::ID).unwrap(), "codex");
        assert_eq!(
            serde_json::from_value::<HarnessId>(serde_json::json!("claude")).unwrap(),
            claude::ID
        );
        assert!(serde_json::from_value::<HarnessId>(serde_json::json!("aider")).is_err());
    }

    #[test]
    fn every_descriptor_is_complete_and_its_id_unique() {
        let mut seen = std::collections::HashSet::new();
        for descriptor in descriptors() {
            assert!(seen.insert(descriptor.id), "{} twice", descriptor.id);
            let name = descriptor.id.name();
            assert!(
                !name.is_empty()
                    && name
                        .bytes()
                        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()),
                "{name}: ids are lowercase letters and digits, as settings keys use them"
            );
            assert!(!descriptor.label.is_empty());
            if let Some(full_access) = descriptor.full_access {
                assert!(full_access.detail.ends_with('.'), "{name}");
            }
            assert_eq!(descriptor.id.descriptor(), descriptor);
        }
    }

    #[test]
    fn the_apps_read_each_harness_as_published() {
        // The Mac's SpawnCopyTests decode this same JSON.
        assert_eq!(
            serde_json::to_value(published()).unwrap(),
            serde_json::json!([
                {"id": "codex", "label": "Codex", "billing": true,
                 "full_access": {"detail": "Full access removes the sandbox for spawned Codex. Approval requests can be answered remotely; off keeps Codex in its workspace folder.", "default_on": true}},
                {"id": "claude", "label": "Claude", "billing": true,
                 "full_access": {"detail": "Spawned Claude runs with --dangerously-skip-permissions. Off lets it edit files; anything else that would ask can be answered remotely.", "default_on": true}},
                {"id": "opencode", "label": "OpenCode", "billing": true,
                 "full_access": {"detail": "Spawned OpenCode runs with every permission set to allow. Off lets it read and edit files in its folder and refuses everything else, shell commands included.", "default_on": true}},
                {"id": "grok", "label": "Grok", "billing": true,
                 "full_access": {"detail": "Spawned Grok runs with --always-approve and without its sandbox. Off runs it in Grok's workspace sandbox, which keeps it to its workspace folder.", "default_on": true}},
                {"id": "muse", "label": "Muse", "billing": true,
                 "full_access": {"detail": "Spawned Muse runs with --yolo. Off keeps Muse's sandbox and refuses actions that would ask for approval.", "default_on": false}},
                {"id": "devin", "label": "Devin", "billing": true,
                 "full_access": {"detail": "Spawned Devin uses dangerous permission mode. Off uses accept-edits and permits only the private Agent Relay send tool; other approval requests are refused.", "default_on": false}},
            ])
        );
    }

    #[test]
    fn the_registry_finds_each_adapter_and_the_owner_of_a_session() {
        let home = tempfile::tempdir().unwrap();
        let cx = HarnessContext::system(
            &BTreeMap::new(),
            home.path(),
            home.path(),
            Arc::new(crate::relay::process::FakeProcesses::default()),
        );
        let registry = Registry::builtin(&cx);
        for id in ids() {
            let adapter = registry.get(id).unwrap();
            assert_eq!(adapter.descriptor().id, id);
            assert!(adapter.spawn().is_some(), "{id} spawns");
        }
        use crate::relay::store::SessionKind;
        let owner = |kind| {
            let target = Target::new(kind, "s1");
            registry
                .spawners()
                .find(|(_, facet)| facet.owns(&target))
                .map(|(id, _)| id)
        };
        assert_eq!(owner(SessionKind::Codex), Some(codex::ID));
        assert_eq!(owner(SessionKind::ClaudeTerminal), Some(claude::ID));
        assert_eq!(owner(SessionKind::OpenCode), Some(opencode::ID));
        assert_eq!(owner(SessionKind::OpenCodeOpen), None);
        assert_eq!(owner(SessionKind::Grok), Some(grok::ID));
        assert_eq!(owner(SessionKind::GrokOpen), None);
        assert_eq!(owner(SessionKind::MuseOpen), Some(muse::ID));
        assert!(registry
            .spawner_of(&Target::new(SessionKind::Devin, "d"))
            .is_none());
    }
}
