//! Starting a spawned agent headless, through each vendor's own interface
//! rather than a terminal wrapped in a PTY. Each harness's own launch is in
//! its adapter (`relay::harness`); `RegistrySpawner` answers the spawn
//! module's `Spawner` by asking the adapter of the harness, or of the
//! session, at hand.
//!
//! On Linux under a systemd user manager, everything the core starts is in
//! the core's own cgroup, which `systemctl --user restart agent-relay.service`
//! (an update) ends however it was detached. So what a launch starts runs in
//! a transient scope of its own (`systemd-run --user --scope`), outside it.
//! A harness that reads its input from a pipe starts through
//! `start_with_input`, which keeps the pipe open, and on disk for the core
//! to write to, for as long as the agent runs.
//!
//! Spawned Codex keeps an app-server client for permission prompts, and
//! spawned Claude its stream-json input and output, both routed through
//! Relay. Other harnesses run with full access (the person's choice in
//! Settings) or confined as their harness allows.

use crate::relay::harness::{HandoverFacet, HarnessId, Installed, Registry, RunningSession};
use crate::relay::inject::{DeliveryRoute, InjectOutcome, Injector};
use crate::relay::process::{ProcessInfo, ProcessTable};
use crate::relay::store::{Registration, Target};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
#[cfg(unix)]
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// The folder under the app data directory where spawned agents write
/// their output, `<session id>.jsonl`.
pub const SPAWN_LOGS: &str = "spawned-agents";

/// One agent to start.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Launch {
    pub harness: HarnessId,
    pub name: String,
    /// The first message, as the agent reads it.
    pub text: String,
    pub directory: PathBuf,
    pub full_access: bool,
    /// An id for the first message, decided before it starts (Codex's
    /// `clientUserMessageId` for the first turn).
    pub message_id: String,
    /// An id for the session, decided before it starts (Claude's
    /// `--session-id`).
    pub session_id: String,
}

/// Told the agent's session and process as soon as the launch started them,
/// before it knows whether the agent took its task.
pub type Started<'a> = &'a dyn Fn(&Target, Option<SpawnedProcess>);

/// The process a spawn started, when it is one this core must watch: pid
/// and kernel start time, so a recycled pid is never taken for it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SpawnedProcess {
    pub pid: i32,
    pub start: u64,
}

impl SpawnedProcess {
    pub fn of(info: ProcessInfo) -> SpawnedProcess {
        SpawnedProcess {
            pid: info.pid,
            start: info.start,
        }
    }

    /// Whether `info` is this process, not another that took its pid.
    pub fn is(&self, info: Option<ProcessInfo>) -> bool {
        info.is_some_and(|info| info.start == self.start)
    }
}

/// Whether the harness was seen to take the first message.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TaskHandoff {
    Confirmed,
    /// Handed over without the harness confirming it; the reason is what
    /// Cloud records as the verification.
    Unconfirmed(&'static str),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Launched {
    pub target: Target,
    pub process: Option<SpawnedProcess>,
    pub task: TaskHandoff,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LaunchError {
    /// The harness is not installed here.
    Unavailable(String),
    Failed(String),
}

impl LaunchError {
    pub(crate) fn diagnose(self, executable: &Path, arguments: &[String], log: &Path) -> Self {
        match self {
            Self::Unavailable(reason) => {
                Self::Unavailable(crate::relay::harness::diagnostics::launch_failure(
                    &reason, executable, arguments, log,
                ))
            }
            Self::Failed(reason) => {
                Self::Failed(crate::relay::harness::diagnostics::launch_failure(
                    &reason, executable, arguments, log,
                ))
            }
        }
    }
    /// The `action.result` error Cloud shows.
    pub fn code(&self) -> String {
        match self {
            LaunchError::Unavailable(reason) => format!("spawn_harness_unavailable: {reason}"),
            LaunchError::Failed(reason) => format!("spawn_failed: {reason}"),
        }
    }
}

/// Starts and watches spawned agents; the seam that keeps tests from
/// running Codex or Claude.
pub trait Spawner: Send + Sync {
    /// The harnesses installed on this computer.
    fn available(&self) -> Vec<HarnessId>;
    /// Why `harness`, missing from `available`, cannot be spawned here when
    /// it is installed; `None` when it simply is not.
    fn unavailable_reason(&self, _harness: HarnessId) -> Option<String> {
        None
    }
    /// Starts one agent. Blocking, for up to about half a minute.
    fn launch(&self, launch: &Launch, started: Started) -> Result<Launched, LaunchError>;
    /// The session and process of a spawn a restart interrupted, when they
    /// can be found; whether it still runs is `alive`'s to say.
    fn find(&self, intent: &super::intents::Intent) -> Option<(Target, Option<SpawnedProcess>)> {
        intent.target.clone().map(|target| (target, intent.process))
    }
    /// Whether the agent's session still runs.
    fn alive(&self, target: &Target, process: Option<&SpawnedProcess>) -> bool;
    /// Ends the agent's process, if it has one of its own.
    fn stop(&self, target: &Target, process: Option<&SpawnedProcess>);
    /// Ends the agent for a release and confirms it ended: an error keeps
    /// the agent registered, so the release can be asked again. Blocking.
    fn release(&self, target: &Target, process: Option<&SpawnedProcess>) -> Result<(), String> {
        self.stop(target, process);
        Ok(())
    }
    /// What a launcher knows of its agents first-hand (a scope that ended,
    /// an exit status), answered before the general observer; `None` leaves
    /// it to the observer.
    fn observe(
        &self,
        _agents: &[super::observe::Watched],
    ) -> Option<Vec<super::lifecycle::Observation>> {
        None
    }
    /// Delivers a later message into an agent it started, through its
    /// harness's own route; `None` leaves it to the session's usual one.
    fn deliver(&self, _target: &Target, _message: &Message) -> Option<InjectOutcome> {
        None
    }
    /// Whether a message may reach a spawned agent as its own user turn.
    fn native_input(&self, _target: &Target) -> bool {
        false
    }
    /// Takes up a spawned agent's pending permission requests (see
    /// `SpawnFacet::poll_requests`). Blocking.
    fn poll_requests(&self, _target: &Target) -> Option<bool> {
        None
    }
    /// One message into `registration`'s agent: a spawned one through its
    /// harness's own route when it has one, anything else through `injector`.
    fn deliver_registered(
        &self,
        injector: &dyn Injector,
        registration: &Registration,
        route: &DeliveryRoute<'_>,
        text: &str,
    ) -> InjectOutcome {
        let message = Message {
            delivery_id: route.delivery_id,
            message_id: route.message_id,
            text,
            native: route.native,
        };
        injector.inject_spawned(registration, route, text, &|| {
            self.deliver(&registration.target, &message)
        })
    }
    /// Whether `target`'s agent can be taken over (`HandoverFacet`).
    fn hands_over(&self, _target: &Target) -> bool {
        false
    }
    /// What `target`'s agent has said, from its own output; `None` when its
    /// harness has no transcript of its own.
    fn transcript(&self, _target: &Target, _cursor: Option<&TranscriptCursor>) -> Option<Page> {
        None
    }
    /// The process running `target`'s session now, found by the session.
    fn session(&self, _target: &Target) -> Option<RunningSession> {
        None
    }
}

/// A message on its way into a spawned agent.
#[derive(Clone, Copy, Debug)]
pub struct Message<'a> {
    /// Relaycast's delivery, which a delivery journal keys on.
    pub delivery_id: &'a str,
    pub message_id: &'a str,
    pub text: &'a str,
    /// From the machine's verified owner, by a direct message: plain text,
    /// for the agent's own user turn.
    pub native: bool,
}

type TranscriptCursor = crate::relay::contract::transcript::LocalTranscriptCursor;
type Page = Result<crate::relay::contract::transcript::LocalTranscriptPage, String>;

/// Spawns nothing.
pub struct NoSpawner;

impl Spawner for NoSpawner {
    fn available(&self) -> Vec<HarnessId> {
        Vec::new()
    }

    fn launch(&self, _: &Launch, _: Started) -> Result<Launched, LaunchError> {
        Err(LaunchError::Unavailable(
            "this computer does not spawn agents".into(),
        ))
    }

    fn alive(&self, _: &Target, _: Option<&SpawnedProcess>) -> bool {
        false
    }

    fn stop(&self, _: &Target, _: Option<&SpawnedProcess>) {}
}

mod scope;
pub(crate) use scope::start_scoped_or_plain;
pub use scope::{scope_arguments, scope_unit, systemd_run};

/// Spawns on this computer, through each harness's adapter.
pub struct RegistrySpawner(pub Registry);

/// Check actual directory access, not just its existence. In particular,
/// macOS can allow `stat` while denying a launchd job access to a removable
/// volume. Bun reports that denial as `Unexpected` and, at launchd's usual
/// soft limit of 256, misleadingly suggests raising the descriptor limit.
/// This does filesystem I/O and must run off the async runtime.
pub(super) fn check_directory(directory: &Path) -> Result<(), String> {
    let metadata =
        std::fs::metadata(directory).map_err(|error| directory_error(directory, error))?;
    if !metadata.is_dir() {
        return Err(format!(
            "{} is not a folder on this computer",
            directory.display()
        ));
    }
    let mut entries =
        std::fs::read_dir(directory).map_err(|error| directory_error(directory, error))?;
    // Some platforms defer reading the directory until the first entry.
    if let Some(entry) = entries.next() {
        entry.map_err(|error| directory_error(directory, error))?;
    }
    Ok(())
}

fn directory_error(directory: &Path, error: std::io::Error) -> String {
    if error.kind() == std::io::ErrorKind::NotFound {
        return format!("{} is not a folder on this computer", directory.display());
    }
    let reason = format!(
        "Agent Relay could not read the working folder {}: {error}.",
        directory.display()
    );
    if error.kind() == std::io::ErrorKind::PermissionDenied {
        #[cfg(target_os = "macos")]
        return format!("{reason} Allow Agent Relay to access this folder in System Settings → Privacy & Security → Files and Folders, then retry.");
        #[cfg(not(target_os = "macos"))]
        return format!("{reason} Give the account running Agent Relay permission to read and search this folder, then retry.");
    }
    reason
}

impl Spawner for RegistrySpawner {
    fn available(&self) -> Vec<HarnessId> {
        self.0
            .adapters()
            .filter(|adapter| adapter.spawn().is_some() && adapter.detect() == Installed::Yes)
            .map(|adapter| adapter.descriptor().id)
            .collect()
    }

    fn unavailable_reason(&self, harness: HarnessId) -> Option<String> {
        let adapter = self.0.get(harness)?;
        adapter.spawn()?;
        match adapter.detect() {
            Installed::Unusable(reason) => Some(reason),
            Installed::Yes | Installed::No => None,
        }
    }

    fn launch(&self, launch: &Launch, started: Started) -> Result<Launched, LaunchError> {
        if !launch.directory.is_dir() {
            return Err(LaunchError::Failed(format!(
                "{} is not a folder on this computer",
                launch.directory.display()
            )));
        }
        let result = match self
            .0
            .get(launch.harness)
            .and_then(|adapter| adapter.spawn())
        {
            Some(facet) => facet.launch(launch, started),
            None => Err(LaunchError::Unavailable(format!(
                "this computer cannot spawn {} yet",
                launch.harness.label()
            ))),
        };
        if let Err(error) = &result {
            let reason = crate::relay::harness::diagnostics::redact(&error.code());
            if !reason.contains("argv=") {
                crate::relay::diagnostics::write(format_args!("Agent Relay {} launch failed: {reason}; argv=unavailable (preflight or managed session); exit_status=not observed; stderr_tail=unavailable",
                    launch.harness.name()));
            }
        }
        result
    }

    fn find(&self, intent: &super::intents::Intent) -> Option<(Target, Option<SpawnedProcess>)> {
        self.0.get(intent.harness)?.spawn()?.find(intent)
    }

    fn alive(&self, target: &Target, process: Option<&SpawnedProcess>) -> bool {
        self.0
            .spawner_of(target)
            .is_some_and(|facet| facet.alive(target, process))
    }

    fn stop(&self, target: &Target, process: Option<&SpawnedProcess>) {
        if let Some(facet) = self.0.spawner_of(target) {
            facet.stop(target, process);
        }
    }

    fn release(&self, target: &Target, process: Option<&SpawnedProcess>) -> Result<(), String> {
        match self.0.spawner_of(target) {
            Some(facet) => facet.release(target, process),
            // No harness here starts such a session: nothing of it to end.
            None => Ok(()),
        }
    }

    fn deliver(&self, target: &Target, message: &Message) -> Option<InjectOutcome> {
        self.0.spawner_of(target)?.deliver(target, message)
    }

    fn native_input(&self, target: &Target) -> bool {
        self.0
            .spawner_of(target)
            .is_some_and(|facet| facet.native_input(target))
    }

    fn poll_requests(&self, target: &Target) -> Option<bool> {
        self.0.spawner_of(target)?.poll_requests(target)
    }

    fn hands_over(&self, target: &Target) -> bool {
        self.handover(target).is_some()
    }

    fn transcript(&self, target: &Target, cursor: Option<&TranscriptCursor>) -> Option<Page> {
        Some(self.handover(target)?.transcript(target, cursor))
    }

    fn session(&self, target: &Target) -> Option<RunningSession> {
        self.handover(target)?.session(target)
    }
}

impl RegistrySpawner {
    fn handover(&self, target: &Target) -> Option<&dyn HandoverFacet> {
        self.0.spawner_of(target)?.handover()
    }
}

/// Makes the named pipe at `path`, replacing any file there. The one place
/// `mkfifo(3)` is called: std's `unix::fs::mkfifo` is not yet stable.
#[cfg(unix)]
fn make_fifo(path: &Path) -> std::io::Result<()> {
    use std::os::unix::ffi::OsStrExt;
    let _ = std::fs::remove_file(path);
    let path = std::ffi::CString::new(path.as_os_str().as_bytes())
        .map_err(|_| std::io::Error::other("a path with a NUL"))?;
    // SAFETY: `path` is a valid NUL-terminated string for the call.
    if unsafe { libc::mkfifo(path.as_ptr(), 0o600) } == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

/// Starts an agent in a new process session through a short-lived shell,
/// so it outlives a core restart, and returns its pid. With `scope` (the
/// `systemd-run` path and a unit name) the shell, and so everything it
/// starts, runs in that transient scope, outside the core's cgroup. Its input is `fifo`,
/// held open by a second shell that writes the first message and then
/// waits for Claude to exit, closing it would end the session, and then
/// removes it. Arguments
/// and the message are passed through `"$@"` and the environment, never
/// interpolated into shell text.
/// Makes the agent's input pipe and starts it on it. The holder unlinks the
/// pipe once the agent has ended, never here on success: until then the
/// core writes later turns into it (`harness::claude::channel`), from this
/// core or one started after it. A failed start removes it.
#[cfg(unix)]
pub(crate) fn start_with_input(
    scope: Option<(&Path, &str)>,
    executable: &Path,
    arguments: &[String],
    fifo: &Path,
    log: &Path,
    directory: &Path,
    environment: &BTreeMap<String, String>,
) -> Result<i32, String> {
    // A failed attempt removed its pipe, so a retry makes a fresh one.
    make_fifo(fifo).map_err(|error| format!("could not make its input: {error}"))?;
    let started = start_detached(
        scope,
        executable,
        arguments,
        fifo,
        log,
        directory,
        environment,
    );
    if started.is_err() {
        let _ = std::fs::remove_file(fifo);
    }
    started
}

/// The inputs this core holds for the agents it started on Windows, by the
/// `fifo` path their launch named (no file is made there), each written
/// with deadlines so an agent that stops reading holds up no other.
#[cfg(windows)]
type HeldInputs = std::collections::HashMap<
    PathBuf,
    std::sync::Arc<std::sync::Mutex<crate::platform::pipe::DeadlineWriter>>,
>;

/// How long the first message waits for room in the agent's input.
#[cfg(windows)]
const FIRST_INPUT_WAIT: std::time::Duration = std::time::Duration::from_secs(5);

#[cfg(windows)]
fn held_inputs() -> std::sync::MutexGuard<'static, HeldInputs> {
    static HELD: std::sync::OnceLock<std::sync::Mutex<HeldInputs>> = std::sync::OnceLock::new();
    HELD.get_or_init(Default::default)
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Whether this core holds the input named `fifo`: the agent started on it
/// still runs.
#[cfg(windows)]
pub(crate) fn holds_input(fifo: &Path) -> bool {
    held_inputs().contains_key(fifo)
}

/// Writes `bytes` whole into the input named `fifo`, beginning by `start`
/// and, once begun, finishing by `finish` (`DeadlineWriter::write_counted`).
/// `None` when this core holds no such input (the agent ended, or another
/// core started it); else, on failure, how much was written and why it
/// stopped. A write past its deadline returns `TimedOut`, its rest left to
/// the writer's own thread.
#[cfg(windows)]
pub(crate) fn write_input(
    fifo: &Path,
    bytes: &[u8],
    start: std::time::Instant,
    finish: std::time::Instant,
) -> Option<Result<(), crate::platform::pipe::Shortfall>> {
    let input = held_inputs().get(fifo).cloned()?;
    let mut input = input
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    Some(input.write_counted(bytes, start, finish))
}

/// Holds `input` as the input named `fifo`, as `start_with_input` does.
#[cfg(all(windows, test))]
pub(crate) fn hold_input(fifo: &Path, input: impl std::io::Write + Send + 'static) {
    held_inputs().insert(
        fifo.to_path_buf(),
        std::sync::Arc::new(std::sync::Mutex::new(
            crate::platform::pipe::DeadlineWriter::new(input),
        )),
    );
}

/// Lets go of the input named `fifo`.
#[cfg(all(windows, test))]
pub(crate) fn release_input(fifo: &Path) {
    held_inputs().remove(fifo);
}

/// The program to start for `executable` on Windows: an npm command shim
/// (`claude.cmd`) is resolved to what it runs (`node` and the script, or
/// the native program it names), so the pid reported is the agent's own and
/// not that of the `cmd.exe` running the shim, which is not the process
/// Claude publishes its session under. Anything else is started as is.
#[cfg(windows)]
fn direct_program(
    executable: &Path,
    arguments: &[String],
    environment: &BTreeMap<String, String>,
) -> (PathBuf, Vec<String>) {
    let path = environment
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("PATH"))
        .map(|(_, value)| std::ffi::OsStr::new(value.as_str()));
    match crate::platform::exe::shim_target(executable, path) {
        Some((program, mut leading)) => {
            leading.extend(arguments.iter().cloned());
            (program, leading)
        }
        None => (executable.to_path_buf(), arguments.to_vec()),
    }
}

/// Starts an agent that reads its input from a pipe, on Windows, and
/// returns its pid. Windows has no FIFO a later core could open, so `fifo`
/// is never made and the agent's input is an anonymous pipe this core
/// holds under that name (`holds_input`, `write_input`), the channel
/// `harness::claude::channel` writes later turns and the answers to
/// Claude's control requests (permission prompts) into, as on Unix. The
/// first message (`AGENT_RELAY_SPAWN_INPUT`) is its first line; a thread
/// waits for the agent to exit, then lets go of the input and records the
/// exit status beside the log (`.exit`). The agent is started directly,
/// never through a shell (an npm `.cmd` shim is resolved to what it runs),
/// in its own console process group without a window. Because the core
/// holds the input, an agent whose input ends with it (stream-json Claude)
/// ends when the core does. `scope` is a `systemd-run` scope, which Windows
/// has no counterpart for.
#[cfg(windows)]
pub(crate) fn start_with_input(
    scope: Option<(&Path, &str)>,
    executable: &Path,
    arguments: &[String],
    fifo: &Path,
    log: &Path,
    directory: &Path,
    environment: &BTreeMap<String, String>,
) -> Result<i32, String> {
    let _ = scope;
    let opened = |error: std::io::Error| format!("could not open its log: {error}");
    let output = std::fs::File::create(log).map_err(opened)?;
    let errors = output.try_clone().map_err(opened)?;
    let (program, arguments) = direct_program(executable, arguments, environment);
    let mut command = Command::new(&program);
    crate::relay::detach::new_session(&mut command);
    let mut child = command
        .args(&arguments)
        .current_dir(directory)
        .env_clear()
        .envs(environment)
        .stdin(Stdio::piped())
        .stdout(output)
        .stderr(errors)
        .spawn()
        .map_err(|error| error.to_string())?;
    let pid =
        i32::try_from(child.id()).map_err(|_| "its launcher did not report it".to_string())?;
    let fifo = fifo.to_path_buf();
    if let Some(input) = child.stdin.take() {
        held_inputs().insert(
            fifo.clone(),
            std::sync::Arc::new(std::sync::Mutex::new(
                crate::platform::pipe::DeadlineWriter::new(input),
            )),
        );
        if let Some(first) = environment.get("AGENT_RELAY_SPAWN_INPUT") {
            let by = std::time::Instant::now() + FIRST_INPUT_WAIT;
            let _ = write_input(&fifo, format!("{first}\n").as_bytes(), by, by);
        }
    }
    let exit_file = log.with_extension("exit");
    let held = fifo.clone();
    let watched = std::thread::Builder::new()
        .name("spawned-agent-input".into())
        .spawn(move || {
            let status = child.wait();
            held_inputs().remove(&held);
            if let Ok(status) = status {
                let code = status.code().unwrap_or(-1);
                let _ = crate::relay::detach::record_exit(&exit_file, &format!("{code}\n"));
            }
        });
    if let Err(error) = watched {
        held_inputs().remove(&fifo);
        return Err(format!("could not keep its input open: {error}"));
    }
    Ok(pid)
}

#[cfg(unix)]
fn start_detached(
    scope: Option<(&Path, &str)>,
    executable: &Path,
    arguments: &[String],
    fifo: &Path,
    log: &Path,
    directory: &Path,
    environment: &BTreeMap<String, String>,
) -> Result<i32, String> {
    const SCRIPT: &str = r#"umask 077
fifo=$1; log=$2; exit_file=$3; shift 3
(
"$@" <"$fifo" >"$log" 2>&1 &
agent=$!
(
  exec 3>"$fifo"
  printf '%s\n' "$AGENT_RELAY_SPAWN_INPUT" >&3
  while kill -0 "$agent" 2>/dev/null \
    && ! grep -qs ') [ZX] ' "/proc/$agent/stat"; do sleep 5; done
  rm -f "$fifo"
) </dev/null >/dev/null 2>&1 &
printf '%s\n' "$agent"
exec >/dev/null 2>&1
wait "$agent"
printf '%s\n' "$?" >"$exit_file.tmp" && command -p mv -f "$exit_file.tmp" "$exit_file"
) &"#;
    let mut command = match scope {
        Some((systemd_run, unit)) => {
            let mut command = Command::new(systemd_run);
            command.args(scope_arguments(unit)).arg("/bin/sh");
            command
        }
        None => Command::new("/bin/sh"),
    };
    crate::relay::detach::new_session(&mut command);
    let output = command
        .args(["-c", SCRIPT, "agent-relay-spawn"])
        .arg(fifo)
        .arg(log)
        .arg(log.with_extension("exit"))
        .arg(executable)
        .args(arguments.iter().map(OsString::from))
        .current_dir(directory)
        .env_clear()
        .envs(environment)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(crate::relay::harness::diagnostics::redact(&format!(
            "its launcher failed: exit_status={}; stderr_tail={}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        )));
    }
    std::str::from_utf8(&output.stdout)
        .ok()
        .and_then(|text| text.trim().parse::<i32>().ok())
        .filter(|pid| *pid > 1)
        .ok_or_else(|| "its launcher did not report it".into())
}

/// Ends `pid`, if it is still the process that started at `start`.
pub(crate) fn stop_process(table: &dyn ProcessTable, pid: i32, start: Option<u64>) {
    let same = match (table.process(pid), start) {
        (Some(info), Some(start)) => info.start == start,
        (Some(_), None) => true,
        (None, _) => false,
    };
    if same {
        // `SIGTERM`; Windows terminates it (it has no polite stop).
        crate::platform::process::terminate(pid as u32);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::relay::harness::claude::first_message;
    use std::time::{Duration, Instant};

    #[test]
    fn spawned_codex_driver_waits_use_the_router_and_takeover_revokes_authority() {
        use std::sync::atomic::{AtomicUsize, Ordering::SeqCst};
        struct BusySpawner(AtomicUsize);
        impl Spawner for BusySpawner {
            fn available(&self) -> Vec<HarnessId> {
                vec![]
            }
            fn launch(&self, _: &Launch, _: Started) -> Result<Launched, LaunchError> {
                unreachable!()
            }
            fn alive(&self, _: &Target, _: Option<&SpawnedProcess>) -> bool {
                true
            }
            fn stop(&self, _: &Target, _: Option<&SpawnedProcess>) {
                unreachable!()
            }
            fn deliver(&self, _: &Target, _: &Message) -> Option<InjectOutcome> {
                self.0.fetch_add(1, SeqCst);
                Some(InjectOutcome::WaitingForTurn("busy".into()))
            }
        }
        struct Router(AtomicUsize);
        impl Injector for Router {
            fn inject(&self, _: &Target, _: &str, _: &str) -> InjectOutcome {
                InjectOutcome::Delivered
            }
            fn final_answer(&self, _: &Target, _: &str) -> Option<String> {
                None
            }
            fn waiting_codex_turn(
                &self,
                registration: &Registration,
                id: &str,
                text: &str,
            ) -> Option<InjectOutcome> {
                assert!(registration.spawn.as_ref().unwrap().taken_over_at.is_none());
                assert_eq!((id, text), ("m", "peer message"));
                // Still waiting, then steered by stall recovery.
                Some(match self.0.fetch_add(1, SeqCst) {
                    0 => InjectOutcome::Waiting("tracked by router".into()),
                    _ => InjectOutcome::Delivered,
                })
            }
        }
        let spawner = BusySpawner(AtomicUsize::new(0));
        let router = Router(AtomicUsize::new(0));
        let mut registration: Registration = serde_json::from_value(serde_json::json!({
            "name": "spawned", "agentID": "a", "target": {"kind": "codex", "id": "thread"},
            "title": "worker", "baseURL": "https://example.test", "registeredAt": "2026-10-21T00:00:00Z",
            "spawn": {"nodeID": "node", "nodeName": "desktop", "invocationID": "i", "harness": "codex"}
        })).unwrap();
        let route = DeliveryRoute {
            delivery_id: "d",
            message_id: "m",
            ..DeliveryRoute::default()
        };
        // A router wait keeps the turn's acceptance, so the reply
        // permission stays; only a recovery outcome replaces it.
        assert_eq!(
            spawner.deliver_registered(&router, &registration, &route, "peer message"),
            InjectOutcome::WaitingForTurn("busy".into())
        );
        assert_eq!(
            spawner.deliver_registered(&router, &registration, &route, "peer message"),
            InjectOutcome::Delivered
        );
        registration.spawn.as_mut().unwrap().taken_over_at = Some("2026-10-21T01:00:00Z".into());
        assert_eq!(
            spawner.deliver_registered(&router, &registration, &route, "peer message"),
            InjectOutcome::Delivered
        );
        assert_eq!(spawner.0.load(SeqCst), 2);
        assert_eq!(router.0.load(SeqCst), 2);
    }

    #[test]
    fn a_working_folder_must_be_readable_not_just_present() {
        let folder = tempfile::tempdir().unwrap();
        assert_eq!(check_directory(folder.path()), Ok(()));
        let file = folder.path().join("file");
        std::fs::write(&file, "").unwrap();
        assert!(check_directory(&file)
            .unwrap_err()
            .contains("is not a folder"));
        assert!(check_directory(&folder.path().join("missing"))
            .unwrap_err()
            .contains("is not a folder"));

        // Root bypasses mode bits. The error mapping is also checked below,
        // including EPERM (the macOS privacy denial) and EACCES. Windows has
        // no mode bits to deny reading with.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if unsafe { libc::geteuid() } == 0 {
                return;
            }
            std::fs::set_permissions(folder.path(), std::fs::Permissions::from_mode(0o111))
                .unwrap();
            assert!(folder.path().is_dir());
            let denied = check_directory(folder.path());
            std::fs::set_permissions(folder.path(), std::fs::Permissions::from_mode(0o700))
                .unwrap();
            assert!(denied
                .unwrap_err()
                .contains("could not read the working folder"));
        }
    }

    #[cfg(windows)]
    #[test]
    fn a_windows_access_denial_explains_access() {
        // ERROR_ACCESS_DENIED.
        let error = directory_error(
            Path::new(r"C:\work\project"),
            std::io::Error::from_raw_os_error(5),
        );
        assert!(error.contains(r"C:\work\project"));
        assert!(error.contains("permission to read and search this folder"));
        let error = directory_error(Path::new(r"C:\work\project"), std::io::Error::other("disk"));
        assert!(error.contains("could not read the working folder"));
        assert!(!error.contains("permission"));
    }

    #[cfg(windows)]
    #[test]
    fn a_windows_agent_reads_its_first_message_from_the_held_input() {
        let folder = tempfile::tempdir().unwrap();
        let fifo = folder.path().join("in");
        let log = folder.path().join("out");
        let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
        let mut environment: BTreeMap<String, String> = BTreeMap::new();
        environment.insert("SystemRoot".into(), root.clone());
        environment.insert("AGENT_RELAY_SPAWN_INPUT".into(), first_message("hello"));
        // `set /p` stands in for the agent: it reads the first line and exits.
        let pid = start_with_input(
            None,
            &Path::new(&root).join(r"System32\cmd.exe"),
            &[
                "/V:ON".into(),
                "/D".into(),
                "/C".into(),
                "set /p line=&echo !line!".into(),
            ],
            &fifo,
            &log,
            folder.path(),
            &environment,
        )
        .unwrap();
        assert!(pid > 0);
        let deadline = Instant::now() + Duration::from_secs(10);
        while !log.with_extension("exit").exists() {
            assert!(Instant::now() < deadline, "the agent never read its input");
            std::thread::sleep(Duration::from_millis(50));
        }
        assert_eq!(
            std::fs::read_to_string(&log).unwrap().trim(),
            first_message("hello")
        );
        assert!(!fifo.exists(), "Windows makes no input file");
        let missing = folder.path().join("no-such-folder");
        assert!(start_with_input(
            None,
            &Path::new(&root).join(r"System32\cmd.exe"),
            &[],
            &fifo,
            &log,
            &missing,
            &environment,
        )
        .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn permission_denials_explain_access_instead_of_descriptor_limits() {
        for errno in [libc::EACCES, libc::EPERM] {
            let error = directory_error(
                Path::new("/work/project"),
                std::io::Error::from_raw_os_error(errno),
            );
            assert!(error.contains("/work/project"));
            assert!(!error.contains("not a folder"));
            assert!(!error.contains("ulimit"));
            #[cfg(target_os = "macos")]
            assert!(error.contains("System Settings → Privacy & Security → Files and Folders"));
            #[cfg(not(target_os = "macos"))]
            assert!(error.contains("permission to read and search this folder"));
        }
        let error = directory_error(
            Path::new("/work/project"),
            std::io::Error::from_raw_os_error(libc::EIO),
        );
        assert!(error.contains("could not read the working folder"));
        assert!(!error.contains("permission"));
    }

    #[test]
    fn a_scope_is_used_only_where_a_user_manager_runs() {
        let env = |runtime: Option<&'static str>| {
            move |key: &str| {
                (key == "XDG_RUNTIME_DIR")
                    .then_some(runtime)
                    .flatten()
                    .map(String::from)
            }
        };
        let all = |_: &Path| true;
        let found = systemd_run(&env(Some("/run/user/1000")), &all);
        if cfg!(target_os = "linux") {
            assert_eq!(found, Some(PathBuf::from("/usr/bin/systemd-run")));
            let no_manager = |path: &Path| !path.ends_with("systemd/private");
            assert_eq!(systemd_run(&env(Some("/run/user/1000")), &no_manager), None);
            assert_eq!(systemd_run(&env(None), &all), None);
        } else {
            assert_eq!(found, None);
        }
    }

    #[test]
    fn a_scope_is_named_for_the_session_and_runs_the_command_in_place() {
        assert_eq!(
            scope_unit("2d4f3d2b-85ba_45d7"),
            "agent-relay-spawn-2d4f3d2b-85ba-45d7"
        );
        let arguments = scope_arguments("agent-relay-spawn-x");
        assert_eq!(&arguments[..2], ["--user", "--scope"]);
        assert!(arguments.contains(&"--unit=agent-relay-spawn-x".to_string()));
        assert_eq!(arguments.last().map(String::as_str), Some("--"));
    }

    #[cfg(unix)]
    #[test]
    fn a_launched_shell_reports_the_agent_and_feeds_it_the_first_message() {
        let folder = tempfile::tempdir().unwrap();
        let fifo = folder.path().join("in");
        let log = folder.path().join("out");
        make_fifo(&fifo).unwrap();
        let mut environment: BTreeMap<String, String> = BTreeMap::new();
        environment.insert("PATH".into(), "/usr/bin:/bin".into());
        environment.insert("AGENT_RELAY_SPAWN_INPUT".into(), first_message("hello"));
        // `head -n 1` stands in for the agent: it reads the first line and exits.
        let pid = start_detached(
            None,
            Path::new("/usr/bin/head"),
            &["-n".into(), "1".into()],
            &fifo,
            &log,
            folder.path(),
            &environment,
        )
        .unwrap();
        assert!(pid > 1);
        let deadline = Instant::now() + Duration::from_secs(10);
        while std::fs::read_to_string(&log).unwrap_or_default().is_empty() {
            assert!(Instant::now() < deadline, "the agent never read its input");
            std::thread::sleep(Duration::from_millis(50));
        }
        let written = std::fs::read_to_string(&log).unwrap();
        assert_eq!(written.trim(), first_message("hello"));
    }

    #[cfg(unix)]
    #[test]
    fn each_agent_gets_its_input_however_its_pipe_opens_race_the_launcher() {
        // The pipe was once unlinked when the starter shell exited, before
        // the agent and its holder had opened it in the background; some
        // agents then never got their input.
        let folder = tempfile::tempdir().unwrap();
        let mut environment: BTreeMap<String, String> = BTreeMap::new();
        environment.insert("PATH".into(), "/usr/bin:/bin".into());
        environment.insert("AGENT_RELAY_SPAWN_INPUT".into(), first_message("hello"));
        let runs: Vec<_> = (0..20)
            .map(|run| {
                let fifo = folder.path().join(format!("{run}.input"));
                let log = folder.path().join(format!("{run}.out"));
                start_with_input(
                    None,
                    Path::new("/usr/bin/head"),
                    &["-n".into(), "1".into()],
                    &fifo,
                    &log,
                    folder.path(),
                    &environment,
                )
                .unwrap();
                (fifo, log)
            })
            .collect();
        let deadline = Instant::now() + Duration::from_secs(20);
        for (fifo, log) in runs {
            while std::fs::read_to_string(&log).unwrap_or_default().is_empty() || fifo.exists() {
                assert!(
                    Instant::now() < deadline,
                    "{} never read its input or its pipe was left behind",
                    log.display()
                );
                std::thread::sleep(Duration::from_millis(20));
            }
            assert_eq!(
                std::fs::read_to_string(&log).unwrap().trim(),
                first_message("hello")
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_failed_scoped_start_stops_its_scope_before_starting_without_one() {
        use std::os::unix::fs::PermissionsExt;
        let bin = tempfile::tempdir().unwrap();
        let log = bin.path().join("systemctl.log");
        let systemctl = bin.path().join("systemctl");
        std::fs::write(
            &systemctl,
            format!("#!/bin/sh\necho \"$*\" >> '{}'\n", log.display()),
        )
        .unwrap();
        std::fs::set_permissions(&systemctl, std::fs::Permissions::from_mode(0o755)).unwrap();
        let systemd_run = bin.path().join("systemd-run");
        let attempts = std::sync::Mutex::new(Vec::new());
        let started = start_scoped_or_plain(&systemd_run, "agent-relay-spawn-s1", |scope| {
            let scoped = scope.is_some();
            // The scope must already be stopped when the plain start runs.
            attempts
                .lock()
                .unwrap()
                .push((scoped, std::fs::read_to_string(&log).unwrap_or_default()));
            if scoped {
                Err("its launcher failed".into())
            } else {
                Ok(42)
            }
        });
        assert_eq!(started, Ok(42));
        let attempts = attempts.into_inner().unwrap();
        assert_eq!(attempts.len(), 2);
        assert_eq!(attempts[0], (true, String::new()));
        assert_eq!(
            attempts[1],
            (
                false,
                "--user stop agent-relay-spawn-s1.scope\n".to_string()
            )
        );

        // A scoped start that works stops nothing.
        std::fs::remove_file(&log).unwrap();
        assert_eq!(
            start_scoped_or_plain(&systemd_run, "agent-relay-spawn-s2", |_| Ok(7)),
            Ok(7)
        );
        assert!(!log.exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_failed_start_removes_its_input_pipe() {
        let folder = tempfile::tempdir().unwrap();
        let fifo = folder.path().join("in");
        let missing = folder.path().join("no-such-folder");
        let started = start_with_input(
            None,
            Path::new("/usr/bin/head"),
            &[],
            &fifo,
            &folder.path().join("out"),
            &missing,
            &BTreeMap::new(),
        );
        assert!(started.is_err());
        assert!(std::fs::symlink_metadata(&fifo).is_err());
    }

    mod registry {
        use super::super::*;
        use crate::relay::harness::fake::FakeAdapter;
        use crate::relay::harness::{claude, codex, HarnessAdapter, Installed, Registry};
        use crate::relay::store::SessionKind;
        use std::sync::Arc;

        fn registry(
            codex: FakeAdapter,
            claude: FakeAdapter,
        ) -> (RegistrySpawner, [Arc<FakeAdapter>; 2]) {
            let (codex, claude) = (Arc::new(codex), Arc::new(claude));
            let adapters: Vec<Arc<dyn HarnessAdapter>> = vec![codex.clone(), claude.clone()];
            (RegistrySpawner(Registry::new(adapters)), [codex, claude])
        }

        fn fakes() -> (FakeAdapter, FakeAdapter) {
            (
                FakeAdapter::new(&codex::DESCRIPTOR, SessionKind::Codex),
                FakeAdapter::new(&claude::DESCRIPTOR, SessionKind::ClaudeTerminal),
            )
        }

        fn launch(harness: crate::relay::harness::HarnessId, directory: &Path) -> Launch {
            Launch {
                harness,
                name: "w1".into(),
                text: "hi".into(),
                directory: directory.to_path_buf(),
                full_access: true,
                message_id: "m1".into(),
                session_id: "s1".into(),
            }
        }

        #[test]
        fn installed_spawning_harnesses_are_offered_in_order() {
            let (codex_fake, claude_fake) = fakes();
            assert_eq!(
                registry(codex_fake, claude_fake).0.available(),
                [codex::ID, claude::ID]
            );
            let (mut codex_fake, mut claude_fake) = fakes();
            codex_fake.installed = Installed::Unusable("no daemon".into());
            claude_fake.installed = Installed::No;
            let (spawner, _) = registry(codex_fake, claude_fake);
            assert!(spawner.available().is_empty());
            assert_eq!(
                spawner.unavailable_reason(codex::ID).as_deref(),
                Some("no daemon")
            );
            assert_eq!(spawner.unavailable_reason(claude::ID), None);
            // Known, installed, but without a spawn facet: not offered.
            let (codex_fake, mut claude_fake) = fakes();
            claude_fake.spawns = false;
            let (spawner, _) = registry(codex_fake, claude_fake);
            assert_eq!(spawner.available(), [codex::ID]);
        }

        #[test]
        fn a_launch_goes_to_its_harness_and_a_session_to_its_owner() {
            let folder = tempfile::tempdir().unwrap();
            let (codex_fake, mut claude_fake) = fakes();
            claude_fake.spawns = false;
            let (spawner, [codex_fake, _]) = registry(codex_fake, claude_fake);
            let missing = folder.path().join("missing");
            assert!(matches!(
                spawner.launch(&launch(codex::ID, &missing), &|_, _| {}),
                Err(LaunchError::Failed(reason)) if reason.contains("is not a folder")
            ));
            assert!(matches!(
                spawner.launch(&launch(claude::ID, folder.path()), &|_, _| {}),
                Err(LaunchError::Unavailable(reason)) if reason == "this computer cannot spawn Claude yet"
            ));
            let launched = spawner
                .launch(&launch(codex::ID, folder.path()), &|_, _| {})
                .unwrap();
            assert_eq!(launched.target, Target::new(SessionKind::Codex, "s1"));
            assert_eq!(codex_fake.launched.lock().unwrap().len(), 1);
            assert!(spawner.alive(&launched.target, None));
            spawner.stop(&launched.target, None);
            assert!(!spawner.alive(&launched.target, None));
            assert_eq!(*codex_fake.stopped.lock().unwrap(), [launched.target]);
            // A session no harness here started is neither alive nor stopped.
            let grok = Target::new(SessionKind::Grok, "g1");
            assert!(!spawner.alive(&grok, None));
            spawner.stop(&grok, None);
            assert_eq!(codex_fake.stopped.lock().unwrap().len(), 1);
        }
    }
}
