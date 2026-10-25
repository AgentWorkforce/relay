//! Codex. A spawned Codex is a thread on Codex's local app-server daemon
//! (`codex app-server daemon start`, then `thread/start` and `turn/start`
//! through `codex app-server proxy`). The daemon may unload an idle thread
//! after this core's client goes. The thread survives a core restart, and later
//! messages resume that registered spawn through the app-server route.
//! On Linux under a systemd user manager, a daemon the core has to start
//! runs in a transient scope of its own, outside the core's cgroup.
//!
//! Watching it: the thread is archived (ended, completed) or loaded in
//! Codex's app-server (running). Any other thread is unknown and keeps its
//! place: with no app-server running, or one that has not loaded it, it is
//! paused, not ended, and comes back when Codex loads it again; freeing its
//! place would let new spawns fill the node past its maximum. Its rollout
//! says whether a turn runs.

use super::{
    Builtin, Descriptor, FullAccess, HarnessAdapter, HarnessContext, HarnessId, Installed,
    SpawnFacet,
};
use crate::relay::codex::app_server::{self, Access, TurnError};
use crate::relay::codex::rollout::{rollout_path, RolloutSummary};
use crate::relay::codex::runner::{CodexRunner, SystemRunner};
use crate::relay::codex::{self, processes, threads, CodexConfig};
use crate::relay::inject::InjectOutcome;
use crate::relay::process::ProcessTable;
use crate::relay::spawn::intents::Intent;
use crate::relay::spawn::launch::{
    scope_arguments, scope_unit, stop_process, Launch, LaunchError, Launched, Message,
    SpawnedProcess, Started, TaskHandoff,
};
use crate::relay::spawn::lifecycle::{self, Observation};
use crate::relay::spawn::observe::Watched;
use crate::relay::state::{ProcessLiveness, WorkState};
use crate::relay::store::{random_uuid, SessionKind, Target};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

pub const ID: HarnessId = HarnessId("codex");

pub const DESCRIPTOR: Descriptor = Descriptor {
    id: ID,
    label: "Codex",
    full_access: Some(FullAccess {
        detail: "Full access removes the sandbox for spawned Codex. Approval requests can be answered remotely; off keeps Codex in its workspace folder.",
        default: true,
    }),
    billing: true,
};

pub const BUILTIN: Builtin = Builtin {
    descriptor: &DESCRIPTOR,
    adapter,
};

fn adapter(cx: &HarnessContext) -> Arc<dyn HarnessAdapter> {
    Arc::new(CodexAdapter::new(cx))
}

/// How long Codex's daemon gets to come up.
const DAEMON_TIMEOUT: Duration = Duration::from_secs(20);
/// How long the app-server gets for the thread and then for its first turn.
const START_TIMEOUT: Duration = Duration::from_secs(12);
/// How many of Codex's most recently updated threads are searched for a
/// spawn's first turn; only those created since the spawn began are read.
const SCANNED_THREADS: usize = 500;
/// Leeway for clocks between the intent and Codex's record of the thread.
const CREATED_LEEWAY_MS: i64 = 60_000;

/// Why Codex is installed but cannot be spawned here.
pub const CODEX_NO_DAEMON: &str = "Codex here cannot start its app-server daemon, which spawned Codex agents run on. Install Codex with its own installer (https://chatgpt.com/codex/install.sh) or open the Codex app, then try again.";

/// Whether Codex can host a spawned thread here: a spawned thread runs on
/// Codex's app-server daemon, and `codex app-server daemon start` only works
/// for a Codex that manages its daemon (`packages/app-server-daemon`), for
/// the standalone install (`packages/standalone`), or when a daemon was
/// already set up (its control socket). A Codex installed only through npm
/// or a version manager has none, so Codex is not offered there. Files only:
/// whether a daemon happens to be running must not change what the node
/// offers.
/// On Windows the same packages hold `codex.exe`.
pub fn codex_daemon_possible(home: &Path) -> bool {
    const UNIX: [&str; 3] = [
        "app-server-control/app-server-control.sock",
        "packages/app-server-daemon/current/bin/codex",
        "packages/standalone/current/codex",
    ];
    const WINDOWS: [&str; 2] = [
        "packages/app-server-daemon/current/bin/codex.exe",
        "packages/standalone/current/codex.exe",
    ];
    let windows: &[&str] = if cfg!(windows) { &WINDOWS } else { &[] };
    UNIX.iter()
        .chain(windows)
        .any(|path| std::fs::symlink_metadata(home.join(path)).is_ok())
}

/// Codex on this computer.
pub struct CodexAdapter {
    pub codex: CodexConfig,
    pub table: Arc<dyn ProcessTable>,
    pub uid: u32,
    pub runner: Arc<dyn CodexRunner>,
    pub systemd_run: Option<PathBuf>,
}

impl CodexAdapter {
    pub fn new(cx: &HarnessContext) -> CodexAdapter {
        CodexAdapter {
            codex: CodexConfig::from_env(&|key| cx.var(key), &cx.home),
            table: cx.table.clone(),
            uid: cx.uid,
            runner: Arc::new(SystemRunner),
            systemd_run: cx.systemd_run.clone(),
        }
    }

    /// Starts the daemon if it is not running; one already running answers
    /// at once. Its own answer does not matter: the proxy fails if no
    /// daemon came up.
    fn start_daemon(&self, cli: &Path) {
        let (home, sqlite_home) = (&self.codex.home, &self.codex.sqlite_home);
        let start = ["app-server", "daemon", "start"].map(String::from);
        let _ = match &self.systemd_run {
            // A daemon started from the core's cgroup would end with it.
            Some(systemd_run) => {
                let arguments: Vec<String> = scope_arguments(&scope_unit(&random_uuid()))
                    .into_iter()
                    .chain(std::iter::once(cli.to_string_lossy().into_owned()))
                    .chain(start)
                    .collect();
                self.runner
                    .run_in_home(systemd_run, &arguments, DAEMON_TIMEOUT, home, sqlite_home)
            }
            None => self
                .runner
                .run_in_home(cli, &start, DAEMON_TIMEOUT, home, sqlite_home),
        };
    }

    /// Ends a Codex thread on the daemon that hosts it, saying why it could
    /// not: no Codex, no daemon reached, or Codex refused or did not answer.
    /// With `start`, a daemon not running is started first, as a launch
    /// does, so a thread whose daemon stopped can still be archived.
    fn archive(&self, thread_id: &str, start: bool) -> Result<(), String> {
        let (home, sqlite_home) = (&self.codex.home, &self.codex.sqlite_home);
        let running = || processes::running_executable(self.table.as_ref(), self.uid);
        let cli = self.codex.executable.clone();
        if start && running().is_none() && codex_daemon_possible(home) {
            if let Some(cli) = &cli {
                self.start_daemon(cli);
            }
        }
        let executable = running()
            .or(cli)
            .ok_or("Codex is not installed on this computer")?;
        let mut stream = self
            .runner
            .proxy_in_home(&executable, home, sqlite_home)
            .map_err(|error| format!("could not reach Codex's app-server: {error}"))?;
        app_server::archive_thread(stream.as_mut(), thread_id, START_TIMEOUT)
            .map_err(|error| format!("Codex did not archive its thread: {error}"))
    }

    /// The thread, created since the spawn began, whose rollout holds the
    /// turn the spawn's first message started.
    fn thread_of(&self, intent: &Intent) -> Option<Target> {
        let since = intent.created_ms.saturating_sub(CREATED_LEEWAY_MS);
        let message_id = intent.message_id.as_str();
        threads::created_since(&self.codex, since, SCANNED_THREADS)?
            .into_iter()
            .find(|id| {
                rollout_path(&self.codex, id)
                    .and_then(|path| RolloutSummary::read(&path))
                    .is_some_and(|summary| summary.turn_for(message_id).is_some())
            })
            .map(|id| Target::new(SessionKind::Codex, id.to_lowercase()))
    }

    fn work(&self, thread: &str) -> (WorkState, bool) {
        match rollout_path(&self.codex, thread).map(|path| RolloutSummary::load(&path)) {
            Some(Ok(summary)) if summary.active_turn.is_some() => (WorkState::Working, true),
            Some(Ok(_)) => (WorkState::Idle, false),
            // A thread with no rollout yet has run no turn.
            None => (WorkState::Idle, false),
            Some(Err(_)) => (WorkState::Unknown, false),
        }
    }

    fn observe_one(&self, agent: &Watched, daemon: &CodexDaemon) -> Observation {
        if !agent.alive {
            // Archived: finished with.
            return Observation {
                process: ProcessLiveness::Exited,
                work: WorkState::Completed,
                turn_in_progress: false,
            };
        }
        let (work, turn_in_progress) = self.work(&agent.target.id);
        match daemon.hosts(&agent.target.id) {
            ProcessLiveness::Exited => Observation {
                process: ProcessLiveness::Exited,
                work: lifecycle::ended_work(turn_in_progress),
                turn_in_progress,
            },
            process => Observation {
                process,
                work,
                turn_in_progress,
            },
        }
    }
}

impl HarnessAdapter for CodexAdapter {
    fn descriptor(&self) -> &'static Descriptor {
        &DESCRIPTOR
    }

    fn detect(&self) -> Installed {
        match &self.codex.executable {
            None => Installed::No,
            Some(_) if !codex_daemon_possible(&self.codex.home) => {
                Installed::Unusable(CODEX_NO_DAEMON.into())
            }
            Some(_) => Installed::Yes,
        }
    }

    fn spawn(&self) -> Option<&dyn SpawnFacet> {
        Some(self)
    }
}

impl SpawnFacet for CodexAdapter {
    fn owns(&self, target: &Target) -> bool {
        target.kind == SessionKind::Codex
    }

    fn native_input(&self, target: &Target) -> bool {
        self.owns(target)
    }

    fn deliver(&self, target: &Target, message: &Message) -> Option<InjectOutcome> {
        if !self.owns(target) {
            return None;
        }
        // Fails closed: an unreadable rollout, or a turn this process is
        // starting or still drives (which the rollout may not show yet), is
        // a busy thread. The claim holds the thread until its connection
        // closes, so no second turn can start meanwhile.
        let claim = app_server::drive::claim(&target.id)
            .filter(|_| crate::relay::codex::rollout::idle(&self.codex, &target.id));
        let Some(claim) = claim else {
            return Some(InjectOutcome::WaitingForTurn(
                "Codex is finishing its current turn".into(),
            ));
        };
        // An archived thread is never resumed: it was released.
        if crate::relay::codex::threads::contains_unarchived(&self.codex, &target.id) != Some(true)
        {
            return Some(InjectOutcome::Waiting(
                crate::relay::codex::router::NOT_RUNNING.into(),
            ));
        }
        let Some(executable) = processes::running_executable(self.table.as_ref(), self.uid) else {
            return Some(InjectOutcome::Waiting(
                "Codex's app-server is not running".into(),
            ));
        };
        let Ok(stream) =
            self.runner
                .proxy_in_home(&executable, &self.codex.home, &self.codex.sqlite_home)
        else {
            return Some(InjectOutcome::Waiting(
                "Codex's app-server is unavailable".into(),
            ));
        };
        Some(
            match app_server::send_spawned(
                stream,
                claim,
                (message.text, message.message_id),
                // As every Codex delivery: a peer-framed message is hidden
                // when relay messages are (`show_relay_messages` off); the
                // owner's plain text has no attribution and stays visible.
                match crate::relay::codex::compact::enabled() {
                    true => app_server::Hide::IfAble,
                    false => app_server::Hide::Never,
                },
                START_TIMEOUT,
            ) {
                Ok(true) => InjectOutcome::Delivered,
                Ok(false) => InjectOutcome::Waiting("Codex has not loaded its thread".into()),
                Err(TurnError::Refused(reason)) => InjectOutcome::Retry(reason),
                Err(TurnError::InDoubt(reason)) => InjectOutcome::InDoubt(reason),
            },
        )
    }

    fn launch(&self, launch: &Launch, on_started: Started) -> Result<Launched, LaunchError> {
        let result = (|| {
            let Some(cli) = self.codex.executable.clone() else {
                return Err(LaunchError::Unavailable(
                    "Codex is not installed on this computer".into(),
                ));
            };
            if !codex_daemon_possible(&self.codex.home) {
                return Err(LaunchError::Unavailable(CODEX_NO_DAEMON.into()));
            }
            self.start_daemon(&cli);
            let (home, sqlite_home) = (&self.codex.home, &self.codex.sqlite_home);
            let executable =
                processes::running_executable(self.table.as_ref(), self.uid).unwrap_or(cli);
            let stream = self
                .runner
                .proxy_in_home(&executable, home, sqlite_home)
                .map_err(|error| {
                    LaunchError::Failed(format!("could not reach Codex's app-server: {error}"))
                })?;
            let access = if launch.full_access {
                Access::Full
            } else {
                Access::Workspace
            };
            // The thread runs on the person's own app-server with their own
            // configuration, MCP servers included, as the broker's workers do.
            let started = app_server::start_spawned_thread(
                stream,
                &launch.directory.to_string_lossy(),
                access,
                &launch.text,
                &launch.message_id,
                START_TIMEOUT,
                app_server::StartOptions {
                    isolation: None,
                    created: Some(&|thread| {
                        on_started(
                            &Target::new(SessionKind::Codex, thread.to_lowercase()),
                            None,
                        )
                    }),
                },
            )
            .map_err(|error| {
                LaunchError::Failed(format!("Codex did not start a thread: {error}"))
            })?;
            let target = Target::new(SessionKind::Codex, started.thread_id.to_lowercase());
            let task = match started.turn {
                Ok(()) => TaskHandoff::Confirmed,
                Err(TurnError::InDoubt(_)) => TaskHandoff::Unconfirmed("in_doubt"),
                Err(TurnError::Refused(reason)) => {
                    // The thread exists but has no agent: archive it, as a
                    // release would, rather than leave it loaded.
                    let _ = self.archive(&started.thread_id, false);
                    return Err(LaunchError::Failed(format!(
                        "Codex refused the first turn: {reason}"
                    )));
                }
            };
            Ok(Launched {
                target,
                process: None,
                task,
            })
        })();
        if let Err(error) = &result {
            crate::relay::diagnostics::write(format_args!("Agent Relay Codex launch failed: {}; argv=not applicable (app-server RPC); exit_status=not applicable; stderr_tail=unavailable over RPC",
                super::diagnostics::redact(&error.code())));
        }
        result
    }

    /// By its thread, reported as soon as Codex creates it, or else by the
    /// first turn's message id among the threads created since the spawn
    /// began.
    fn find(&self, intent: &Intent) -> Option<(Target, Option<SpawnedProcess>)> {
        intent
            .target
            .clone()
            .or_else(|| self.thread_of(intent))
            .map(|target| (target, None))
    }

    /// Codex's daemon hosts the thread; it lives while the thread is not
    /// archived.
    fn alive(&self, target: &Target, _: Option<&SpawnedProcess>) -> bool {
        !threads::archived_ids(&self.codex, vec![target.id.as_str()]).contains(&target.id)
    }

    fn stop(&self, target: &Target, process: Option<&SpawnedProcess>) {
        if let Some(process) = process {
            stop_process(self.table.as_ref(), process.pid, Some(process.start));
        }
        let _ = self.archive(&target.id, false);
    }

    /// Released once its thread is archived: by this release, or already
    /// (by the person, or a release whose answer was lost).
    fn release(&self, target: &Target, process: Option<&SpawnedProcess>) -> Result<(), String> {
        if let Some(process) = process {
            stop_process(self.table.as_ref(), process.pid, Some(process.start));
        }
        match self.archive(&target.id, true) {
            Err(_) if !self.alive(target, process) => Ok(()),
            archived => archived,
        }
    }

    fn observe(&self, agents: &[Watched]) -> Vec<Observation> {
        // Codex is asked only when a live Codex agent needs the answer.
        let daemon = if !agents.iter().any(|agent| agent.alive) {
            CodexDaemon::Loaded(BTreeSet::new())
        } else if processes::running_executable(self.table.as_ref(), self.uid).is_none() {
            CodexDaemon::NotRunning
        } else {
            CodexDaemon::Loaded(codex::app_server_loaded(
                &self.codex,
                self.table.as_ref(),
                self.uid,
            ))
        };
        agents
            .iter()
            .map(|agent| self.observe_one(agent, &daemon))
            .collect()
    }
}

/// What Codex's app-server says of the threads it has loaded.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CodexDaemon {
    /// No Codex runs here, so no app-server hosts a thread.
    NotRunning,
    /// These threads are loaded (lowercase); an empty answer says nothing.
    Loaded(BTreeSet<String>),
}

impl CodexDaemon {
    /// Running when loaded; otherwise unknown, never ended: only archiving
    /// ends a thread.
    pub fn hosts(&self, thread: &str) -> ProcessLiveness {
        match self {
            CodexDaemon::Loaded(loaded) if loaded.contains(&thread.to_lowercase()) => {
                ProcessLiveness::Running
            }
            CodexDaemon::NotRunning | CodexDaemon::Loaded(_) => ProcessLiveness::Unknown,
        }
    }
}

#[cfg(test)]
mod tests;
