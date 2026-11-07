//! OpenCode. A spawned OpenCode is a session on an `opencode serve` of its
//! own, started the way probe-managed OpenCode sessions start theirs
//! (`opencode_serve`): a loopback port, fresh Basic credentials and a marker
//! only its environment holds. The session is created in the spawn's folder
//! with the spawn's permission rules, and its binding is sealed in the
//! managed-session registry (`ManagedSessions::adopt`), so later messages
//! reach it by the managed OpenCode route: `prompt_async` behind a
//! durable journal, waiting while the session is busy. The first message
//! goes the same way.
//!
//! The server runs in a process session of its own and, on Linux under a
//! systemd user manager, in a transient scope outside the core's cgroup, so
//! it outlives a core restart; the spawn records its pid and start time and
//! the registry its port, and delivery proves both again before each
//! message. Releasing the agent ends its server and, once the server is
//! gone, forgets its binding.
//!
//! Watching it: its server's process, by pid and start time, and OpenCode's
//! own `GET /session/status` (busy or retrying: working; else idle). Once
//! the server is gone, OpenCode's database says whether a turn was left
//! unfinished.
//!
//! Nobody answers a spawned agent's prompts, so its session's permission
//! rules never ask (`permission_rules`). OpenCode loads the person's own
//! configuration, MCP servers included, as Codex and Claude do.

mod detect;
mod server;
mod startup;

pub use detect::{
    find_executable, parse_version, supported, system_version, VersionCache, VersionProbe,
    OPENCODE_NO_VERSION, SYSTEM_OPENCODE,
};
pub use server::{
    created_session, pending, pending_path, session_status, OpenCodeServer, ServerStart,
    SystemServer, RULES_REFUSED, SPAWN_AUTHORITY,
};

use super::{
    await_ended, Builtin, Descriptor, FullAccess, HarnessAdapter, HarnessContext, HarnessId,
    Installed, SpawnFacet,
};
use crate::relay::existing_session::platform;
use crate::relay::managed_sessions::{ManagedBinding, ManagedSessions};
use crate::relay::opencode::{open_database, OpenCodeConfig};
use crate::relay::opencode_existing::{Binding, Outcome, SystemHttp};
use crate::relay::process::ProcessTable;
use crate::relay::spawn::intents::Intent;
use crate::relay::spawn::launch::{
    stop_process, Launch, LaunchError, Launched, SpawnedProcess, Started, TaskHandoff,
};
use crate::relay::spawn::lifecycle::{self, Observation};
use crate::relay::spawn::observe::Watched;
use crate::relay::state::{ProcessLiveness, WorkState};
use crate::relay::store::{SessionKind, Target};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// How long a spawn's first message waits for its session to be ready.
const FIRST_MESSAGE_WAIT: Duration = Duration::from_secs(30);

pub const ID: HarnessId = HarnessId("opencode");

pub const DESCRIPTOR: Descriptor = Descriptor {
    id: ID,
    label: "OpenCode",
    full_access: Some(FullAccess {
        detail: "Spawned OpenCode runs with every permission set to allow. Off lets it read and edit files in its folder and refuses everything else, shell commands included.",
        default: true,
    }),
    billing: true,
};

pub const BUILTIN: Builtin = Builtin {
    descriptor: &DESCRIPTOR,
    adapter,
};

fn adapter(cx: &HarnessContext) -> Arc<dyn HarnessAdapter> {
    Arc::new(OpenCodeAdapter::new(cx))
}

/// What a confined spawned OpenCode may do without asking: read, search and
/// edit inside its folder (outside it is `external_directory`), and keep
/// its to-do list.
const CONFINED: [&str; 7] = [
    "read",
    "edit",
    "glob",
    "grep",
    "list",
    "todoread",
    "todowrite",
];

/// A spawned session's permission rules (`POST /session`'s `permission`).
/// OpenCode applies the last rule that matches and a session's rules after
/// the person's configuration, so these decide. None asks: with full access
/// everything is allowed; without, what `CONFINED` names is and the rest is
/// refused, environment files included as OpenCode's own defaults guard
/// them. Its question tool waits for the person, so it is never offered.
pub fn permission_rules(full_access: bool) -> Value {
    let rule = |permission: &str, pattern: &str, action: &str| json!({"permission": permission, "pattern": pattern, "action": action});
    let mut rules = if full_access {
        vec![rule("*", "*", "allow")]
    } else {
        let mut rules = vec![rule("*", "*", "deny")];
        rules.extend(
            CONFINED
                .iter()
                .map(|permission| rule(permission, "*", "allow")),
        );
        rules.extend([
            rule("read", "*.env", "deny"),
            rule("read", "*.env.*", "deny"),
            rule("read", "*.env.example", "allow"),
        ]);
        rules
    };
    rules.push(rule("question", "*", "deny"));
    Value::Array(rules)
}

/// What OpenCode's session status means for an agent.
pub fn session_work(status: &str) -> WorkState {
    match status {
        "busy" | "retry" => WorkState::Working,
        "idle" => WorkState::Idle,
        _ => WorkState::Unknown,
    }
}

/// Whether OpenCode's database ends the session with a turn unfinished: a
/// user message last, or an assistant one not completed or about to run
/// its tools. A session it does not hold left nothing unfinished.
pub fn turn_unfinished(config: &OpenCodeConfig, session_id: &str) -> bool {
    let Some(database) = open_database(config) else {
        return false;
    };
    let last = database.query_row(
        "SELECT json_extract(data, '$.role'), json_extract(data, '$.time.completed'), \
         json_extract(data, '$.finish') FROM message WHERE session_id = ?1 \
         ORDER BY time_created DESC, id DESC LIMIT 1",
        [session_id],
        |row| {
            Ok((
                row.get::<_, Option<String>>(0)?,
                row.get::<_, Option<i64>>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        },
    );
    last.is_ok_and(|(role, completed, finish)| {
        role.as_deref() != Some("assistant")
            || completed.is_none()
            || finish.as_deref() == Some("tool-calls")
    })
}

/// OpenCode on this computer.
pub struct OpenCodeAdapter {
    pub executable: Option<PathBuf>,
    /// `opencode --version` for an executable.
    pub version: Arc<VersionProbe>,
    pub versions: VersionCache,
    pub server: Arc<dyn OpenCodeServer>,
    /// The managed-session registry spawned sessions are sealed in.
    pub managed: Arc<ManagedSessions>,
    pub table: Arc<dyn ProcessTable>,
    pub opencode: OpenCodeConfig,
    /// Where servers write their output and pending records.
    pub logs: PathBuf,
    /// How long the first message may wait for a session that is not ready
    /// yet (busy, or not answering its status).
    pub first_message_wait: Duration,
}

impl OpenCodeAdapter {
    pub fn new(cx: &HarnessContext) -> OpenCodeAdapter {
        let env = |key: &str| cx.var(key);
        let system: Vec<PathBuf> = SYSTEM_OPENCODE.iter().map(PathBuf::from).collect();
        let opencode = OpenCodeConfig::from_env(&env, &cx.home);
        let managed = Arc::new(ManagedSessions::system(
            &cx.app_data_dir,
            cx.table.clone(),
            &env,
            cx.environment.clone(),
        ));
        OpenCodeAdapter {
            executable: find_executable(&env, &cx.home, &system),
            version: Arc::new(system_version),
            versions: VersionCache::default(),
            server: Arc::new(SystemServer {
                table: cx.table.clone(),
                http: Arc::new(SystemHttp),
                environment: cx.environment.clone(),
                systemd_run: cx.systemd_run.clone(),
                logs: cx.spawn_logs(),
                journal: managed.journal("opencode"),
                opencode: opencode.clone(),
            }),
            managed,
            table: cx.table.clone(),
            opencode,
            logs: cx.spawn_logs(),
            first_message_wait: FIRST_MESSAGE_WAIT,
        }
    }

    /// The first message, delivered as the managed route delivers: sent at
    /// most once. A session that is not ready yet is asked again, as a
    /// later message would be, until `first_message_wait` has passed.
    fn hand_over(&self, binding: &Binding, launch: &Launch) -> Outcome {
        let deadline = Instant::now() + self.first_message_wait;
        loop {
            let outcome = self
                .server
                .prompt(binding, &launch.message_id, &launch.text);
            if !matches!(outcome, Outcome::Waiting(_)) || Instant::now() >= deadline {
                return outcome;
            }
            std::thread::sleep(Duration::from_millis(250));
        }
    }

    /// The executable, when OpenCode can be spawned.
    fn usable(&self) -> Result<PathBuf, LaunchError> {
        if let Some(reason) = platform::unsupported(DESCRIPTOR.label) {
            return Err(LaunchError::Unavailable(reason));
        }
        let Some(executable) = self.executable.clone() else {
            return Err(LaunchError::Unavailable(
                "OpenCode is not installed on this computer".into(),
            ));
        };
        match self.detect() {
            Installed::Unusable(reason) => Err(LaunchError::Unavailable(reason)),
            Installed::Yes | Installed::No => {
                Ok(std::fs::canonicalize(&executable).unwrap_or(executable))
            }
        }
    }

    fn observe_one(&self, agent: &Watched) -> Observation {
        if agent.process.is_none() {
            return Observation {
                process: ProcessLiveness::Unknown,
                work: WorkState::Unknown,
                turn_in_progress: false,
            };
        }
        if !agent.alive {
            let turn_in_progress = turn_unfinished(&self.opencode, &agent.target.id);
            return Observation {
                process: ProcessLiveness::Exited,
                work: lifecycle::ended_work(turn_in_progress),
                turn_in_progress,
            };
        }
        let work = match self.managed.binding(&agent.target) {
            Some(ManagedBinding::OpenCode(binding)) => self
                .server
                .status(&binding)
                .map_or(WorkState::Unknown, |status| session_work(&status)),
            _ => WorkState::Unknown,
        };
        Observation {
            process: ProcessLiveness::Running,
            work,
            turn_in_progress: work == WorkState::Working,
        }
    }
}

impl HarnessAdapter for OpenCodeAdapter {
    fn descriptor(&self) -> &'static Descriptor {
        &DESCRIPTOR
    }

    /// On Windows, unusable whether or not OpenCode is installed: a spawned
    /// OpenCode is reached through the managed route, which is Unix-only.
    fn detect(&self) -> Installed {
        if let Some(reason) = platform::unsupported(DESCRIPTOR.label) {
            return Installed::Unusable(reason);
        }
        let Some(executable) = &self.executable else {
            return Installed::No;
        };
        let version = self.versions.get(executable, self.version.as_ref());
        match supported(version.as_deref()) {
            Ok(()) => Installed::Yes,
            Err(reason) => Installed::Unusable(reason),
        }
    }

    fn spawn(&self) -> Option<&dyn SpawnFacet> {
        Some(self)
    }
}

impl SpawnFacet for OpenCodeAdapter {
    fn owns(&self, target: &Target) -> bool {
        target.kind == SessionKind::OpenCode
    }

    fn launch(&self, launch: &Launch, started: Started) -> Result<Launched, LaunchError> {
        let executable = self.usable()?;
        let directory = std::fs::canonicalize(&launch.directory).map_err(|error| {
            LaunchError::Failed(format!("{}: {error}", launch.directory.display()))
        })?;
        let binding = self
            .server
            .start(&ServerStart {
                executable,
                directory,
                spawn_id: launch.session_id.clone(),
                title: format!("@{}", launch.name),
                rules: permission_rules(launch.full_access),
            })
            .map_err(|error| LaunchError::Failed(format!("OpenCode could not start: {error}")))?;
        let target = Target::new(SessionKind::OpenCode, binding.session_id.clone());
        let process = SpawnedProcess {
            pid: binding.server_pid,
            start: binding.server_start,
        };
        let pending = pending_path(&self.logs, &launch.session_id);
        if let Err(error) = self
            .managed
            .adopt(ManagedBinding::OpenCode(binding.clone()))
        {
            stop_process(self.table.as_ref(), process.pid, Some(process.start));
            let _ = std::fs::remove_file(pending);
            return Err(LaunchError::Failed(format!(
                "OpenCode's session could not be recorded: {error}"
            )));
        }
        started(&target, Some(process));
        let _ = std::fs::remove_file(pending);
        let task = match self.hand_over(&binding, launch) {
            Outcome::Completed { .. } => match startup::wait(self.server.as_ref(), &binding) {
                Ok(task) => task,
                Err(reason) => {
                    self.stop(&target, Some(&process));
                    return Err(LaunchError::Unavailable(reason));
                }
            },
            // Sent and never sent again; OpenCode did not show it in time.
            Outcome::InDoubt(_) => TaskHandoff::Unconfirmed("in_doubt"),
            Outcome::Waiting(failure) | Outcome::Refused(failure) => {
                self.stop(&target, Some(&process));
                return Err(LaunchError::Failed(format!(
                    "OpenCode did not take the first message ({failure:?})"
                )));
            }
        };
        Ok(Launched {
            target,
            process: Some(process),
            task,
        })
    }

    /// By the session and server the launch recorded. A server recorded
    /// before its session existed has nothing to keep and is ended.
    fn find(&self, intent: &Intent) -> Option<(Target, Option<SpawnedProcess>)> {
        if let Some(target) = intent.target.clone() {
            return Some((target, intent.process));
        }
        if let Some(server) = pending(&self.logs, &intent.session_id) {
            stop_process(self.table.as_ref(), server.pid, Some(server.start));
        }
        let _ = std::fs::remove_file(pending_path(&self.logs, &intent.session_id));
        None
    }

    fn alive(&self, _: &Target, process: Option<&SpawnedProcess>) -> bool {
        process.is_some_and(|process| {
            process.is(self.table.process(process.pid)) && !self.table.zombie(process.pid)
        })
    }

    /// Signals the server. Its binding, the agent's delivery and status
    /// route, is forgotten only once the server is gone: one that outlives
    /// the signal stays reachable while it is still registered.
    fn stop(&self, target: &Target, process: Option<&SpawnedProcess>) {
        if let Some(process) = process {
            stop_process(self.table.as_ref(), process.pid, Some(process.start));
        }
        if !self.alive(target, process) {
            self.managed.forget(target);
        }
    }

    /// Ends the server and confirms it, then forgets its binding. A server
    /// still running fails the release with its binding kept.
    fn release(&self, target: &Target, process: Option<&SpawnedProcess>) -> Result<(), String> {
        self.stop(target, process);
        await_ended(self, target, process)?;
        self.managed.forget(target);
        Ok(())
    }

    fn observe(&self, agents: &[Watched]) -> Vec<Observation> {
        agents.iter().map(|agent| self.observe_one(agent)).collect()
    }
}

// Unix file modes and `#!/bin/sh` stand-ins; spawned OpenCode is not
// available on Windows.
#[cfg(test)]
#[cfg(unix)]
mod tests;

#[cfg(test)]
#[cfg(windows)]
mod windows_tests {
    use super::*;
    use crate::relay::process::FakeProcesses;

    #[test]
    fn spawning_opencode_is_refused_on_windows() {
        let root = tempfile::tempdir().unwrap();
        let cx = HarnessContext {
            env: Default::default(),
            home: root.path().to_path_buf(),
            app_data_dir: root.path().join("app"),
            table: Arc::new(FakeProcesses::default()),
            uid: 0,
            environment: None,
            systemd_run: None,
        };
        let adapter = OpenCodeAdapter::new(&cx);
        let sentence = "OpenCode is not available on Windows.".to_string();
        assert_eq!(adapter.detect(), Installed::Unusable(sentence.clone()));
        assert!(matches!(
            adapter.usable(),
            Err(LaunchError::Unavailable(reason)) if reason == sentence
        ));
    }
}
