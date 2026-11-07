//! Grok CLI (xAI's Grok Build). A spawned Grok is a session on a Grok
//! leader of its own: `grok agent leader` on a private socket, started
//! detached (on Linux under a systemd user manager, in a transient scope of
//! its own), so it outlives a core restart. A short-lived ACP client opens
//! the session on it and gives it its first task (`leader`). Later messages
//! reach it the way the managed Grok route's do: an ACP client loads the
//! session and prompts it, behind a delivery journal, once the leader is
//! proven by the marker it was started with (`existing_session::grok`).
//!
//! Full access is Grok's always-approve mode, as nobody answers a spawned
//! agent's prompts; off also starts the leader in Grok's `workspace`
//! sandbox, which lets it write only in its workspace folder, `~/.grok` and
//! temporary folders. Like Claude and Codex it loads the person's own Grok
//! configuration, MCP servers included.
//!
//! Watching it: its leader, by pid and start time, and the turn events Grok
//! writes to the session's `events.jsonl` (`record`).

mod credentials;
mod diagnostics;
mod leader;
mod record;

pub use leader::{LeaderRuntime, LeaderStart, Opened, SessionOpen, SystemLeaders};
pub(crate) use record::read as read_spawned_record;
pub use record::SpawnedGrok;

use super::{
    Builtin, Descriptor, FullAccess, HarnessAdapter, HarnessContext, HarnessId, Installed,
    SpawnFacet,
};
use crate::relay::claude::AgentEnvironment;
use crate::relay::existing_session::grok::{
    credential_reference, AcpTransport, Authority, GrokAdapter as GrokRoute, SystemAcpTransport,
    SystemAuthority, MANAGED_MARKER,
};
use crate::relay::existing_session::platform::{self, FileTypeExt, MetadataExt};
use crate::relay::existing_session::{
    self, Binding, Coordinator, Gate, Journal, Outcome, Provider, Request, Transport,
};
use crate::relay::grok::GrokConfig;
use crate::relay::inject::InjectOutcome;
use crate::relay::managed_sessions::{grok_socket_path, private_short_runtime_dir};
use crate::relay::process::ProcessTable;
use crate::relay::spawn::intents::Intent;
use crate::relay::spawn::launch::{
    scope_unit, start_scoped_or_plain, stop_process, Launch, LaunchError, Launched, Message,
    SpawnedProcess, Started, TaskHandoff,
};
use crate::relay::spawn::lifecycle::{self, Observation};
use crate::relay::spawn::observe::{read_tail, Watched};
use crate::relay::state::{ProcessLiveness, WorkState};
use crate::relay::store::{random_hex, SessionKind, Target};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

pub const ID: HarnessId = HarnessId("grok");

pub const DESCRIPTOR: Descriptor = Descriptor {
    id: ID,
    label: "Grok",
    full_access: Some(FullAccess {
        detail: "Spawned Grok runs with --always-approve and without its sandbox. Off runs it in Grok's workspace sandbox, which keeps it to its workspace folder.",
        default: true,
    }),
    billing: true,
};

pub const BUILTIN: Builtin = Builtin {
    descriptor: &DESCRIPTOR,
    adapter,
};

fn adapter(cx: &HarnessContext) -> Arc<dyn HarnessAdapter> {
    Arc::new(GrokAdapter::new(cx))
}

/// The oldest Grok spawned agents run on: the first whose leader, ACP
/// session events and receipts Agent Relay's Grok route was proven against.
pub const MIN_VERSION: (u32, u32, u32) = (1, 0, 46);

/// How long a new leader gets to listen on its socket.
const LEADER_TIMEOUT: Duration = Duration::from_secs(20);
/// How long each ACP phase gets; Grok 1.0.46 can take most of twenty
/// seconds to initialize, leaving the first task its own receipt budget.
const OPEN_TIMEOUT: Duration = Duration::from_secs(30);
/// How long one later message gets.
const DELIVERY_TIMEOUT: Duration = Duration::from_secs(30);
/// How much of a session's events is read.
const EVENTS_TAIL: u64 = 64 * 1024;
/// The route fields a spawned Grok's binding names in place of a Relaycast
/// workspace and owner: its leader is proven by its marker, and only the
/// agent's spawn registration reaches it.
const SPAWN_ROUTE: &str = "agent-relay-spawn";

/// Why Grok is installed but cannot be spawned here.
pub fn too_old(version: (u32, u32, u32)) -> String {
    let (major, minor, patch) = version;
    let (min_major, min_minor, min_patch) = MIN_VERSION;
    format!(
        "Grok here is version {major}.{minor}.{patch}, older than {min_major}.{min_minor}.{min_patch}, the first that spawned Grok agents run on. Update it with `grok update`, then try again."
    )
}

/// The version of the Grok at `executable`, from the file Grok's installer
/// names for it (`~/.grok/bin/grok` links to
/// `~/.grok/downloads/grok-1.0.46-macos-aarch64`); `None` for a Grok
/// installed some other way. Files only: Grok is never run to ask.
pub fn version_of(executable: &Path) -> Option<(u32, u32, u32)> {
    let resolved = std::fs::canonicalize(executable).ok()?;
    let name = resolved.file_name()?.to_str()?;
    let version = name.strip_prefix("grok-")?.split('-').next()?;
    let mut parts = version.split('.').map(|part| part.parse::<u32>().ok());
    let found = (parts.next()??, parts.next()??, parts.next()??);
    parts.next().is_none().then_some(found)
}

/// The `grok` this computer runs: `bin/grok` in Grok's home, where Grok
/// installs itself, else the first on `PATH`.
pub fn find_executable(path: Option<&str>, grok_home: &Path) -> Option<PathBuf> {
    std::iter::once(grok_home.join("bin/grok"))
        .chain(
            path.unwrap_or_default()
                .split(':')
                .filter(|dir| dir.starts_with('/'))
                .map(|dir| Path::new(dir).join("grok")),
        )
        .find(|candidate| {
            std::fs::metadata(candidate).is_ok_and(|metadata| {
                metadata.is_file()
                    && platform::PermissionsExt::mode(&metadata.permissions()) & 0o111 != 0
            })
        })
}

/// Grok on this computer.
pub struct GrokAdapter {
    pub executable: Option<PathBuf>,
    pub grok: GrokConfig,
    pub table: Arc<dyn ProcessTable>,
    pub uid: u32,
    pub environment: Option<AgentEnvironment>,
    /// The spawned leaders' records, output and delivery journal:
    /// `<app data>/spawned-agents/grok`, private to this user.
    pub folder: PathBuf,
    pub systemd_run: Option<PathBuf>,
    pub leaders: Arc<dyn LeaderRuntime>,
    pub authority: Arc<dyn Authority>,
    pub transport: Arc<dyn AcpTransport>,
}

impl GrokAdapter {
    pub fn new(cx: &HarnessContext) -> GrokAdapter {
        let grok = GrokConfig::from_env(&|key| cx.var(key), &cx.home);
        let authority: Arc<dyn Authority> = Arc::new(SystemAuthority::new(cx.table.clone()));
        GrokAdapter {
            executable: find_executable(cx.var("PATH").as_deref(), &grok.home),
            grok,
            table: cx.table.clone(),
            uid: cx.uid,
            environment: cx.environment.clone(),
            folder: cx.spawn_logs().join("grok"),
            systemd_run: cx.systemd_run.clone(),
            leaders: Arc::new(SystemLeaders),
            transport: Arc::new(SystemAcpTransport::new(authority.clone())),
            authority,
        }
    }

    /// The executable to spawn with, or why there is none.
    fn usable(&self) -> Result<PathBuf, LaunchError> {
        // Its leader is reached over a Unix socket, which Windows lacks.
        if let Some(reason) = platform::unsupported(DESCRIPTOR.label) {
            return Err(LaunchError::Unavailable(reason));
        }
        let executable = self.executable.clone().ok_or_else(|| {
            LaunchError::Unavailable("Grok is not installed on this computer".into())
        })?;
        match version_of(&executable) {
            Some(version) if version < MIN_VERSION => {
                Err(LaunchError::Unavailable(too_old(version)))
            }
            _ => std::fs::canonicalize(&executable).map_err(|error| {
                LaunchError::Failed(format!("Grok's executable cannot be read: {error}"))
            }),
        }
    }

    /// The leader's environment: the agents' own, its marker, and its
    /// sandbox.
    fn leader_environment(&self, full_access: bool, marker: &str) -> BTreeMap<String, String> {
        let mut environment: BTreeMap<String, String> = std::env::vars().collect();
        if let Some(agent_environment) = &self.environment {
            environment = agent_environment("grok", environment);
        }
        environment.insert(MANAGED_MARKER.into(), marker.into());
        if full_access {
            environment.remove("GROK_SANDBOX");
        } else {
            environment.insert("GROK_SANDBOX".into(), "workspace".into());
        }
        environment
    }

    /// Ready once the leader listens on its socket: its process, and the
    /// socket's device and inode.
    fn wait_leader(
        &self,
        pid: i32,
        socket: &Path,
        log: &Path,
    ) -> Result<(SpawnedProcess, u64, u64), String> {
        let deadline = Instant::now() + LEADER_TIMEOUT;
        let mut seen = None;
        loop {
            let process = self
                .table
                .process(pid)
                .filter(|process| process.uid == self.uid);
            seen = seen.or(process.map(|process| process.start));
            let listening = std::fs::symlink_metadata(socket)
                .ok()
                .filter(|metadata| metadata.file_type().is_socket() && metadata.uid() == self.uid);
            if let (Some(process), Some(socket)) = (process, listening) {
                return Ok((SpawnedProcess::of(process), socket.dev(), socket.ino()));
            }
            if self.table.process_gone(pid) || Instant::now() >= deadline {
                stop_process(self.table.as_ref(), pid, seen);
                return Err(format!(
                    "Grok's leader did not start; see {}",
                    log.display()
                ));
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    /// The leader of an agent: the process its spawn recorded, else the one
    /// its record names.
    fn leader_of(
        &self,
        target: &Target,
        process: Option<&SpawnedProcess>,
    ) -> Option<SpawnedProcess> {
        process
            .copied()
            .or_else(|| record::read(&self.folder, &target.id).map(|record| record.leader()))
    }

    fn observe_one(&self, agent: &Watched) -> Observation {
        let record = record::read(&self.folder, &agent.target.id);
        let work = record
            .as_ref()
            .and_then(|record| read_tail(&record.events(), EVENTS_TAIL))
            .and_then(|tail| record::work_state(&tail));
        if !agent.alive {
            let exited = self
                .leader_of(&agent.target, agent.process.as_ref())
                .is_some_and(|leader| {
                    self.table.process_gone(leader.pid)
                        || self.table.zombie(leader.pid)
                        || self
                            .table
                            .process(leader.pid)
                            .is_some_and(|now| !leader.is(Some(now)))
                });
            if !exited {
                return Observation {
                    process: ProcessLiveness::Unknown,
                    work: WorkState::Unknown,
                    turn_in_progress: false,
                };
            }
            // Ended: cleanly after a turn, or with one running.
            let turn_in_progress = work != Some(WorkState::Idle);
            return Observation {
                process: ProcessLiveness::Exited,
                work: lifecycle::ended_work(turn_in_progress),
                turn_in_progress,
            };
        }
        if record.is_none() {
            return Observation {
                process: ProcessLiveness::Unknown,
                work: WorkState::Unknown,
                turn_in_progress: false,
            };
        }
        let work = work.unwrap_or(WorkState::Unknown);
        Observation {
            process: ProcessLiveness::Running,
            work,
            turn_in_progress: work == WorkState::Working,
        }
    }

    /// A message into the session through its proven leader, behind the
    /// journal: a receipt is never sent twice, and a send that may have
    /// reached Grok stays in doubt.
    fn deliver_to(&self, record: &SpawnedGrok, message: &Message) -> InjectOutcome {
        let binding = &record.binding;
        let route = Arc::new(GrokRoute::new(
            binding.workspace_id.clone(),
            binding.owner_id.clone(),
            binding.owner_uid,
            self.authority.clone(),
            self.transport.clone(),
        ));
        let Ok(journal) = Journal::new(self.folder.join("journal")) else {
            return InjectOutcome::Retry(
                "The spawned Grok delivery journal is unavailable.".into(),
            );
        };
        let Some(coordinator) =
            Coordinator::new(Gate::enabled([Provider::Grok]), journal, vec![route])
        else {
            return InjectOutcome::Refused("The spawned Grok route is unavailable.".into());
        };
        let request = Request {
            binding,
            delivery_id: message.delivery_id,
            message_id: message.message_id,
            text: message.text,
            timeout: DELIVERY_TIMEOUT,
        };
        match coordinator.inject(&request) {
            Outcome::Delivered { .. } => InjectOutcome::Delivered,
            Outcome::Retry(_) => {
                InjectOutcome::Retry("The spawned Grok leader is unavailable.".into())
            }
            Outcome::Waiting(_) => {
                InjectOutcome::Waiting("The spawned Grok session is not ready.".into())
            }
            Outcome::InDoubt(_) => InjectOutcome::InDoubt(
                "Grok may have accepted this message; operator reconciliation is required.".into(),
            ),
            Outcome::Refused(_) => {
                InjectOutcome::Refused("The spawned Grok leader was refused.".into())
            }
        }
    }
}

impl HarnessAdapter for GrokAdapter {
    fn descriptor(&self) -> &'static Descriptor {
        &DESCRIPTOR
    }

    fn detect(&self) -> Installed {
        if let Some(reason) = platform::unsupported(DESCRIPTOR.label) {
            return Installed::Unusable(reason);
        }
        match self.executable.as_deref().map(version_of) {
            None => Installed::No,
            Some(Some(version)) if version < MIN_VERSION => Installed::Unusable(too_old(version)),
            Some(_) => {
                let environment = self.leader_environment(true, "");
                let home = environment
                    .get("GROK_HOME")
                    .map(PathBuf::from)
                    .filter(|path| path.is_absolute())
                    .unwrap_or_else(|| self.grok.home.clone());
                if credentials::missing(&home, &environment) {
                    Installed::Unusable(credentials::MISSING.into())
                } else {
                    Installed::Yes
                }
            }
        }
    }

    fn spawn(&self) -> Option<&dyn SpawnFacet> {
        Some(self)
    }
}

impl SpawnFacet for GrokAdapter {
    fn owns(&self, target: &Target) -> bool {
        target.kind == SessionKind::Grok
    }

    fn launch(&self, launch: &Launch, started: Started) -> Result<Launched, LaunchError> {
        let executable = self.usable()?;
        let failed = |what: &str, error: &dyn std::fmt::Display| {
            LaunchError::Failed(format!("{what}: {error}"))
        };
        let directory = std::fs::canonicalize(&launch.directory)
            .map_err(|error| failed("could not read the folder", &error))?;
        record::private_folder(&self.folder)
            .map_err(|error| failed("could not make the spawn folder", &error))?;
        // Under `/tmp`, which Grok's workspace sandbox still lets the leader
        // write, in this user's private folder there.
        let socket = private_short_runtime_dir()
            .and_then(|folder| grok_socket_path(&folder))
            .map_err(|()| failed("could not place Grok's leader socket", &"no private folder"))?;
        let marker = random_hex(64);
        let environment = self.leader_environment(launch.full_access, &marker);
        let log = self.folder.join(format!("{}.log", launch.session_id));
        let request = LeaderStart {
            executable: &executable,
            socket: &socket,
            directory: &directory,
            environment: &environment,
            log: &log,
        };
        let launch_ms = chrono::Utc::now().timestamp_millis();
        let start = |scope: Option<(&Path, &str)>| self.leaders.start(&request, scope);
        let pid = match &self.systemd_run {
            Some(systemd_run) => {
                start_scoped_or_plain(systemd_run, &scope_unit(&launch.session_id), start)
            }
            None => start(None),
        }
        .map_err(|error| {
            let args = leader::leader_arguments(&socket)
                .iter()
                .map(|arg| arg.to_string_lossy().into_owned())
                .collect::<Vec<_>>();
            LaunchError::Failed(super::diagnostics::launch_failure(
                &format!("Grok could not start its leader: {error}"),
                &executable,
                &args,
                &log,
            ))
        })?;
        let diagnostic_home = environment
            .get("GROK_HOME")
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
            .unwrap_or_else(|| self.grok.home.clone());
        let reason = |fallback: String| {
            let reason =
                diagnostics::startup_error(&diagnostic_home, pid, launch_ms).unwrap_or(fallback);
            let args = leader::leader_arguments(&socket)
                .iter()
                .map(|arg| arg.to_string_lossy().into_owned())
                .collect::<Vec<_>>();
            super::diagnostics::launch_failure(&reason, &executable, &args, &log)
        };
        // Until the session exists, the leader is known under the spawn's
        // own session id, so a restart in between ends it (`find`). `sh`
        // printed its pid after forking it, so a leader not seen now has
        // already exited or is someone else's: recorded without it, a
        // restart could neither reclaim nor end it.
        let Some(seen) = self
            .table
            .process(pid)
            .filter(|process| process.uid == self.uid)
        else {
            return Err(LaunchError::Unavailable(reason(format!(
                "Grok's leader did not start; see {}",
                log.display()
            ))));
        };
        let pending = Target::new(SessionKind::Grok, launch.session_id.clone());
        started(&pending, Some(SpawnedProcess::of(seen)));
        let (leader, socket_device, socket_inode) = self
            .wait_leader(pid, &socket, &log)
            .map_err(|error| LaunchError::Unavailable(reason(error)))?;
        let grok_home = environment
            .get("GROK_HOME")
            .map(|home| PathBuf::from(home.trim()))
            .filter(|home| home.is_absolute())
            .unwrap_or_else(|| self.grok.home.clone());
        let accept = |opened: &Opened| {
            let binding = Binding {
                provider: Provider::Grok,
                transport: Transport::Acp,
                workspace_id: SPAWN_ROUTE.into(),
                session_id: opened.session_id.clone(),
                endpoint_id: String::new(),
                owner_id: SPAWN_ROUTE.into(),
                credential_reference: String::new(),
                owner_uid: self.uid,
                auth_id: String::new(),
                protocol_id: String::new(),
                cwd: directory.clone(),
                model_id: opened.model_id.clone(),
                agent_version: opened.agent_version.clone(),
                executable: executable.clone(),
                leader_pid: leader.pid,
                leader_start: leader.start,
                socket_path: socket.clone(),
                socket_device,
                socket_inode,
            };
            let binding = Binding {
                credential_reference: credential_reference(&binding, &marker),
                ..binding
            };
            let record = SpawnedGrok {
                binding,
                grok_home: grok_home.clone(),
            };
            let accepted = self.authority.verify(&record.binding)
                && existing_session::printable(&record.binding.session_id, 256)
                && record::write(&self.folder, &record).is_ok();
            if accepted {
                started(
                    &Target::new(SessionKind::Grok, opened.session_id.clone()),
                    Some(leader),
                );
            }
            accepted
        };
        let open = SessionOpen {
            executable: &executable,
            socket: &socket,
            directory: &directory,
            text: &launch.text,
            timeout: OPEN_TIMEOUT,
        };
        let refused = |failure: String| {
            // Capture evidence before cleanup can replace the original exit.
            let diagnostic = reason(failure);
            stop_process(self.table.as_ref(), leader.pid, Some(leader.start));
            LaunchError::Unavailable(diagnostic)
        };
        let (opened, outcome) = self
            .leaders
            .open(&open, &accept)
            .map_err(|error| refused(format!("Grok did not open a session: {error}")))?;
        let task = match outcome {
            Outcome::Delivered { .. } => TaskHandoff::Confirmed,
            Outcome::InDoubt(_) => TaskHandoff::Unconfirmed("in_doubt"),
            Outcome::Retry(_) | Outcome::Waiting(_) | Outcome::Refused(_) => {
                record::remove(&self.folder, &opened.session_id);
                return Err(refused("Grok refused the first task".into()));
            }
        };
        Ok(Launched {
            target: Target::new(SessionKind::Grok, opened.session_id),
            process: Some(leader),
            task,
        })
    }

    /// By the session its record names. A spawn interrupted before its
    /// session existed left only its leader, known under the spawn's own
    /// session id: nothing can reach that leader, so it is ended here.
    fn find(&self, intent: &Intent) -> Option<(Target, Option<SpawnedProcess>)> {
        let target = intent.target.clone()?;
        if target.id == intent.session_id {
            if let Some(process) = intent.process {
                stop_process(self.table.as_ref(), process.pid, Some(process.start));
            }
            return None;
        }
        let record = record::read(&self.folder, &target.id)?;
        let process = intent.process.unwrap_or_else(|| record.leader());
        Some((target, Some(process)))
    }

    fn alive(&self, target: &Target, process: Option<&SpawnedProcess>) -> bool {
        self.leader_of(target, process).is_some_and(|leader| {
            leader.is(self.table.process(leader.pid)) && !self.table.zombie(leader.pid)
        })
    }

    fn stop(&self, target: &Target, process: Option<&SpawnedProcess>) {
        if let Some(leader) = self.leader_of(target, process) {
            stop_process(self.table.as_ref(), leader.pid, Some(leader.start));
        }
    }

    fn observe(&self, agents: &[Watched]) -> Vec<Observation> {
        agents.iter().map(|agent| self.observe_one(agent)).collect()
    }

    fn deliver(&self, target: &Target, message: &Message) -> Option<InjectOutcome> {
        Some(match record::read(&self.folder, &target.id) {
            Some(record) => self.deliver_to(&record, message),
            None => {
                InjectOutcome::Refused("No spawned Grok leader is recorded for this agent.".into())
            }
        })
    }
}

// Its fixtures are shell scripts and Unix sockets.
#[cfg(test)]
#[cfg(unix)]
mod tests;

#[cfg(test)]
#[cfg(windows)]
mod windows_tests {
    use super::*;

    #[test]
    fn grok_is_not_available_on_windows() {
        let cx = HarnessContext::local(
            &BTreeMap::new(),
            &std::env::temp_dir(),
            &std::env::temp_dir(),
        );
        let adapter = GrokAdapter::new(&cx);
        assert_eq!(
            adapter.detect(),
            Installed::Unusable("Grok is not available on Windows.".into())
        );
        assert!(matches!(
            adapter.usable(),
            Err(LaunchError::Unavailable(reason)) if reason == "Grok is not available on Windows."
        ));
    }
}
