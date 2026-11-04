//! Claude Code. A spawned Claude is `claude -p --input-format stream-json
//! --output-format stream-json` in its own process session, its input held
//! open by a small shell that exits with it
//! (`spawn::launch::start_with_input`). The verified machine owner's
//! messages are written into that input as its own user turns, and its
//! permission prompts come back on its output for the owner to answer
//! through Relay (`channel`, `requests`). Every agent's messages, the one
//! that asked for it included, reach it through the peer inbox it publishes
//! like a terminal session. On Linux under a
//! systemd user manager it runs in a transient scope of its own, outside
//! the core's cgroup, so it outlives a core restart.
//!
//! Watching it: its process, by pid and start time. Claude Code's registry
//! `status` for the session, else the tail of its stream-json output, says
//! whether a turn runs.
//!
//! Joining and taking it over (`handover`): the apps follow its stream-json
//! output as its transcript, and a take over stops it so the person resumes
//! the session (`claude --resume <id>`) in Terminal or Claude Desktop.

use super::{
    Builtin, Descriptor, FullAccess, HandoverFacet, HarnessAdapter, HarnessContext, HarnessId,
    Installed, SpawnFacet,
};
use crate::relay::claude::{self as claude_code, AgentEnvironment, ClaudeConfig};
use crate::relay::inject::InjectOutcome;
use crate::relay::process::ProcessTable;
use crate::relay::spawn::intents::Intent;
use crate::relay::spawn::launch::{
    start_scoped_or_plain, start_with_input, stop_process, Launch, LaunchError, Launched, Message,
    SpawnedProcess, Started, TaskHandoff,
};
use crate::relay::spawn::lifecycle::{self, Observation};
use crate::relay::spawn::observe::{read_tail, Watched};
use crate::relay::state::{ProcessLiveness, WorkState};
use crate::relay::store::{SessionKind, Target};
use channel::SendError;
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

pub const ID: HarnessId = HarnessId("claude");

pub const DESCRIPTOR: Descriptor = Descriptor {
    id: ID,
    label: "Claude",
    full_access: Some(FullAccess {
        detail: "Spawned Claude runs with --dangerously-skip-permissions. Off lets it edit files; anything else that would ask can be answered remotely.",
        default: true,
    }),
    billing: true,
};

pub const BUILTIN: Builtin = Builtin {
    descriptor: &DESCRIPTOR,
    adapter,
};

fn adapter(cx: &HarnessContext) -> Arc<dyn HarnessAdapter> {
    Arc::new(ClaudeAdapter::new(cx))
}

/// How long a new Claude process gets to publish its session and show
/// that it took its first message.
const READY_TIMEOUT: Duration = Duration::from_secs(20);
/// How much of a log's end is read.
const LOG_TAIL: u64 = 64 * 1024;
/// How much of a log's start is read for the first message's receipt: its
/// `init` event lists the tools, skills and MCP servers, so it can be long.
const LOG_HEAD: u64 = 1024 * 1024;

/// Claude Code on this computer.
pub struct ClaudeAdapter {
    pub claude: ClaudeConfig,
    pub table: Arc<dyn ProcessTable>,
    pub environment: Option<AgentEnvironment>,
    /// Where each spawned Claude writes its stream-json output,
    /// `<session id>.jsonl`.
    pub logs: PathBuf,
    pub systemd_run: Option<PathBuf>,
}

impl ClaudeAdapter {
    pub fn new(cx: &HarnessContext) -> ClaudeAdapter {
        ClaudeAdapter {
            claude: ClaudeConfig::from_env(&|key| cx.var(key), &cx.home),
            table: cx.table.clone(),
            environment: cx.environment.clone(),
            logs: cx.spawn_logs(),
            systemd_run: cx.systemd_run.clone(),
        }
    }

    /// Ready once Claude Code publishes this session for the process it
    /// started, `launched` (`pid` at its start time). It gives up when that
    /// process ends or its pid is taken by another, or in time, and then
    /// stops only that process: one whose start time was never read cannot
    /// be told from a process that took its pid, so it is not signalled.
    fn wait_ready(
        &self,
        session_id: &str,
        pid: i32,
        launched: Option<SpawnedProcess>,
        log: &Path,
        deadline: Instant,
    ) -> Result<SpawnedProcess, String> {
        let ours = |process: &SpawnedProcess| launched.is_none_or(|launched| launched == *process);
        loop {
            let process =
                claude_code::terminal_session(&self.claude, self.table.as_ref(), session_id)
                    .filter(|session| session.pid == pid)
                    .and_then(|session| self.table.process(session.pid))
                    .map(SpawnedProcess::of)
                    .filter(ours);
            if let Some(process) = process {
                return Ok(process);
            }
            let replaced =
                launched.is_some_and(|launched| !launched.is(self.table.process(launched.pid)));
            if replaced || self.table.process_gone(pid) || Instant::now() >= deadline {
                if let Some(launched) = launched {
                    stop_process(self.table.as_ref(), launched.pid, Some(launched.start));
                }
                return Err(format!(
                    "Claude Code did not start its session; see {}",
                    log.display()
                ));
            }
            std::thread::sleep(Duration::from_millis(250));
        }
    }

    /// Confirmed once `process`'s stream-json output shows it took its
    /// first message (`task_taken`), by `deadline`; unconfirmed when it does
    /// not by then or the process ends first. It only reads: the message is
    /// never written again.
    fn wait_taken(
        &self,
        session_id: &str,
        process: SpawnedProcess,
        log: &Path,
        deadline: Instant,
    ) -> TaskHandoff {
        loop {
            // What it wrote before ending still counts, so the log is read
            // before the process is checked.
            let ended =
                !process.is(self.table.process(process.pid)) || self.table.zombie(process.pid);
            if read_head(log, LOG_HEAD).is_some_and(|head| task_taken(&head, session_id)) {
                return TaskHandoff::Confirmed;
            }
            if ended || Instant::now() >= deadline {
                return TaskHandoff::Unconfirmed("input");
            }
            std::thread::sleep(Duration::from_millis(250));
        }
    }

    fn log_state(&self, session_id: &str) -> Option<WorkState> {
        let tail = read_tail(&channel::log_path(&self.logs, session_id), LOG_TAIL)?;
        log_state(&tail)
    }

    /// A native turn into a spawned Claude's own input, once it is idle.
    fn deliver_native(&self, session: &str, message: &Message) -> InjectOutcome {
        if !channel::reading(&self.logs, session) {
            return InjectOutcome::Waiting("Claude is not running".into());
        }
        if requests::waiting(session) {
            return InjectOutcome::WaitingForTurn(
                "Claude is waiting for an answer to its request".into(),
            );
        }
        if channel::starting(&self.logs, session)
            || self.log_state(session) != Some(WorkState::Idle)
        {
            return InjectOutcome::WaitingForTurn("Claude is finishing its current turn".into());
        }
        match channel::submit(&self.logs, session, message.text, message.message_id) {
            Ok(()) => InjectOutcome::Delivered,
            Err(SendError::Closed) => InjectOutcome::Waiting("Claude is not running".into()),
            Err(SendError::NotWritten(reason)) => InjectOutcome::Retry(reason),
            Err(SendError::Partial(reason)) => InjectOutcome::InDoubt(reason),
        }
    }

    fn observe_one(&self, agent: &Watched) -> Observation {
        let Some(process) = agent.process else {
            return Observation {
                process: ProcessLiveness::Unknown,
                work: WorkState::Unknown,
                turn_in_progress: false,
            };
        };
        if !agent.alive {
            // Ended: cleanly after a turn's result, or with one running.
            let turn_in_progress = self.log_state(&agent.target.id) != Some(WorkState::Idle);
            return Observation {
                process: ProcessLiveness::Exited,
                work: lifecycle::ended_work(turn_in_progress),
                turn_in_progress,
            };
        }
        let registry =
            claude_code::terminal_session(&self.claude, self.table.as_ref(), &agent.target.id)
                .filter(|session| session.pid == process.pid)
                .and_then(|session| session.status)
                .map(|status| registry_status(&status))
                .filter(|state| *state != WorkState::Unknown);
        let work = registry
            .or_else(|| self.log_state(&agent.target.id))
            .unwrap_or(WorkState::Unknown);
        Observation {
            process: ProcessLiveness::Running,
            work,
            turn_in_progress: work == WorkState::Working,
        }
    }
}

impl HarnessAdapter for ClaudeAdapter {
    fn descriptor(&self) -> &'static Descriptor {
        &DESCRIPTOR
    }

    fn detect(&self) -> Installed {
        match self.claude.executable {
            Some(_) => Installed::Yes,
            None => Installed::No,
        }
    }

    fn spawn(&self) -> Option<&dyn SpawnFacet> {
        Some(self)
    }
}

impl SpawnFacet for ClaudeAdapter {
    fn owns(&self, target: &Target) -> bool {
        target.kind == SessionKind::ClaudeTerminal
    }

    fn launch(&self, launch: &Launch, started: Started) -> Result<Launched, LaunchError> {
        let Some(executable) = self.claude.executable.clone() else {
            return Err(LaunchError::Unavailable(
                "Claude Code is not installed on this computer".into(),
            ));
        };
        std::fs::create_dir_all(&self.logs).map_err(|error| {
            LaunchError::Failed(format!("could not make the spawn log folder: {error}"))
        })?;
        let session_id = &launch.session_id;
        let log = channel::log_path(&self.logs, session_id);
        let fifo = channel::input_path(&self.logs, session_id);
        let mut environment: BTreeMap<String, String> = std::env::vars().collect();
        if let Some(agent_environment) = &self.environment {
            environment = agent_environment("claude", environment);
        }
        environment.insert(
            "AGENT_RELAY_SPAWN_INPUT".into(),
            first_message(&launch.text),
        );
        // Its turns' state on its output, so a native turn waits for idle.
        environment.insert("CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS".into(), "1".into());
        let arguments = arguments(session_id, launch.full_access);
        let unit = crate::relay::spawn::launch::scope_unit(session_id);
        let start = |scope: Option<(&Path, &str)>| {
            start_with_input(
                scope,
                &executable,
                &arguments,
                &fifo,
                &log,
                &launch.directory,
                &environment,
            )
        };
        // Without a scope it would end with the core on the next restart;
        // a manager that refuses one still leaves it running until then.
        let pid = match &self.systemd_run {
            Some(systemd_run) => start_scoped_or_plain(systemd_run, &unit, start),
            None => start(None),
        };
        let pid = pid.map_err(|error| {
            LaunchError::Failed(super::diagnostics::launch_failure(
                &format!("Claude Code could not start: {error}"),
                &executable,
                &arguments,
                &log,
            ))
        })?;
        let target = Target::new(SessionKind::ClaudeTerminal, session_id.clone());
        // Its identity, read once now, is what proves it ours later.
        let launched = self.table.process(pid).map(SpawnedProcess::of);
        started(&target, launched);
        let deadline = Instant::now() + READY_TIMEOUT;
        let process = self
            .wait_ready(session_id, pid, launched, &log, deadline)
            .map_err(|reason| {
                LaunchError::Failed(super::diagnostics::launch_failure(
                    &reason,
                    &executable,
                    &arguments,
                    &log,
                ))
            })?;
        // The first message was on its input before it started; stream-json
        // has no receipt for it, so its output is the evidence.
        let task = self.wait_taken(session_id, process, &log, deadline);
        Ok(Launched {
            target,
            process: Some(process),
            task,
        })
    }

    /// By the process it started or the session it published.
    fn find(&self, intent: &Intent) -> Option<(Target, Option<SpawnedProcess>)> {
        let process = intent.process.or_else(|| {
            let session = claude_code::terminal_session(
                &self.claude,
                self.table.as_ref(),
                &intent.session_id,
            )?;
            self.table.process(session.pid).map(SpawnedProcess::of)
        })?;
        let target = Target::new(SessionKind::ClaudeTerminal, intent.session_id.clone());
        Some((target, Some(process)))
    }

    fn alive(&self, _: &Target, process: Option<&SpawnedProcess>) -> bool {
        process.is_some_and(|process| {
            process.is(self.table.process(process.pid)) && !self.table.zombie(process.pid)
        })
    }

    fn stop(&self, _: &Target, process: Option<&SpawnedProcess>) {
        if let Some(process) = process {
            stop_process(self.table.as_ref(), process.pid, Some(process.start));
        }
    }

    fn observe(&self, agents: &[Watched]) -> Vec<Observation> {
        agents.iter().map(|agent| self.observe_one(agent)).collect()
    }

    fn native_input(&self, target: &Target) -> bool {
        self.owns(target) && channel::has_input(&self.logs, &target.id)
    }

    /// A native message through its own input; anything else, and a Claude
    /// spawned before it had one, through its peer inbox.
    fn deliver(&self, target: &Target, message: &Message) -> Option<InjectOutcome> {
        (message.native && self.native_input(target))
            .then(|| self.deliver_native(&target.id, message))
    }

    fn poll_requests(&self, target: &Target) -> Option<bool> {
        self.owns(target)
            .then(|| channel::poll(&self.logs, &target.id) == channel::Poll::Live)
    }

    fn handover(&self) -> Option<&dyn HandoverFacet> {
        Some(self)
    }
}

/// `claude -p` reading and writing stream-json, its input echoed into its
/// output so its transcript shows what it was asked. It names its session,
/// so the core knows it before Claude Code publishes it. Its permission
/// prompts, MCP elicitations and dialogs come to the core on its output
/// (`--permission-prompt-tool stdio`) rather than being refused. Like the
/// broker's workers it loads the person's own MCP servers and connectors.
pub fn arguments(session_id: &str, full_access: bool) -> Vec<String> {
    let mut arguments: Vec<String> = [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--replay-user-messages",
        "--session-id",
        session_id,
        "--permission-prompt-tool",
        "stdio",
    ]
    .map(String::from)
    .to_vec();
    if full_access {
        arguments.push("--dangerously-skip-permissions".into());
    } else {
        arguments.extend(["--permission-mode".into(), "acceptEdits".into()]);
    }
    arguments
}

/// The stream-json line that is the agent's first message.
pub fn first_message(text: &str) -> String {
    serde_json::json!({
        "type": "user",
        "message": {"role": "user", "content": text},
    })
    .to_string()
}

/// Whether a headless Claude's stream-json output shows it took the first
/// message of `session_id`: an event of that session that Claude Code
/// writes only once it has read a message and begun its turn, `system`
/// `init` (written at the start of each turn, not at launch), an
/// `assistant` message or a turn's `result`. Nothing but the first message
/// is on its input before the spawn is answered, so the first such event is
/// that message's. Lines that do not parse (a partial last line) are not
/// evidence.
pub fn task_taken(head: &[u8], session_id: &str) -> bool {
    head.split(|byte| *byte == b'\n')
        .filter_map(|line| serde_json::from_slice::<Value>(line).ok())
        .filter(|event| event["session_id"].as_str() == Some(session_id))
        .any(|event| match event["type"].as_str() {
            Some("system") => event["subtype"] == "init",
            Some("assistant" | "result") => true,
            _ => false,
        })
}

/// What `path` holds from `offset` on.
fn read_from(path: &Path, offset: u64) -> Option<Vec<u8>> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(path).ok()?;
    file.seek(SeekFrom::Start(offset)).ok()?;
    let mut rest = Vec::new();
    file.read_to_end(&mut rest).ok()?;
    Some(rest)
}

/// Up to `bytes` from the start of `path`.
fn read_head(path: &Path, bytes: u64) -> Option<Vec<u8>> {
    use std::io::Read;
    let mut head = Vec::new();
    std::fs::File::open(path)
        .ok()?
        .take(bytes)
        .read_to_end(&mut head)
        .ok()?;
    Some(head)
}

/// Claude Code's registry `status` for a session.
pub fn registry_status(status: &str) -> WorkState {
    let status = status.to_ascii_lowercase();
    match status.as_str() {
        "busy" | "working" | "running" => WorkState::Working,
        // `shell`: idle with a background shell still running.
        "idle" | "shell" => WorkState::Idle,
        _ if status.contains("wait")
            || status.contains("permission")
            || status.contains("approval") =>
        {
            WorkState::Waiting
        }
        _ => WorkState::Unknown,
    }
}

/// What the tail of a headless Claude's stream-json output says. Its last
/// `session_state_changed` says it outright; without one, a `result` last
/// means its turn ended (idle), a control request that it waits for an
/// answer, and any other turn event after it that a turn runs. Bookkeeping
/// Claude Code writes between turns too is passed over. `None` when no such
/// event is readable.
pub fn log_state(tail: &[u8]) -> Option<WorkState> {
    tail.split(|byte| *byte == b'\n')
        .rev()
        .filter_map(|line| serde_json::from_slice::<Value>(line).ok())
        .find_map(|event| event_state(&event))
}

fn event_state(event: &Value) -> Option<WorkState> {
    if event["subtype"] == "session_state_changed" {
        return match event["state"].as_str()? {
            "idle" => Some(WorkState::Idle),
            "running" => Some(WorkState::Working),
            "requires_action" => Some(WorkState::Waiting),
            _ => None,
        };
    }
    match event["type"].as_str()? {
        "result" => Some(WorkState::Idle),
        "control_request" => Some(WorkState::Waiting),
        "system" if event["subtype"] != "init" => None,
        "command_lifecycle"
        | "rate_limit_event"
        | "prompt_suggestion"
        | "control_response"
        | "control_cancel_request" => None,
        _ => Some(WorkState::Working),
    }
}

pub mod channel;
pub mod handover;
pub mod requests;
#[cfg(test)]
mod tests;
