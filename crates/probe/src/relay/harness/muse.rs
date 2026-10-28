//! Muse's interactive runtime, owned by a detached Relay PTY host. Muse's
//! one-shot `exec` exits after its answer and `serve` does not publish a
//! peer-message endpoint. The TUI publishes a message-capable session that
//! the existing Muse courier route can reach, including while it is idle.

#[cfg(unix)]
pub mod host;
/// The detached PTY host is built on Unix signals and process groups. On
/// Windows, where Muse is not available, `relay muse-spawn-host` refuses
/// with the sentence the adapter gives.
#[cfg(windows)]
pub mod host {
    use std::path::Path;

    pub fn run(_executable: &Path, _log: &Path, _arguments: &[String]) -> anyhow::Result<()> {
        anyhow::bail!(crate::relay::existing_session::platform::unavailable(
            super::DESCRIPTOR.label
        ))
    }
}
mod hosts;
mod mcp;

use super::{
    Builtin, Descriptor, FullAccess, HarnessAdapter, HarnessContext, HarnessId, Installed,
    SpawnFacet,
};
use crate::relay::muse::{self as runtime, MuseConfig, RegistrySession};
use crate::relay::spawn::intents::Intent;
use crate::relay::spawn::launch::{
    scope_unit, start_scoped_or_plain, stop_process, Launch, LaunchError, Launched, SpawnedProcess,
    Started, TaskHandoff,
};
use crate::relay::spawn::lifecycle::Observation;
use crate::relay::spawn::observe::{read_tail, Watched};
use crate::relay::state::{ProcessLiveness, WorkState};
use crate::relay::store::{is_uuid, SessionKind, Target};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

pub const ID: HarnessId = HarnessId("muse");
pub const DESCRIPTOR: Descriptor = Descriptor {
    id: ID,
    label: "Muse",
    full_access: Some(FullAccess {
        detail: "Spawned Muse runs with --yolo. Off keeps Muse's sandbox and refuses actions that would ask for approval.",
        default: false,
    }),
    billing: true,
};
pub const BUILTIN: Builtin = Builtin {
    descriptor: &DESCRIPTOR,
    adapter: |cx| Arc::new(MuseAdapter::new(cx)),
};
/// A spawn's preallocated session id, inherited by only its own host and Muse.
pub const SPAWN_MARKER: &str = "AGENT_RELAY_MUSE_SPAWN";
pub const SPAWN_ACCESS: &str = "AGENT_RELAY_MUSE_SPAWN_ACCESS";
// A cold Muse start can initialize its session after twenty seconds.
// Keep launch and restart recovery bounded while allowing that startup work.
const READY_TIMEOUT: Duration = Duration::from_secs(60);
const LOG_TAIL: u64 = 256 * 1024;

pub struct MuseAdapter {
    pub cx: HarnessContext,
    pub config: MuseConfig,
    pub executable: Option<PathBuf>,
    pub ready_timeout: Duration,
}

impl MuseAdapter {
    pub fn new(cx: &HarnessContext) -> Self {
        Self {
            cx: cx.clone(),
            ready_timeout: READY_TIMEOUT,
            config: MuseConfig::from_env(&|key| cx.var(key), &cx.home),
            executable: runtime::launcher(&cx.home, cx.env.get("PATH").map(std::ffi::OsStr::new)),
        }
    }

    fn session(&self, marker: &str) -> Option<RegistrySession> {
        runtime::active_sessions(&self.config, self.cx.table.as_ref(), self.cx.uid)
            .into_iter()
            .find(|session| {
                session.message_capable
                    && self
                        .cx
                        .table
                        .environment_var(session.pid, SPAWN_MARKER)
                        .as_deref()
                        == Some(marker)
            })
    }

    fn owned_process(&self, target: &Target, process: &SpawnedProcess) -> bool {
        process.is(self.cx.table.process(process.pid))
            && self
                .cx
                .table
                .process(process.pid)
                .is_some_and(|info| info.uid == self.cx.uid)
            && runtime::is_muse_process(self.cx.table.as_ref(), process.pid)
            && self
                .cx
                .table
                .environment_var(process.pid, SPAWN_MARKER)
                .is_some_and(|marker| is_uuid(&marker))
            && (hosts::bound(
                &self.cx.spawn_logs(),
                target,
                process,
                self.cx.table.as_ref(),
            )
            .is_some()
                || runtime::active_sessions(&self.config, self.cx.table.as_ref(), self.cx.uid)
                    .into_iter()
                    .any(|session| session.session_id == target.id && session.pid == process.pid))
    }

    fn work(&self, id: &str) -> Option<WorkState> {
        let path = runtime::session_log(&self.config, id)?;
        log_state(&read_tail(&path, LOG_TAIL)?)
    }

    fn observe_one(&self, agent: &Watched) -> Observation {
        let Some(process) = agent.process else {
            return unknown_observation();
        };
        let gone = self.cx.table.process_gone(process.pid)
            || self.cx.table.zombie(process.pid)
            || self
                .cx
                .table
                .process(process.pid)
                .is_some_and(|p| p.start != process.start);
        if !agent.alive && !gone {
            return unknown_observation();
        }
        let work = self.work(&agent.target.id).unwrap_or(WorkState::Unknown);
        let turn_in_progress = work == WorkState::Working;
        Observation {
            process: if agent.alive {
                ProcessLiveness::Running
            } else {
                ProcessLiveness::Exited
            },
            work: if agent.alive {
                work
            } else if work == WorkState::Idle {
                WorkState::Completed
            } else {
                WorkState::Unknown
            },
            turn_in_progress,
        }
    }
}

impl HarnessAdapter for MuseAdapter {
    fn descriptor(&self) -> &'static Descriptor {
        &DESCRIPTOR
    }
    fn detect(&self) -> Installed {
        // Its host, courier and session registry are Unix sockets and
        // process groups: on Windows, Muse is reported unavailable.
        if let Some(reason) =
            crate::relay::existing_session::platform::unsupported(DESCRIPTOR.label)
        {
            return Installed::Unusable(reason);
        }
        if self.executable.is_none() {
            Installed::No
        } else if self.cx.var("AGENT_RELAY_ENABLE_MUSE_OPEN").as_deref() == Some("0") {
            Installed::Unusable("Muse relay messaging is disabled on this computer. Enable Muse delivery before spawning it.".into())
        } else {
            Installed::Yes
        }
    }
    fn spawn(&self) -> Option<&dyn SpawnFacet> {
        Some(self)
    }
}

impl MuseAdapter {
    fn launch_native(&self, launch: &Launch, started: Started) -> Result<Launched, LaunchError> {
        if let Installed::Unusable(reason) = self.detect() {
            return Err(LaunchError::Unavailable(reason));
        }
        let executable = self.executable.as_ref().ok_or_else(|| {
            LaunchError::Unavailable("Muse is not installed on this computer".into())
        })?;
        let helper = std::env::current_exe().map_err(|_| {
            LaunchError::Failed("Agent Relay could not find its Muse host helper".into())
        })?;
        std::fs::create_dir_all(self.cx.spawn_logs())
            .map_err(|_| LaunchError::Failed("Could not make the Muse spawn log folder".into()))?;
        let log = self
            .cx
            .spawn_logs()
            .join(format!("{}.muse.log", launch.session_id));
        let mut environment = self.cx.env.clone();
        if let Some(transform) = &self.cx.environment {
            environment = transform("muse", environment);
        }
        environment.insert(SPAWN_MARKER.into(), launch.session_id.clone());
        environment.insert(
            SPAWN_ACCESS.into(),
            if launch.full_access {
                "full"
            } else {
                "workspace"
            }
            .into(),
        );
        environment.insert("TERM".into(), "xterm-256color".into());
        environment.insert(
            "PATH".into(),
            runtime::courier_path(
                executable,
                environment.get("PATH").map(std::ffi::OsStr::new),
            )
            .to_string_lossy()
            .into_owned(),
        );
        environment.remove(runtime::COURIER_MARKER);
        environment.remove("RELAY_ATTEST_SESSION_ID");
        environment.remove("MUSE_TOOL_USE_ID");
        if let Some(data_home) = self.config.data_home() {
            environment.insert(
                "XDG_DATA_HOME".into(),
                data_home.to_string_lossy().into_owned(),
            );
        }
        let mut args = vec![
            "relay".into(),
            "muse-spawn-host".into(),
            "--executable".into(),
            executable.to_string_lossy().into_owned(),
            "--log".into(),
            log.to_string_lossy().into_owned(),
            "--".into(),
        ];
        args.extend(mcp::arguments(
            &launch.text,
            launch.full_access,
            &helper,
            &launch.session_id,
            self.cx
                .app_data_dir
                .file_name()
                .is_some_and(|name| name.to_string_lossy().ends_with(".dev")),
        ));
        let start = |scope: Option<(&Path, &str)>| {
            start_host(
                scope,
                &helper,
                &args,
                &log.with_extension("host.log"),
                &launch.directory,
                &environment,
            )
        };
        let host_pid = match &self.cx.systemd_run {
            Some(systemd_run) => {
                start_scoped_or_plain(systemd_run, &scope_unit(&launch.session_id), start)
            }
            None => start(None),
        }
        .map_err(|_| LaunchError::Failed("Muse's detached host could not start".into()))?;
        let host_process = self.cx.table.process(host_pid).map(SpawnedProcess::of);
        let placeholder = Target::new(SessionKind::MuseOpen, launch.session_id.clone());
        started(&placeholder, host_process);
        let deadline = Instant::now() + self.ready_timeout;
        loop {
            if let Some(session) = self.session(&launch.session_id) {
                let target = Target::new(SessionKind::MuseOpen, session.session_id);
                let process = self.cx.table.process(session.pid).map(SpawnedProcess::of);
                if !hosts::bind(
                    &self.cx.spawn_logs(),
                    &launch.session_id,
                    &target,
                    process,
                    self.cx.table.as_ref(),
                ) {
                    if let Some(host) = host_process {
                        stop_process(self.cx.table.as_ref(), host.pid, Some(host.start));
                    }
                    return Err(LaunchError::Failed(
                        "Muse's session ownership could not be saved".into(),
                    ));
                }
                started(&target, process);
                return Ok(Launched {
                    target,
                    process,
                    task: TaskHandoff::Unconfirmed("input"),
                });
            }
            if self.cx.table.process_gone(host_pid)
                || self.cx.table.zombie(host_pid)
                || Instant::now() >= deadline
            {
                // Closing the exact host's master PTY hangs up its child.
                if let Some(host) = host_process {
                    stop_process(self.cx.table.as_ref(), host.pid, Some(host.start));
                }
                return Err(LaunchError::Failed(format!(
                    "Muse did not publish a message-capable session; see {}",
                    log.display()
                )));
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }
}

impl SpawnFacet for MuseAdapter {
    fn owns(&self, target: &Target) -> bool {
        target.kind == SessionKind::MuseOpen
    }

    fn launch(&self, launch: &Launch, started: Started) -> Result<Launched, LaunchError> {
        // Refused with the sentence alone: there is no launch to diagnose.
        if let Some(reason) =
            crate::relay::existing_session::platform::unsupported(DESCRIPTOR.label)
        {
            return Err(LaunchError::Unavailable(reason));
        }
        let result = self.launch_native(launch, started);
        result.map_err(|error: LaunchError| {
            let executable = self.executable.as_deref().unwrap_or(Path::new("muse"));
            let helper = std::env::current_exe().unwrap_or_default();
            let args = mcp::arguments(
                "[task omitted]",
                launch.full_access,
                &helper,
                &launch.session_id,
                self.cx
                    .app_data_dir
                    .file_name()
                    .is_some_and(|name| name.to_string_lossy().ends_with(".dev")),
            );
            let log = self
                .cx
                .spawn_logs()
                .join(format!("{}.muse.log", launch.session_id));
            if log.exists() {
                error.diagnose(executable, &args, &log)
            } else {
                let mut host_args = vec![
                    "relay".into(),
                    "muse-spawn-host".into(),
                    "--executable".into(),
                    executable.to_string_lossy().into_owned(),
                    "--log".into(),
                    log.to_string_lossy().into_owned(),
                    "--".into(),
                ];
                host_args.extend(args);
                error.diagnose(&helper, &host_args, &log.with_extension("host.log"))
            }
        })
    }

    fn find(&self, intent: &Intent) -> Option<(Target, Option<SpawnedProcess>)> {
        if let (Some(target), Some(process)) = (&intent.target, intent.process) {
            if target.id != intent.session_id
                && self.owns(target)
                && (!process.is(self.cx.table.process(process.pid))
                    || self
                        .cx
                        .table
                        .environment_var(process.pid, SPAWN_MARKER)
                        .as_deref()
                        == Some(&intent.session_id))
            {
                return Some((target.clone(), Some(process)));
            }
        }
        let deadline = Instant::now() + self.ready_timeout;
        loop {
            if let Some(session) = self.session(&intent.session_id) {
                let process = self.cx.table.process(session.pid).map(SpawnedProcess::of)?;
                let target = Target::new(SessionKind::MuseOpen, session.session_id);
                // Older workers have no host record; their exact registry proof
                // remains a valid discovery route during an upgrade.
                if hosts::read(&self.cx.spawn_logs(), &intent.session_id).is_some()
                    && !hosts::bind(
                        &self.cx.spawn_logs(),
                        &intent.session_id,
                        &target,
                        Some(process),
                        self.cx.table.as_ref(),
                    )
                {
                    return None;
                }
                return Some((target, Some(process)));
            }
            let Some(host) = hosts::pending(&self.cx.spawn_logs(), intent, self.cx.table.as_ref())
            else {
                return None;
            };
            if Instant::now() >= deadline {
                stop_process(self.cx.table.as_ref(), host.pid, Some(host.start));
                return None;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    fn alive(&self, target: &Target, process: Option<&SpawnedProcess>) -> bool {
        process.is_some_and(|process| {
            self.owned_process(target, process) && !self.cx.table.zombie(process.pid)
        })
    }

    fn stop(&self, target: &Target, process: Option<&SpawnedProcess>) {
        let Some(process) = process else {
            return;
        };
        let (logs, table) = (self.cx.spawn_logs(), self.cx.table.as_ref());
        // The host forwards TERM, kills a stubborn owned group and reaps it.
        let host = if self.owned_process(target, process) {
            hosts::bound(&logs, target, process, table).map(|r| r.host)
        } else {
            // The child ended or its pid was taken: the detached host it
            // leaves running is stopped when it proves it is ours, and
            // nothing at the child's pid is signalled.
            match hosts::owner_of(&logs, target, process, table) {
                Some(record) => Some(record.host),
                None => return,
            }
        };
        let stopped = host.unwrap_or(*process);
        stop_process(table, stopped.pid, Some(stopped.start));
    }

    fn observe(&self, agents: &[Watched]) -> Vec<Observation> {
        agents.iter().map(|agent| self.observe_one(agent)).collect()
    }
}

/// The host supplies only a terminal. It never types into Muse; the initial
/// task is a CLI argument and later tasks use Muse's own peer messaging.
pub fn arguments(text: &str, full_access: bool) -> Vec<String> {
    let mut args: Vec<String> = ["--trust-workspace", "--approval-mode", "never"]
        .map(String::from)
        .to_vec();
    if full_access {
        args.push("--yolo".into());
    }
    args.push("--".into());
    args.push(text.into());
    args
}

/// Only a proven live native spawn opts the courier into a matching access
/// profile. Muse refuses peer delivery between different trust profiles.
pub fn courier_access(
    config: &MuseConfig,
    table: &dyn crate::relay::process::ProcessTable,
    uid: u32,
    target: &str,
) -> Option<bool> {
    let session = runtime::active_sessions(config, table, uid)
        .into_iter()
        .find(|session| session.session_id == target)?;
    table
        .environment_var(session.pid, SPAWN_MARKER)
        .filter(|marker| is_uuid(marker))?;
    match table.environment_var(session.pid, SPAWN_ACCESS).as_deref() {
        Some("full") => Some(true),
        Some("workspace") => Some(false),
        _ => None,
    }
}

fn start_host(
    scope: Option<(&Path, &str)>,
    helper: &Path,
    args: &[String],
    log: &Path,
    directory: &Path,
    env: &BTreeMap<String, String>,
) -> Result<i32, String> {
    let arguments = args
        .iter()
        .map(std::ffi::OsString::from)
        .collect::<Vec<_>>();
    crate::relay::detach::start(scope, helper, &arguments, log, directory, env)
}

/// Muse's durable event log: a successful terminal is idle, a failed terminal
/// stays unknown. Events after a terminal mean another turn has started.
pub fn log_state(tail: &[u8]) -> Option<WorkState> {
    for line in tail.split(|b| *b == b'\n').rev() {
        let Ok(record) = serde_json::from_slice::<Value>(line) else {
            continue;
        };
        let event = &record["payload"]["event"];
        match event["kind"].as_str() {
            Some("terminal") => {
                return Some(if event["terminal"] == "completed" {
                    WorkState::Idle
                } else {
                    WorkState::Unknown
                })
            }
            Some(
                "turn_queue_submit"
                | "user_message_committed"
                | "assistant_message_committed"
                | "assistant_tool_calls_committed"
                | "inbox_item_drained",
            ) => return Some(WorkState::Working),
            _ => {}
        }
    }
    None
}

// The tests run Muse's host over a real PTY, process groups and signals.
#[cfg(test)]
#[cfg(unix)]
mod tests;

#[cfg(test)]
#[cfg(windows)]
mod windows_tests {
    use super::*;
    use crate::relay::process::FakeProcesses;

    #[test]
    fn muse_is_not_available_on_windows() {
        let root = tempfile::tempdir().unwrap();
        let cx = HarnessContext::system(
            &BTreeMap::new(),
            root.path(),
            &root.path().join("app"),
            Arc::new(FakeProcesses::default()),
        );
        let adapter = MuseAdapter::new(&cx);
        assert_eq!(
            adapter.detect(),
            Installed::Unusable("Muse is not available on Windows.".into())
        );
    }
}

fn unknown_observation() -> Observation {
    Observation {
        process: ProcessLiveness::Unknown,
        work: WorkState::Unknown,
        turn_in_progress: false,
    }
}
