//! The probe's own capture and upload, supervised from inside the daemon.
//!
//! The uploader commands (`installs`, `status`, `start`, `pause`, …) are the
//! probe's `--json` commands, run as child processes of this very binary
//! (`ProcessRunner`): the daemon is the probe, so there is no version skew,
//! and a separate process is what those commands are built as. Each one
//! holds the install's file locks for its life and releases them by
//! exiting; its result is one JSON line on stdout and its error one safe
//! sentence on stderr; `start` and sharing changes launch or replace the
//! detached collector; and a command that outlives its deadline, or one
//! still running when the person signs out, is stopped by signal, which a
//! call into the same process could not be. A store migration that aborts
//! takes down that command, never delivery.
//!
//! `Uploader` keeps the attached install, adds `needs_start` and `stage` to
//! `status`, and every 60 s starts the collector again when it stopped or
//! runs a build older than this one.

use crate::relay::protocol::{ErrorKind, RpcError};
use crate::relay::workspace::Secret;
use futures_util::future::{BoxFuture, FutureExt, Shared};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, BufReader};
use tokio::sync::mpsc;

mod refresh;
use refresh::{session_page, Changing};
pub use refresh::{with_derived, HistoryReader};
mod supervision;

/// How long each command may run. `None` waits for the command to finish:
/// a sharing change waits until its durable stop request is consumed and
/// then restarts the collector, so killing it on a deadline would leave
/// uploads stopped with nobody to restart them; `reclaim` may be migrating
/// a store, which commits only at the end.
pub mod timeouts;

/// How often the attached collector is checked and restarted.
pub const SUPERVISE_EVERY: Duration = Duration::from_secs(60);

/// The default number of sessions `uploader.sessions.list` returns.
pub const SESSION_LIST_LIMIT: usize = 500;

/// Why an uploader command failed. `message` is the probe's own safe
/// sentence or one of this module's.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UploaderError {
    pub message: String,
    /// Stopped because the person signed out or cancelled.
    pub cancelled: bool,
}

impl UploaderError {
    pub fn new(message: impl Into<String>) -> UploaderError {
        UploaderError {
            message: message.into(),
            cancelled: false,
        }
    }

    fn cancelled() -> UploaderError {
        UploaderError {
            message: "The uploader operation was cancelled.".into(),
            cancelled: true,
        }
    }

    /// The probe refused to set up until older upload schedules are
    /// checked; `acknowledge_uninspected_schedules` retries past that.
    pub fn needs_schedule_acknowledgement(&self) -> bool {
        self.message.contains("--acknowledge-uninspected-schedules")
    }
}

impl std::fmt::Display for UploaderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl From<UploaderError> for RpcError {
    fn from(error: UploaderError) -> RpcError {
        let kind = if error.message == crate::history_access::RESET_BUSY {
            ErrorKind::Busy
        } else {
            ErrorKind::UploaderFailed
        };
        RpcError::new(kind, error.message)
    }
}

/// The error when this binary cannot be run.
pub const MISSING: &str = "Agent Relay could not find its helper program.";
const BAD_OUTPUT: &str = "Agent Relay could not read the helper's answer.";
const FAILED: &str = "Agent Relay's helper reported a problem.";

/// A command's answer as the bridge type it stands for.
pub fn read_answer<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, RpcError> {
    serde_json::from_value(value).map_err(|_| UploaderError::new(BAD_OUTPUT).into())
}

/// What the probe says when a command runs out of time.
pub fn timeout_message(command: &str) -> &'static str {
    match command {
        "disconnect" => "Logging out took too long. Please try again; Agent Relay has not confirmed that this computer is disconnected.",
        "compact" => "Compacting the upload journal took too long. Records removed so far are kept; try again.",
        "start" => "Starting the uploader took too long. Agent Relay will try again shortly.",
        "retry" => "Retrying uploads took too long. Queued records are preserved; try again.",
        _ => "Reading upload status took too long. Your history may still be preparing. Try refreshing again.",
    }
}

/// The sentence to show from a command's stderr: the probe prints one safe
/// sentence, so the last non-empty line.
pub fn stderr_message(stderr: &str, fallback: &str) -> String {
    stderr
        .lines()
        .map(str::trim)
        .rfind(|line| !line.is_empty())
        .unwrap_or(fallback)
        .to_string()
}

/// One JSON object from a command's stdout: the whole output, else its last
/// line (a stray leading line is tolerated).
pub fn decode_output(stdout: &str) -> Option<Value> {
    if let Ok(value @ Value::Object(_)) = serde_json::from_str::<Value>(stdout) {
        return Some(value);
    }
    let last = stdout
        .lines()
        .map(str::trim)
        .rfind(|line| !line.is_empty())?;
    match serde_json::from_str::<Value>(last) {
        Ok(value @ Value::Object(_)) => Some(value),
        _ => None,
    }
}

/// A running `cloud install --json`: its NDJSON events, then its outcome.
pub struct InstallRun {
    pub events: mpsc::UnboundedReceiver<Value>,
    pub finished: tokio::sync::oneshot::Receiver<Result<(), UploaderError>>,
    /// Stops the install; the outcome is then `cancelled`.
    pub cancel: Box<dyn FnOnce() + Send>,
}

/// Runs the probe's commands.
pub trait ProbeRunner: Send + Sync + 'static {
    /// The same home-scoped lock namespace used by reset helpers.
    fn history_access_root(&self) -> Option<PathBuf> {
        None
    }

    /// Runs one `--json` command and returns its object.
    fn run(
        &self,
        args: Vec<String>,
        timeout: Option<Duration>,
    ) -> BoxFuture<'_, Result<Value, UploaderError>>;

    /// Starts `cloud install`, with the person's Cloud bearer when one is
    /// already at hand (otherwise the probe runs its own device sign-in).
    fn install(
        &self,
        args: Vec<String>,
        bearer: Option<Secret>,
    ) -> Result<InstallRun, UploaderError>;

    /// Stops every command in flight and refuses those queued before this
    /// call, so nothing started before a sign-out runs after it.
    fn cancel_all(&self) -> BoxFuture<'_, Result<(), UploaderError>>;
}

/// Runs this binary's own commands as child processes.
pub struct ProcessRunner {
    executable: PathBuf,
    /// Set on every command (and so on the collectors they start).
    env: Vec<(String, std::ffi::OsString)>,
    generation: AtomicU64,
    next: AtomicU64,
    children: Arc<Mutex<HashMap<u64, u32>>>,
}

impl ProcessRunner {
    pub fn new(executable: PathBuf) -> ProcessRunner {
        ProcessRunner {
            executable,
            env: Vec::new(),
            generation: AtomicU64::new(0),
            next: AtomicU64::new(0),
            children: Arc::default(),
        }
    }

    /// Sets `key` for every command.
    pub fn with_env(mut self, key: &str, value: impl Into<std::ffi::OsString>) -> ProcessRunner {
        self.env.push((key.into(), value.into()));
        self
    }

    fn command(&self, args: &[String]) -> tokio::process::Command {
        let mut command = tokio::process::Command::new(&self.executable);
        command
            .envs(self.env.iter().map(|(k, v)| (k, v)))
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        crate::platform::process::hide_window_tokio(&mut command);
        command
    }

    /// Spawns `command` unless a cancel happened since `generation`, and
    /// records it so a cancel can stop it.
    fn spawn(
        &self,
        mut command: tokio::process::Command,
        generation: u64,
    ) -> Result<(tokio::process::Child, Registration), UploaderError> {
        let mut children = self.children.lock().unwrap();
        if self.generation.load(Ordering::SeqCst) != generation {
            return Err(UploaderError::cancelled());
        }
        let child = command.spawn().map_err(|_| UploaderError::new(MISSING))?;
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        if let Some(pid) = child.id() {
            children.insert(id, pid);
        }
        Ok((
            child,
            Registration {
                id,
                children: self.children.clone(),
            },
        ))
    }
}

/// A child's place in the registry, removed when its command is done.
struct Registration {
    id: u64,
    children: Arc<Mutex<HashMap<u64, u32>>>,
}

impl Drop for Registration {
    fn drop(&mut self) {
        self.children.lock().unwrap().remove(&self.id);
    }
}

/// Sends `signal` to `pid`: a child the uploader spawned and has not yet
/// reaped (its registration is removed after `wait`), or a spawned agent
/// checked to be the process that started (`spawn::launch`).
#[cfg(unix)]
pub(crate) fn signal(pid: u32, signal: libc::c_int) {
    // SAFETY: `kill` takes plain integers and touches no memory; each caller
    // names a process it started.
    unsafe {
        libc::kill(pid as libc::pid_t, signal);
    }
}

/// Windows has no signals: any `signal` terminates `pid`
/// (`platform::process::terminate`), which every caller's next step after
/// `SIGTERM` (waiting, then killing) still expects.
#[cfg(windows)]
pub(crate) fn signal(pid: u32, signal: libc::c_int) {
    let _ = signal;
    crate::platform::process::terminate(pid);
}

/// A pipe being read in the background: at most `limit` bytes are kept,
/// the rest discarded so the writer never blocks.
struct Capture {
    kept: Arc<Mutex<Vec<u8>>>,
    task: tokio::task::JoinHandle<()>,
}

impl Capture {
    fn start(reader: Option<impl AsyncRead + Unpin + Send + 'static>, limit: usize) -> Capture {
        let kept = Arc::new(Mutex::new(Vec::new()));
        let sink = kept.clone();
        let task = tokio::spawn(async move {
            let Some(mut reader) = reader else { return };
            let mut buffer = [0u8; 8192];
            loop {
                match reader.read(&mut buffer).await {
                    Ok(0) | Err(_) => break,
                    Ok(count) => {
                        let mut kept = sink.lock().unwrap();
                        let room = limit.saturating_sub(kept.len());
                        kept.extend_from_slice(&buffer[..count.min(room)]);
                    }
                }
            }
        });
        Capture { kept, task }
    }

    /// What was read, once the pipe closed or a second passed: a
    /// descendant that inherited the pipe (the detached collector) can keep
    /// it open long after the command itself exited.
    async fn finish(self) -> String {
        let mut task = self.task;
        let _ = tokio::time::timeout(Duration::from_secs(1), &mut task).await;
        task.abort();
        let kept = self.kept.lock().unwrap();
        String::from_utf8_lossy(&kept).into_owned()
    }
}

/// Waits for `child`; past `timeout`, asks it to stop, then kills it.
async fn wait_bounded(
    child: &mut tokio::process::Child,
    timeout: Option<Duration>,
) -> Option<std::process::ExitStatus> {
    let waited = match timeout {
        Some(timeout) => tokio::time::timeout(timeout, child.wait()).await.ok(),
        None => Some(child.wait().await),
    };
    if let Some(status) = waited {
        return status.ok();
    }
    if let Some(pid) = child.id() {
        signal(pid, libc::SIGTERM);
    }
    if tokio::time::timeout(Duration::from_secs(1), child.wait())
        .await
        .is_err()
    {
        let _ = child.kill().await;
    }
    None
}

impl ProbeRunner for ProcessRunner {
    fn history_access_root(&self) -> Option<PathBuf> {
        refresh::history_access_root(&self.env)
    }

    fn run(
        &self,
        args: Vec<String>,
        timeout: Option<Duration>,
    ) -> BoxFuture<'_, Result<Value, UploaderError>> {
        Box::pin(async move {
            let generation = self.generation.load(Ordering::SeqCst);
            let (mut child, registration) = self.spawn(self.command(&args), generation)?;
            let stdout = Capture::start(child.stdout.take(), 16 * 1024 * 1024);
            let stderr = Capture::start(child.stderr.take(), 64 * 1024);
            let status = wait_bounded(&mut child, timeout).await;
            drop(registration);
            let (stdout, stderr) = (stdout.finish().await, stderr.finish().await);
            if self.generation.load(Ordering::SeqCst) != generation {
                return Err(UploaderError::cancelled());
            }
            let Some(status) = status else {
                let command = args.first().map(String::as_str).unwrap_or_default();
                return Err(UploaderError::new(timeout_message(command)));
            };
            if !status.success() {
                return Err(UploaderError::new(stderr_message(&stderr, FAILED)));
            }
            decode_output(&stdout).ok_or_else(|| UploaderError::new(BAD_OUTPUT))
        })
    }

    fn install(
        &self,
        args: Vec<String>,
        bearer: Option<Secret>,
    ) -> Result<InstallRun, UploaderError> {
        let mut command = self.command(&args);
        if let Some(bearer) = bearer {
            command.env("CLOUD_API_ACCESS_TOKEN", bearer.expose());
        }
        let generation = self.generation.load(Ordering::SeqCst);
        let (mut child, registration) = self.spawn(command, generation)?;
        let pid = child.id();
        let stdout = child.stdout.take();
        let stderr = Capture::start(child.stderr.take(), 64 * 1024);
        let (events, receiver) = mpsc::unbounded_channel();
        let (done, finished) = tokio::sync::oneshot::channel();
        let (stop, mut stopped) = tokio::sync::oneshot::channel::<()>();
        tokio::spawn(async move {
            let reader = tokio::spawn(async move {
                let Some(stdout) = stdout else { return };
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if let Ok(event @ Value::Object(_)) = serde_json::from_str::<Value>(&line) {
                        let _ = events.send(event);
                    }
                }
            });
            let mut cancelled = false;
            let status = tokio::select! {
                status = child.wait() => status.ok(),
                _ = &mut stopped => {
                    cancelled = true;
                    if let Some(pid) = pid {
                        signal(pid, libc::SIGTERM);
                    }
                    match tokio::time::timeout(Duration::from_secs(1), child.wait()).await {
                        Ok(status) => status.ok(),
                        Err(_) => {
                            let _ = child.kill().await;
                            None
                        }
                    }
                }
            };
            drop(registration);
            // Every event the probe wrote before exiting is delivered first.
            let _ = tokio::time::timeout(Duration::from_secs(1), reader).await;
            let stderr = stderr.finish().await;
            let outcome = match status {
                _ if cancelled => Err(UploaderError::cancelled()),
                Some(status) if status.success() => Ok(()),
                Some(status) if status.code().is_none() => Err(UploaderError::cancelled()),
                _ => Err(UploaderError::new(stderr_message(
                    &stderr,
                    "Agent Relay could not finish signing in. Please try again.",
                ))),
            };
            let _ = done.send(outcome);
        });
        Ok(InstallRun {
            events: receiver,
            finished,
            cancel: Box::new(move || {
                let _ = stop.send(());
            }),
        })
    }

    fn cancel_all(&self) -> BoxFuture<'_, Result<(), UploaderError>> {
        Box::pin(async move {
            let pending: Vec<u32> = {
                let children = self.children.lock().unwrap();
                self.generation.fetch_add(1, Ordering::SeqCst);
                children.values().copied().collect()
            };
            let alive = || {
                let children = self.children.lock().unwrap();
                pending
                    .iter()
                    .filter(|pid| children.values().any(|p| p == *pid))
                    .copied()
                    .collect::<Vec<_>>()
            };
            for pid in &pending {
                signal(*pid, libc::SIGTERM);
            }
            for round in 0..200 {
                let remaining = alive();
                if remaining.is_empty() {
                    return Ok(());
                }
                if round == 100 {
                    for pid in remaining {
                        crate::platform::process::kill(pid);
                    }
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            Err(UploaderError::new(
                "Could not stop the previous uploader operation. Please try again.",
            ))
        })
    }
}

/// `--site-url/--account/--workspace`, the install a command acts on.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Target {
    pub site_url: String,
    pub account_id: Option<String>,
    pub workspace_id: Option<String>,
}

impl Target {
    pub fn arguments(&self) -> Vec<String> {
        let mut args = vec!["--site-url".to_string(), self.site_url.clone()];
        if let Some(account) = self.account_id.as_ref().filter(|a| !a.is_empty()) {
            args.extend(["--account".to_string(), account.clone()]);
        }
        if let Some(workspace) = self.workspace_id.as_ref().filter(|w| !w.is_empty()) {
            args.extend(["--workspace".to_string(), workspace.clone()]);
        }
        args
    }
}

/// Which local sessions are uploaded.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
#[schemars(extend("x-fallback" = "selected"))]
pub enum SharingMode {
    All,
    New,
    Selected,
}

impl SharingMode {
    pub fn as_str(self) -> &'static str {
        match self {
            SharingMode::All => "all",
            SharingMode::New => "new",
            SharingMode::Selected => "selected",
        }
    }

    pub fn install_flag(self) -> &'static str {
        match self {
            SharingMode::All => "--include-existing",
            SharingMode::New => "--new-sessions-only",
            SharingMode::Selected => "--selected-sessions-only",
        }
    }
}

/// The argument vectors for the probe's bridge commands.
pub mod command {
    use super::{SharingMode, Target};

    fn with(name: &[&str], target: &Target, tail: &[&str]) -> Vec<String> {
        name.iter()
            .map(|s| s.to_string())
            .chain(target.arguments())
            .chain(tail.iter().map(|s| s.to_string()))
            .collect()
    }

    pub fn installs() -> Vec<String> {
        vec!["installs".into(), "--json".into()]
    }

    pub fn reclaim() -> Vec<String> {
        vec!["reclaim".into(), "--json".into()]
    }

    /// The apps' sign-in: `mode` is the choice for a new install, and an
    /// install already set up for the workspace keeps its saved choice
    /// (`--keep-saved-sharing`), so signing in again reconnects it.
    pub fn cloud_install(target: &Target, mode: SharingMode, acknowledge: bool) -> Vec<String> {
        let mut args = with(
            &["cloud", "install"],
            target,
            &["--json", mode.install_flag(), "--keep-saved-sharing"],
        );
        if acknowledge {
            args.push("--acknowledge-uninspected-schedules".into());
        }
        args
    }

    pub fn simple(name: &str, target: &Target) -> Vec<String> {
        with(&[name], target, &["--json"])
    }

    pub fn sessions_preview(refresh: bool, limit: usize) -> Vec<String> {
        let mut args: Vec<String> = ["sessions", "preview", "--json", "--limit"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        args.push(limit.to_string());
        if refresh {
            args.push("--refresh".into());
        }
        args
    }

    pub fn sessions_list(target: &Target, limit: usize) -> Vec<String> {
        let limit = limit.to_string();
        with(
            &["sessions", "list"],
            target,
            &["--json", "--limit", &limit],
        )
    }

    pub fn sessions_catalog(target: &Target, limit: usize) -> Vec<String> {
        let mut args = sessions_list(target, limit);
        args.push("--catalog-only".into());
        args
    }

    pub fn sessions_reset(target: &Target, confirmation: &str) -> Vec<String> {
        with(
            &["sessions", "reset"],
            target,
            &["--json", "--confirmation", confirmation],
        )
    }

    pub fn sessions_delete(target: &Target, keys: &[String]) -> Vec<String> {
        let mut args = with(&["sessions", "delete"], target, &["--json"]);
        for key in keys {
            args.extend(["--session".to_string(), key.clone()]);
        }
        args
    }

    pub fn sessions_change(include: bool, target: &Target, keys: &[String]) -> Vec<String> {
        let verb = if include { "include" } else { "exclude" };
        let mut args = with(&["sessions", verb], target, &["--json"]);
        for key in keys {
            args.extend(["--session".to_string(), key.clone()]);
        }
        args
    }

    pub fn sharing_set(target: &Target, mode: SharingMode) -> Vec<String> {
        with(
            &["sharing", "set"],
            target,
            &["--mode", mode.as_str(), "--json"],
        )
    }
}

/// The upload state a person is shown, derived from one `status` answer:
/// `not_running`, `paused`, `needs_attention`, `offline`, `preparing`,
/// `uploading` or `up_to_date`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-fallback" = "offline"))]
pub enum Stage {
    NotRunning,
    Paused,
    NeedsAttention,
    Conflict,
    Offline,
    Preparing,
    Uploading,
    UpToDate,
}

const LOCAL_STORAGE_FAILURES: [&str; 6] = [
    "retention_limit",
    "database_corrupt",
    "database_unavailable",
    "disk_full",
    "database_busy",
    "permission_denied",
];

/// What a `delivery.failure` says: the probe sends a sentence, or an object
/// carrying one.
pub fn failure_message(failure: &Value) -> Option<String> {
    match failure {
        Value::Null => None,
        Value::String(text) => Some(text.clone()),
        Value::Object(object) => Some(
            ["message", "reason", "error"]
                .iter()
                .find_map(|key| object.get(*key).and_then(Value::as_str))
                .unwrap_or("Uploads reported a problem.")
                .to_string(),
        ),
        _ => Some("Uploads reported a problem.".into()),
    }
}

/// What a stalled upload with no failure of its own says.
const STALLED: &str = "No upload has been confirmed for over five minutes. Agent Relay keeps retrying; queued records are preserved.";

/// The derived fields `uploader.status` adds: `stage`, `stage_message` (the
/// probe's own sentence when the stage carries one), `needs_start`,
/// `journal_full`, `upgrading` and `stalled`.
///
/// Order matters: a stopped uploader is reported before anything else, and
/// a paused one is paused even if its last cycle failed.
pub fn derive(status: &Value) -> Value {
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64;
    derive_at(status, now_ms)
}

fn derive_at(status: &Value, now_ms: i64) -> Value {
    let delivery = &status["delivery"];
    let cycle = &status["last_cycle"];
    let running = status["running"].as_bool().unwrap_or(false);
    let paused = status["paused"].as_bool().unwrap_or(false);
    let replacing = status["collector_replacing"].as_bool().unwrap_or(false);
    let outdated = status["collector_outdated"].as_bool().unwrap_or(false);
    let pending = delivery["pending_records"].as_i64().unwrap_or(0).max(0);
    let error_class = cycle["error_class"].as_str().unwrap_or_default();
    let cycle_failed = cycle["ok"] == Value::Bool(false);
    let cycle_message = cycle["message"].as_str().map(str::to_string);
    // The cycle's verdict says the journal is full, and it stands until a
    // pass measures the cap again: usage alone never decides it.
    let journal_full = cycle_failed && error_class == "retention_limit";
    let upgrading = cycle_failed && error_class == "upgrading";
    let conflict = delivery["failure_code"] == "delivery_conflict";
    let quarantined = delivery["quarantined_records"].as_i64().unwrap_or(0).max(0);
    let failure = failure_message(&delivery["failure"]).filter(|text| !text.is_empty());
    let failure_code = delivery["failure_code"].as_str().unwrap_or_default();
    // A collector being replaced or upgrading local history is preparing,
    // not stalled.
    let stalled = running
        && !paused
        && !replacing
        && !upgrading
        && crate::delivery::delivery_is_stalled(
            pending,
            delivery["last_acknowledged_ms"].as_i64(),
            delivery["oldest_pending_ms"].as_i64(),
            now_ms,
        );
    let transient_progress = failure_code == "transient"
        && !stalled
        && !crate::delivery::retry_failure_is_sustained(
            delivery["attempts"].as_i64().unwrap_or_default(),
            delivery["last_acknowledged_ms"].as_i64(),
            delivery["oldest_pending_ms"].as_i64(),
            now_ms,
        );
    let (stage, message) = if !running {
        (Stage::NotRunning, None)
    } else if paused {
        (Stage::Paused, None)
    } else if replacing {
        (Stage::Preparing, None)
    } else if upgrading {
        (Stage::Preparing, cycle_message)
    } else if conflict {
        (
            Stage::Conflict,
            Some(if quarantined > 0 {
                format!("{quarantined} receiver-proven {} quarantined. Other records can continue uploading; inspect conflicts for repair.", if quarantined == 1 { "record" } else { "records" })
            } else {
                "History delivery conflict: the receiver detail could not be validated. Records remain queued for repair.".into()
            }),
        )
    } else if failure_code != "transient" && failure.is_some() {
        (Stage::NeedsAttention, failure.clone())
    } else if journal_full {
        (
            Stage::NeedsAttention,
            Some(cycle_message.unwrap_or_else(|| {
                "The local upload journal is full. Compact it so capture and uploads can continue; queued sessions are preserved.".into()
            })),
        )
    } else if cycle_failed && LOCAL_STORAGE_FAILURES.contains(&error_class) {
        (
            Stage::NeedsAttention,
            Some(cycle_message.unwrap_or_else(|| {
                "Local history needs attention. Queued sessions are preserved.".into()
            })),
        )
    } else if transient_progress {
        let sent = delivery["acknowledged_records"]
            .as_i64()
            .unwrap_or(0)
            .max(0);
        (
            Stage::Uploading,
            Some(format!(
                "Server is slow; retrying. {sent} sent, {pending} queued."
            )),
        )
    } else if let Some(failure) = failure {
        (Stage::NeedsAttention, Some(failure))
    } else if cycle_failed {
        (Stage::Offline, cycle_message)
    } else if stalled {
        (Stage::NeedsAttention, Some(STALLED.into()))
    } else if pending > 0 {
        (Stage::Uploading, None)
    } else if !delivery["bootstrap_complete"].as_bool().unwrap_or(false)
        || delivery["unqueued_changes"].as_i64().unwrap_or(0) > 0
    {
        (Stage::Preparing, None)
    } else {
        (Stage::UpToDate, None)
    };
    let message = if quarantined > 0 && stage != Stage::Conflict {
        let detail = format!(
            "{quarantined} receiver-proven {} quarantined; inspect conflicts for repair.",
            if quarantined == 1 {
                "record remains"
            } else {
                "records remain"
            }
        );
        Some(match message {
            Some(message) if !message.is_empty() => format!("{message} {detail}"),
            _ => detail,
        })
    } else {
        message
    };
    json!({
        "stage": stage,
        "stage_message": message,
        "needs_start": !running || (outdated && !replacing),
        "journal_full": journal_full,
        "upgrading": upgrading,
        "stalled": stalled,
    })
}

/// The connected install, as `installs` lists it.
#[derive(Clone, Debug, PartialEq)]
pub struct Install {
    pub workspace_name: Option<String>,
    pub target: Target,
    /// The install's directory, which holds its `collector.log`.
    pub directory: Option<String>,
    pub upgrade_required: bool,
    /// The person's name, email and avatar, as the probe recorded them.
    pub account_email: Option<String>,
    pub account_name: Option<String>,
    pub account_avatar_url: Option<String>,
    /// The Cloud organization the workspace belongs to.
    pub org_id: Option<String>,
    pub sharing_mode: Option<SharingMode>,
}

impl Install {
    pub fn from_json(value: &Value) -> Option<Install> {
        let text = |key: &str| {
            value[key]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        };
        Some(Install {
            workspace_name: text("workspace_name"),
            target: Target {
                site_url: text("site_url")?,
                account_id: text("account_id"),
                workspace_id: text("workspace_id"),
            },
            directory: text("directory"),
            upgrade_required: value["upgrade_required"].as_bool().unwrap_or(false),
            account_email: text("account_email"),
            account_name: text("account_name"),
            account_avatar_url: text("account_avatar_url"),
            org_id: text("org_id"),
            sharing_mode: serde_json::from_value(value["sharing_mode"].clone()).ok(),
        })
    }
}

/// Uploader supervision for one daemon.
pub struct Uploader {
    runner: Arc<dyn ProbeRunner>,
    install: Mutex<Option<Install>>,
    /// Bumped when the attached install changes, so an answer for the old
    /// one is never recorded against the new one.
    revision: AtomicU64,
    /// One start at a time.
    starting: tokio::sync::Mutex<()>,
    /// The `status` read in flight, with the `changes` count it began at.
    /// Concurrent callers share it instead of each spawning `status --json`
    /// (the Mac app reads status on every uploader event and every 5 s,
    /// and one read can wait out SQLite's busy timeout while the first
    /// sync writes the history store). Never a cache: a finished read is
    /// not reused.
    status_read: Mutex<Option<(u64, StatusRead)>>,
    status_snapshot: Mutex<Option<(u64, Value)>>,
    sessions_snapshot: Mutex<Option<SessionsSnapshot>>,
    sessions_read: Mutex<Option<(u64, usize, StatusRead)>>,
    sessions_refresh: tokio::sync::Mutex<()>,
    sessions_limit: Mutex<usize>,
    /// Bumped when a change command (start, pause, sharing, …) finishes or
    /// the attachment changes, so no caller is handed a read that began
    /// before the change.
    changes: AtomicU64,
    background: refresh::State,
    sessions_demand: Mutex<Option<std::time::Instant>>,
}

struct SessionsSnapshot {
    generation: u64,
    limit: usize,
    enriched: bool,
    value: Value,
}

type StatusRead = Shared<BoxFuture<'static, Result<Value, RpcError>>>;

fn not_connected() -> RpcError {
    RpcError::new(
        ErrorKind::NotSignedIn,
        "Sign in to Agent Relay to upload sessions.",
    )
}

impl Uploader {
    fn changing(&self) -> Changing<'_> {
        Changing(&self.changes)
    }

    pub fn runner(&self) -> &Arc<dyn ProbeRunner> {
        &self.runner
    }

    /// The attached install.
    pub fn install(&self) -> Option<Install> {
        self.install.lock().unwrap().clone()
    }

    pub fn target(&self) -> Option<Target> {
        self.install().map(|install| install.target)
    }

    /// Attaches `install` (or nothing).
    pub fn attach(&self, install: Option<Install>) {
        let mut current = self.install.lock().unwrap();
        if *current != install {
            self.revision.fetch_add(1, Ordering::SeqCst);
            self.changes.fetch_add(1, Ordering::SeqCst);
            self.invalidate_history_readers();
        }
        if install.is_none() {
            self.invalidate_history_readers();
        }
        *current = install;
    }

    /// The installs for `site_url`, the one matching `expected` (any, when
    /// `None`) first. Bounded: launch never waits on this for long.
    pub async fn installs(
        &self,
        site_url: &str,
        expected: Option<&Target>,
    ) -> Result<Option<Install>, UploaderError> {
        let value = self
            .runner
            .run(command::installs(), Some(timeouts::INSTALLS))
            .await?;
        let installs = value["installs"].as_array().cloned().unwrap_or_default();
        Ok(installs
            .iter()
            .filter_map(Install::from_json)
            .find(|install| {
                install.target.site_url == site_url
                    && expected.is_none_or(|target| &install.target == target)
            }))
    }

    /// Releases what decommissioned installs no longer need; never awaited
    /// by anything on screen.
    pub fn reclaim(self: &Arc<Self>) {
        let uploader = self.clone();
        tokio::spawn(async move {
            let _ = uploader.runner.run(command::reclaim(), None).await;
        });
    }

    fn attached(&self) -> Result<Target, RpcError> {
        self.target().ok_or_else(not_connected)
    }

    /// `status` with `needs_start`, `stage` and the install's `directory`.
    pub async fn status(&self) -> Result<Value, RpcError> {
        // The generation is taken before the target: an attach in between
        // then labels this read with the older generation, so no caller
        // asking after the attach joins a read of the old install.
        let changes = self.changes.load(Ordering::SeqCst);
        let target = self.attached()?;
        let directory = self.install().and_then(|install| install.directory);
        let read = {
            let mut slot = self.status_read.lock().unwrap();
            match slot.as_ref() {
                Some((began, read)) if *began == changes && read.peek().is_none() => read.clone(),
                _ => {
                    let runner = self.runner.clone();
                    let read = async move {
                        runner
                            .run(command::simple("status", &target), Some(timeouts::STATUS))
                            .await
                            .map_err(RpcError::from)
                    }
                    .boxed()
                    .shared();
                    *slot = Some((changes, read.clone()));
                    read
                }
            }
        };
        let mut status = with_derived(read.await?);
        if let Value::Object(fields) = &mut status {
            fields.insert("directory".into(), json!(directory));
        }
        Ok(status)
    }

    /// Presentation reads the last completed status. Supervision continues
    /// to use `status()` so a cached process state never authorizes a restart.
    pub async fn cached_status(&self) -> Result<Value, RpcError> {
        let generation = self.changes.load(Ordering::SeqCst);
        self.attached()?;
        if let Some((began, value)) = self.status_snapshot.lock().unwrap().as_ref() {
            if *began == generation && self.changes.load(Ordering::SeqCst) == generation {
                return Ok(with_derived(value.clone()));
            }
        }
        let (_, value) = self.refresh_status_snapshot().await?;
        Ok(value)
    }

    pub async fn refresh_status_snapshot(&self) -> Result<(bool, Value), RpcError> {
        let generation = self.changes.load(Ordering::SeqCst);
        let value = self.status().await?;
        let mut slot = self.status_snapshot.lock().unwrap();
        if self.changes.load(Ordering::SeqCst) != generation {
            return Err(RpcError::new(
                ErrorKind::Busy,
                "Session settings changed. Please try again.",
            ));
        }
        let changed = slot
            .as_ref()
            .is_none_or(|(began, previous)| *began != generation || *previous != value);
        *slot = Some((generation, value.clone()));
        Ok((changed, value))
    }

    /// Starts the collector, or replaces one running an older build.
    pub async fn start(&self) -> Result<Value, RpcError> {
        let target = self.attached()?;
        let _one = self.starting.lock().await;
        let _changing = self.changing();
        let _readers = self.suspend_background_readers().await;
        Ok(self
            .runner
            .run(command::simple("start", &target), Some(timeouts::START))
            .await?)
    }

    pub async fn pause(&self, paused: bool) -> Result<Value, RpcError> {
        let name = if paused { "pause" } else { "resume" };
        self.control(name, timeouts::PAUSE).await
    }

    /// Retries uploads a problem stopped, or wakes uploads waiting out a
    /// transient failure's backoff; the probe leaves any other job as it is.
    pub async fn retry(&self) -> Result<Value, RpcError> {
        self.control("retry", timeouts::PAUSE).await
    }

    pub async fn compact(&self) -> Result<Value, RpcError> {
        self.control("compact", timeouts::COMPACT).await
    }

    /// One control action on the attached install's upload job.
    async fn control(&self, name: &str, timeout: Duration) -> Result<Value, RpcError> {
        let target = self.attached()?;
        let _changing = self.changing();
        Ok(self
            .runner
            .run(command::simple(name, &target), Some(timeout))
            .await?)
    }

    /// Stops uploads and removes this computer's connection, then forgets
    /// the install.
    pub async fn disconnect(&self) -> Result<Value, RpcError> {
        let target = self.attached()?;
        self.disconnect_target(&target).await
    }

    pub async fn disconnect_target(&self, target: &Target) -> Result<Value, RpcError> {
        let _changing = self.changing();
        let value = self
            .runner
            .run(
                command::simple("disconnect", target),
                Some(timeouts::DISCONNECT),
            )
            .await?;
        if value["disconnected"] != Value::Bool(true) {
            return Err(UploaderError::new("This computer is still connected.").into());
        }
        let mut install = self.install.lock().unwrap();
        if install.as_ref().is_some_and(|i| &i.target == target) {
            *install = None;
            self.revision.fetch_add(1, Ordering::SeqCst);
            self.invalidate_history_readers();
        }
        Ok(value)
    }

    pub async fn sharing_set(&self, mode: SharingMode) -> Result<Value, RpcError> {
        let target = self.attached()?;
        let _changing = self.changing();
        let value = self
            .runner
            .run(command::sharing_set(&target, mode), None)
            .await?;
        if let Some(install) = self.install.lock().unwrap().as_mut() {
            if install.target == target {
                install.sharing_mode = Some(mode);
            }
        }
        Ok(json!({ "sharing_mode": value["sharing_mode"].as_str().unwrap_or(mode.as_str()) }))
    }

    /// Runs in the helper so parsing a large local transcript cannot block delivery.
    pub async fn transcript(
        &self,
        request: crate::relay::contract::transcript::LocalTranscriptParams,
    ) -> Result<Value, RpcError> {
        let mut args = vec![
            "sessions".into(),
            "read".into(),
            "--json".into(),
            "--source".into(),
            request.source,
            "--session-id".into(),
            request.session_id,
        ];
        if let Some(cursor) = request.cursor {
            args.extend([
                "--after-ts".into(),
                cursor.ts_ms.to_string(),
                "--after-id".into(),
                cursor.id.to_string(),
            ]);
        }
        Ok(self.runner.run(args, Some(timeouts::SESSIONS)).await?)
    }

    /// Reads the daemon's shared snapshot. A cold daemon seeds it from the
    /// collector's durable inventory without opening transcripts or scanning
    /// upload batches. Background enrichment never blocks an existing page.
    pub async fn sessions_list(&self, limit: Option<usize>) -> Result<Value, RpcError> {
        *self
            .sessions_demand
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(std::time::Instant::now());
        let generation = self.changes.load(Ordering::SeqCst);
        let target = self.attached()?;
        let limit = limit.unwrap_or(SESSION_LIST_LIMIT).clamp(1, 10_000);
        {
            let mut wanted = self.sessions_limit.lock().unwrap();
            *wanted = (*wanted).max(limit);
        }
        if let Some(snapshot) = self.sessions_snapshot.lock().unwrap().as_ref() {
            if snapshot.generation == generation && snapshot.limit >= limit {
                if self.changes.load(Ordering::SeqCst) != generation {
                    return Err(RpcError::new(
                        ErrorKind::Busy,
                        "Session settings changed. Please try again.",
                    ));
                }
                return Ok(session_page(&snapshot.value, limit));
            }
        }
        let read = {
            let mut slot = self.sessions_read.lock().unwrap();
            match slot.as_ref() {
                Some((began, coverage, read))
                    if *began == generation && *coverage == limit && read.peek().is_none() =>
                {
                    read.clone()
                }
                _ => {
                    let runner = self.runner.clone();
                    let read = async move {
                        runner
                            .run(
                                command::sessions_catalog(&target, limit),
                                Some(timeouts::SESSIONS),
                            )
                            .await
                            .map_err(RpcError::from)
                    }
                    .boxed()
                    .shared();
                    *slot = Some((generation, limit, read.clone()));
                    read
                }
            }
        };
        let value = session_page(&read.await?, limit);
        self.publish_sessions(generation, limit, false, value.clone())?;
        // Enrichment may have finished while the catalog read was in flight.
        let snapshot = self.sessions_snapshot.lock().unwrap();
        let snapshot = snapshot.as_ref().unwrap();
        if snapshot.generation != generation || self.changes.load(Ordering::SeqCst) != generation {
            return Err(RpcError::new(
                ErrorKind::Busy,
                "Session settings changed. Please try again.",
            ));
        }
        Ok(session_page(&snapshot.value, limit))
    }

    fn publish_sessions(
        &self,
        generation: u64,
        limit: usize,
        enriched: bool,
        mut value: Value,
    ) -> Result<bool, RpcError> {
        let mut slot = self.sessions_snapshot.lock().unwrap();
        if self.changes.load(Ordering::SeqCst) != generation {
            return Err(RpcError::new(
                ErrorKind::Busy,
                "Session settings changed. Please try again.",
            ));
        }
        if let Some(previous) = slot.as_ref().filter(|s| s.generation == generation) {
            // An older, smaller page must not replace a larger page; a seed
            // must not erase upload proofs that finished in the meantime.
            if previous.limit > limit || (previous.limit == limit && previous.enriched && !enriched)
            {
                return Ok(false);
            }
            if !enriched {
                // Expanding the catalog page must not turn already-proven
                // upload badges back into "checking".
                let key = |row: &Value| {
                    (
                        row["source"].as_str().unwrap_or("").to_string(),
                        row["session_id"].as_str().unwrap_or("").to_string(),
                    )
                };
                let existing: HashMap<_, _> = previous.value["sessions"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|row| (key(row), row))
                    .collect();
                for row in value["sessions"].as_array_mut().into_iter().flatten() {
                    if let Some(previous) = existing.get(&key(row)) {
                        *row = (*previous).clone();
                    }
                }
            }
        }
        let changed = slot
            .as_ref()
            .is_none_or(|previous| previous.generation != generation || previous.value != value);
        // Coverage must advance even when the larger request found no extra
        // rows. Otherwise an empty/short page would spawn a helper forever.
        *slot = Some(SessionsSnapshot {
            generation,
            limit,
            enriched,
            value,
        });
        Ok(changed)
    }

    /// One background pass for all windows/clients. Failure leaves the last
    /// completed snapshot intact. The helper enforces a finite read timeout.
    pub async fn refresh_sessions_snapshot(&self) -> Result<bool, RpcError> {
        let _refresh = self.sessions_refresh.lock().await;
        let generation = self.changes.load(Ordering::SeqCst);
        let target = self.attached()?;
        let limit = *self.sessions_limit.lock().unwrap();
        let value = self
            .runner
            .run(
                command::sessions_list(&target, limit),
                Some(timeouts::SESSIONS),
            )
            .await?;
        self.publish_sessions(generation, limit, true, session_page(&value, limit))
    }

    /// The sessions on this computer before any install exists, so the
    /// sign-in screen can show what would be shared.
    pub async fn sessions_preview(
        &self,
        limit: Option<usize>,
        refresh: bool,
    ) -> Result<Value, RpcError> {
        // The probe previews at most 100.
        let limit = limit.unwrap_or(100).clamp(1, 100);
        let timeout = if refresh {
            timeouts::PREVIEW_REFRESH
        } else {
            timeouts::PREVIEW
        };
        let value = self
            .runner
            .run(command::sessions_preview(refresh, limit), Some(timeout))
            .await?;
        Ok(json!({ "sessions": value["sessions"].as_array().cloned().unwrap_or_default() }))
    }

    pub async fn sessions_change(&self, include: bool, keys: &[String]) -> Result<Value, RpcError> {
        let target = self.attached()?;
        self.sessions_change_for(&target, include, keys).await
    }

    pub async fn sessions_reset(&self, confirmation: &str) -> Result<Value, RpcError> {
        if confirmation != "DELETE ALL SESSIONS" {
            return Err(RpcError::invalid_params(
                "Type DELETE ALL SESSIONS to confirm the reset.",
            ));
        }
        let target = self.attached()?;
        let _starting = self.starting.lock().await;
        let _changing = self.changing();
        let _readers = self.suspend_background_readers().await;
        let result = self
            .runner
            .run(command::sessions_reset(&target, confirmation), None)
            .await?;
        if result["reset"] != Value::Bool(true) {
            return Err(UploaderError::new("The reset was not confirmed. Try again.").into());
        }
        Ok(result)
    }

    /// Explicit deletion consent, separate from the legacy stop-uploading command.
    pub async fn sessions_delete(&self, keys: &[String]) -> Result<Value, RpcError> {
        let target = self.attached()?;
        if keys.is_empty() {
            return Ok(json!({ "updated": 0 }));
        }
        if keys.iter().any(|key| !key.contains(':') || key.len() > 512) {
            return Err(RpcError::invalid_params(
                "Session keys are source:session_id.",
            ));
        }
        let _changing = self.changing();
        self.runner
            .run(command::sessions_delete(&target, keys), None)
            .await?;
        Ok(json!({ "updated": keys.len() }))
    }

    /// `sessions_change` on `target` itself, whatever is attached now, so
    /// keys read from one install never reach another.
    pub async fn sessions_change_for(
        &self,
        target: &Target,
        include: bool,
        keys: &[String],
    ) -> Result<Value, RpcError> {
        if keys.is_empty() {
            return Ok(json!({ "updated": 0 }));
        }
        if keys.iter().any(|key| !key.contains(':') || key.len() > 512) {
            return Err(RpcError::invalid_params(
                "Session keys are \"source:session_id\".",
            ));
        }
        let _changing = self.changing();
        self.runner
            .run(command::sessions_change(include, target, keys), None)
            .await?;
        Ok(json!({ "updated": keys.len() }))
    }

    /// Bumped whenever the attached install changes (`attach`).
    pub fn revision(&self) -> u64 {
        self.revision.load(Ordering::SeqCst)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    mod supervise;

    fn status(fields: Value) -> Value {
        let mut base = json!({
            "running": true, "paused": false, "sharing_mode": "all",
            "delivery": {"bootstrap_complete": true, "pending_records": 0, "acknowledged_records": 10,
                         "unqueued_changes": 0, "skipped_records": 0, "failure": null},
            "sessions": {"shared": 1, "total": 2},
            "last_cycle": null,
            "collector_outdated": false, "collector_replacing": false,
        });
        merge(&mut base, fields);
        base
    }

    fn merge(base: &mut Value, patch: Value) {
        match (base, patch) {
            (Value::Object(base), Value::Object(patch)) => {
                for (key, value) in patch {
                    merge(base.entry(key).or_insert(Value::Null), value);
                }
            }
            (base, patch) => *base = patch,
        }
    }

    fn stage(fields: Value) -> (String, Option<String>) {
        let derived = derive(&status(fields));
        (
            derived["stage"].as_str().unwrap().to_string(),
            derived["stage_message"].as_str().map(str::to_string),
        )
    }

    #[test]
    fn a_stopped_uploader_is_reported_first_and_needs_a_start() {
        let derived = derive(&status(json!({"running": false, "paused": true})));
        assert_eq!(derived["stage"], "not_running");
        assert_eq!(derived["needs_start"], true);
    }

    #[test]
    fn paused_outranks_a_failed_cycle() {
        let (stage, _) =
            stage(json!({"paused": true, "last_cycle": {"ok": false, "message": "x"}}));
        assert_eq!(stage, "paused");
    }

    #[test]
    fn replacement_and_upgrade_are_preparing() {
        assert_eq!(stage(json!({"collector_replacing": true})).0, "preparing");
        let (stage, message) = stage(
            json!({"last_cycle": {"ok": false, "error_class": "upgrading", "message": "Upgrading history"}}),
        );
        assert_eq!(stage, "preparing");
        assert_eq!(message.as_deref(), Some("Upgrading history"));
        assert_eq!(
            derive(&status(
                json!({"last_cycle": {"ok": false, "error_class": "upgrading"}})
            ))["upgrading"],
            true
        );
    }

    #[test]
    fn a_delivery_failure_needs_attention_with_its_sentence() {
        assert_eq!(
            stage(json!({"delivery": {"failure": {"message": "Sign in again."}}})),
            ("needs_attention".into(), Some("Sign in again.".into()))
        );
        assert_eq!(
            stage(json!({"delivery": {"failure": "Plain sentence."}})),
            ("needs_attention".into(), Some("Plain sentence.".into()))
        );
        assert_eq!(
            stage(json!({"delivery": {"failure": {"code": 3}}})),
            (
                "needs_attention".into(),
                Some("Uploads reported a problem.".into())
            )
        );
    }

    #[test]
    fn a_progressing_transient_failure_stays_a_calm_upload() {
        let now = 1_000_000;
        let derived = derive_at(
            &status(json!({"delivery": {
                "failure": "The server is temporarily unavailable.",
                "failure_code": "transient",
                "attempts": 4,
                "last_acknowledged_ms": now - 30_000,
                "oldest_pending_age_ms": 600_000,
                "pending_records": 17,
                "acknowledged_records": 42
            }})),
            now,
        );
        assert_eq!(derived["stage"], "uploading");
        assert_eq!(
            derived["stage_message"],
            "Server is slow; retrying. 42 sent, 17 queued."
        );
    }

    #[test]
    fn a_sustained_transient_failure_needs_attention() {
        let now = 1_000_000;
        let derived = derive_at(
            &status(json!({"delivery": {
                "failure": "The upload service is temporarily unavailable. Agent Relay will retry.",
                "failure_code": "transient",
                "attempts": 3,
                "last_acknowledged_ms": now - 300_000,
                "oldest_pending_age_ms": 300_000,
                "pending_records": 17
            }})),
            now,
        );
        assert_eq!(derived["stage"], "needs_attention");
    }

    #[test]
    fn a_fresh_queue_after_an_old_ack_does_not_warn_early() {
        let now = 1_000_000;
        let derived = derive_at(
            &status(json!({"delivery": {
                "failure": "The upload service is temporarily unavailable. Agent Relay will retry.",
                "failure_code": "transient",
                "attempts": 3,
                "last_acknowledged_ms": now - 600_000,
                "oldest_pending_ms": now - 30_000,
                "pending_records": 17
            }})),
            now,
        );
        assert_eq!(derived["stage"], "uploading");
    }

    /// Records waiting with no acknowledgement degrade the stage whatever
    /// the failure class, including none at all.
    #[test]
    fn an_old_unacknowledged_queue_needs_attention_whatever_the_failure() {
        let now = 10_000_000;
        let waiting = |extra: Value| {
            let mut delivery = json!({"pending_records": 5, "attempts": 1,
                "last_acknowledged_ms": now - 600_000, "oldest_pending_ms": now - 600_000});
            merge(&mut delivery, extra);
            derive_at(&status(json!({ "delivery": delivery })), now)
        };
        for extra in [
            json!({}),
            json!({"failure": "The upload service is temporarily unavailable.", "failure_code": "transient"}),
            json!({"failure": "Uploads need you to sign in.", "failure_code": "authentication_required"}),
        ] {
            let derived = waiting(extra.clone());
            assert_eq!(derived["stalled"], true, "{extra}");
            assert_eq!(derived["stage"], "needs_attention", "{extra}");
        }
        assert_eq!(waiting(json!({}))["stage_message"], STALLED);
        // A recent acknowledgement, an empty queue or a pause is not a stall.
        for extra in [
            json!({"last_acknowledged_ms": now - 60_000}),
            json!({"pending_records": 0}),
        ] {
            assert_eq!(waiting(extra.clone())["stalled"], false, "{extra}");
        }
        let paused = derive_at(
            &status(json!({"paused": true, "delivery": {"pending_records": 5,
                "oldest_pending_ms": now - 600_000}})),
            now,
        );
        assert_eq!(paused["stalled"], false);
        assert_eq!(paused["stage"], "paused");
        // A receiver conflict outranks the stall.
        let conflict = waiting(
            json!({"failure": "History delivery has a receiver conflict.",
            "failure_code": "delivery_conflict"}),
        );
        assert_eq!(conflict["stalled"], true);
        assert_eq!(conflict["stage"], "conflict");
        let upgrading = derive_at(
            &status(
                json!({"delivery": {"pending_records": 5, "oldest_pending_ms": now - 600_000},
                "last_cycle": {"ok": false, "error_class": "upgrading"}}),
            ),
            now,
        );
        assert_eq!(upgrading["stalled"], false);
        assert_eq!(upgrading["stage"], "preparing");
    }

    #[test]
    fn specific_delivery_failures_still_need_attention_immediately() {
        for code in [
            "authentication_required",
            "permission_denied",
            "rate_limited",
            "receiver_rejected",
            "invalid_payload",
            "unsupported_evidence",
        ] {
            let derived = derive_at(
                &status(json!({"delivery": {
                    "failure": format!("specific: {code}"),
                    "failure_code": code,
                    "attempts": 1,
                    "last_acknowledged_ms": 999_999
                }})),
                1_000_000,
            );
            assert_eq!(derived["stage"], "needs_attention", "{code}");
        }
    }

    #[test]
    fn only_a_current_conflict_failure_promotes_the_conflict_stage() {
        let (phase, message) = stage(json!({"delivery": {"pending_records": 2,
            "quarantined_records": 1, "skipped_records": 1}}));
        assert_eq!(phase, "uploading");
        assert!(message
            .unwrap()
            .contains("1 receiver-proven record remains quarantined"));
        let (phase, message) = stage(json!({"delivery": {"failure": "delivery_conflict"}}));
        assert_eq!(phase, "needs_attention");
        assert_eq!(message.unwrap(), "delivery_conflict");
        let (phase, message) = stage(json!({"delivery": {
            "failure_code": "delivery_conflict",
            "failure": "History delivery has a receiver conflict."
        }}));
        assert_eq!(phase, "conflict");
        assert!(message.unwrap().contains("remain queued"));

        let (phase, message) = stage(json!({"delivery": {
            "failure_code": "authentication_required",
            "failure": "Sign in to resume uploads.",
            "quarantined_records": 2
        }}));
        assert_eq!(phase, "needs_attention");
        let message = message.unwrap();
        assert!(message.contains("Sign in to resume uploads."));
        assert!(message.contains("2 receiver-proven records remain quarantined"));
    }

    #[test]
    fn a_full_journal_is_the_cycle_s_verdict() {
        let full = status(json!({"last_cycle": {"ok": false, "error_class": "retention_limit"}}));
        let derived = derive(&full);
        assert_eq!(derived["stage"], "needs_attention");
        assert_eq!(derived["journal_full"], true);
        assert!(derived["stage_message"]
            .as_str()
            .unwrap()
            .contains("journal is full"));
        // Usage near the cap without the verdict is not full.
        let near = status(json!({"retention": {"used_bytes": 255, "limit_bytes": 256}}));
        assert_eq!(derive(&near)["journal_full"], false);
    }

    #[test]
    fn local_storage_failures_need_attention_and_others_are_offline() {
        assert_eq!(
            stage(json!({"last_cycle": {"ok": false, "error_class": "disk_full"}})),
            (
                "needs_attention".into(),
                Some("Local history needs attention. Queued sessions are preserved.".into())
            )
        );
        assert_eq!(
            stage(
                json!({"last_cycle": {"ok": false, "error_class": "network", "message": "Offline."}})
            ),
            ("offline".into(), Some("Offline.".into()))
        );

        let (stage, message) = stage(json!({
            "delivery": {
                "failure": "The upload service is temporarily unavailable. Agent Relay will retry.",
                "failure_code": "transient",
                "attempts": 1,
                "last_acknowledged_ms": 999_999
            },
            "last_cycle": {"ok": false, "error_class": "disk_full"}
        }));
        assert_eq!(stage, "needs_attention");
        assert_eq!(
            message.as_deref(),
            Some("Local history needs attention. Queued sessions are preserved.")
        );
    }

    #[test]
    fn pending_records_upload_then_preparation_then_up_to_date() {
        assert_eq!(
            stage(json!({"delivery": {"pending_records": 4}})).0,
            "uploading"
        );
        assert_eq!(
            stage(json!({"delivery": {"bootstrap_complete": false}})).0,
            "preparing"
        );
        assert_eq!(
            stage(json!({"delivery": {"unqueued_changes": 2}})).0,
            "preparing"
        );
        assert_eq!(stage(json!({})).0, "up_to_date");
    }

    #[test]
    fn an_outdated_collector_needs_a_start_unless_it_is_being_replaced() {
        assert_eq!(
            derive(&status(json!({"collector_outdated": true})))["needs_start"],
            true
        );
        assert_eq!(
            derive(&status(
                json!({"collector_outdated": true, "collector_replacing": true})
            ))["needs_start"],
            false
        );
        assert_eq!(derive(&status(json!({})))["needs_start"], false);
    }

    #[test]
    fn commands_match_the_probe_s_bridge_contract() {
        let target = Target {
            site_url: "https://agentrelay.com".into(),
            account_id: Some("u1".into()),
            workspace_id: Some("w1".into()),
        };
        assert_eq!(
            command::simple("status", &target),
            [
                "status",
                "--site-url",
                "https://agentrelay.com",
                "--account",
                "u1",
                "--workspace",
                "w1",
                "--json"
            ]
        );
        assert_eq!(
            command::cloud_install(
                &Target {
                    account_id: None,
                    ..target.clone()
                },
                SharingMode::New,
                true
            ),
            [
                "cloud",
                "install",
                "--site-url",
                "https://agentrelay.com",
                "--workspace",
                "w1",
                "--json",
                "--new-sessions-only",
                "--keep-saved-sharing",
                "--acknowledge-uninspected-schedules"
            ]
        );
        assert_eq!(
            command::sessions_change(true, &target, &["codex:a".into(), "claude:b".into()]),
            [
                "sessions",
                "include",
                "--site-url",
                "https://agentrelay.com",
                "--account",
                "u1",
                "--workspace",
                "w1",
                "--json",
                "--session",
                "codex:a",
                "--session",
                "claude:b"
            ]
        );
        assert_eq!(
            command::sharing_set(&target, SharingMode::Selected),
            [
                "sharing",
                "set",
                "--site-url",
                "https://agentrelay.com",
                "--account",
                "u1",
                "--workspace",
                "w1",
                "--mode",
                "selected",
                "--json"
            ]
        );
        assert_eq!(
            command::sessions_preview(true, 100),
            [
                "sessions",
                "preview",
                "--json",
                "--limit",
                "100",
                "--refresh"
            ]
        );
        assert_eq!(
            command::sessions_list(&target, 500),
            [
                "sessions",
                "list",
                "--site-url",
                "https://agentrelay.com",
                "--account",
                "u1",
                "--workspace",
                "w1",
                "--json",
                "--limit",
                "500"
            ]
        );
    }

    #[test]
    fn output_is_one_object_or_the_last_line() {
        assert_eq!(decode_output("{\"a\":1}\n"), Some(json!({"a": 1})));
        assert_eq!(decode_output("stray\n{\"a\":2}\n\n"), Some(json!({"a": 2})));
        assert_eq!(decode_output("[1]"), None);
        assert_eq!(decode_output(""), None);
        assert_eq!(
            stderr_message("warn\nThe safe sentence.\n\n", "x"),
            "The safe sentence."
        );
        assert_eq!(stderr_message("  \n", "fallback"), "fallback");
    }

    #[test]
    fn installs_are_read_from_the_listing() {
        let install = Install::from_json(&json!({"directory": "/d", "site_url": "https://agentrelay.com",
            "account_id": "u1", "workspace_id": "w1", "upgrade_required": true, "sharing_mode": "new",
            "account_email": "a@example.com"}))
        .unwrap();
        assert_eq!(install.target.workspace_id.as_deref(), Some("w1"));
        assert_eq!(install.directory.as_deref(), Some("/d"));
        assert!(install.upgrade_required);
        assert_eq!(install.sharing_mode, Some(SharingMode::New));
        assert!(Install::from_json(&json!({"directory": "/d"})).is_none());
    }

    /// Counts `status` runs; each one takes `delay`.
    struct CountingProbe {
        statuses: AtomicU64,
        delay: Duration,
    }

    impl ProbeRunner for CountingProbe {
        fn run(
            &self,
            args: Vec<String>,
            _timeout: Option<Duration>,
        ) -> BoxFuture<'_, Result<Value, UploaderError>> {
            Box::pin(async move {
                if args.first().map(String::as_str) == Some("status") {
                    let run = self.statuses.fetch_add(1, Ordering::SeqCst) + 1;
                    tokio::time::sleep(self.delay).await;
                    return Ok(json!({ "running": true, "paused": false, "run": run }));
                }
                Ok(json!({}))
            })
        }

        fn install(
            &self,
            _args: Vec<String>,
            _bearer: Option<Secret>,
        ) -> Result<InstallRun, UploaderError> {
            Err(UploaderError::new("unused"))
        }

        fn cancel_all(&self) -> BoxFuture<'_, Result<(), UploaderError>> {
            Box::pin(async { Ok(()) })
        }
    }

    #[tokio::test]
    async fn concurrent_status_reads_share_one_probe_run_until_a_change() {
        let probe = Arc::new(CountingProbe {
            statuses: AtomicU64::new(0),
            delay: Duration::from_millis(200),
        });
        let uploader = Uploader::new(probe.clone());
        uploader.attach(Install::from_json(
            &json!({ "site_url": "https://example.test" }),
        ));

        let (a, b, c) = tokio::join!(uploader.status(), uploader.status(), uploader.status());
        assert_eq!(
            probe.statuses.load(Ordering::SeqCst),
            1,
            "one run for three readers"
        );
        assert_eq!(a.unwrap()["run"], 1);
        assert_eq!(b.unwrap()["run"], 1);
        assert_eq!(c.unwrap()["run"], 1);

        // A finished read is never reused.
        assert_eq!(uploader.status().await.unwrap()["run"], 2);

        // A read in flight when a change finishes is not handed to a caller
        // who arrives after the change.
        let before = uploader.status();
        let after = async {
            tokio::time::sleep(Duration::from_millis(50)).await;
            uploader.pause(true).await.unwrap();
            uploader.status().await
        };
        let (before, after) = tokio::join!(before, after);
        assert_eq!(before.unwrap()["run"], 3);
        assert_eq!(after.unwrap()["run"], 4);
        assert_eq!(probe.statuses.load(Ordering::SeqCst), 4);
    }

    #[tokio::test]
    async fn cached_upload_status_does_not_spawn_a_helper_on_reopen() {
        let probe = Arc::new(CountingProbe {
            statuses: AtomicU64::new(0),
            delay: Duration::from_millis(20),
        });
        let uploader = Uploader::new(probe.clone());
        uploader.attach(Install::from_json(
            &json!({"site_url":"https://example.test"}),
        ));
        assert_eq!(uploader.cached_status().await.unwrap()["run"], 1);
        for _ in 0..3 {
            assert_eq!(uploader.cached_status().await.unwrap()["run"], 1);
        }
        assert_eq!(probe.statuses.load(Ordering::SeqCst), 1);
        assert!(uploader.refresh_status_snapshot().await.unwrap().0);
        assert_eq!(uploader.cached_status().await.unwrap()["run"], 2);
        uploader.pause(true).await.unwrap();
        assert_eq!(uploader.cached_status().await.unwrap()["run"], 3);
        // Authority/supervision reads still examine current process state.
        assert_eq!(uploader.status().await.unwrap()["run"], 4);
    }

    struct SnapshotProbe {
        catalog_reads: AtomicU64,
        full_reads: AtomicU64,
        fail: std::sync::atomic::AtomicBool,
        full_gate: tokio::sync::Semaphore,
    }

    impl ProbeRunner for SnapshotProbe {
        fn run(
            &self,
            args: Vec<String>,
            _timeout: Option<Duration>,
        ) -> BoxFuture<'_, Result<Value, UploaderError>> {
            Box::pin(async move {
                if args.first().map(String::as_str) != Some("sessions") {
                    return Ok(json!({}));
                }
                let catalog = args.iter().any(|a| a == "--catalog-only");
                if catalog {
                    self.catalog_reads.fetch_add(1, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(20)).await;
                } else {
                    self.full_reads.fetch_add(1, Ordering::SeqCst);
                    self.full_gate.acquire().await.unwrap().forget();
                    if self.fail.load(Ordering::SeqCst) {
                        return Err(UploaderError::new("Refresh failed."));
                    }
                }
                let param = |name| args.windows(2).find(|p| p[0] == name).map(|p| p[1].clone());
                let limit: usize = param("--limit").unwrap().parse().unwrap();
                Ok(
                    json!({"sharing_mode":"selected", "sessions": (0..limit).map(|id| json!({
                    "session_id":id.to_string(), "account":param("--account"),
                    "status": if catalog {"checking"} else {"uploaded"}
                })).collect::<Vec<_>>()}),
                )
            })
        }
        fn install(
            &self,
            _args: Vec<String>,
            _bearer: Option<Secret>,
        ) -> Result<InstallRun, UploaderError> {
            Err(UploaderError::new("unused"))
        }
        fn cancel_all(&self) -> BoxFuture<'_, Result<(), UploaderError>> {
            Box::pin(async { Ok(()) })
        }
    }

    fn snapshot_uploader() -> (Arc<Uploader>, Arc<SnapshotProbe>) {
        let probe = Arc::new(SnapshotProbe {
            catalog_reads: AtomicU64::new(0),
            full_reads: AtomicU64::new(0),
            fail: std::sync::atomic::AtomicBool::new(false),
            full_gate: tokio::sync::Semaphore::new(0),
        });
        let uploader = Arc::new(Uploader::new(probe.clone()));
        uploader.attach(Install::from_json(
            &json!({"site_url":"https://example.test","account_id":"a"}),
        ));
        (uploader, probe)
    }

    #[tokio::test]
    async fn session_snapshot_is_shared_while_enrichment_is_held_and_survives_failure() {
        let (uploader, probe) = snapshot_uploader();
        let (a, b) = tokio::join!(
            uploader.sessions_list(Some(2)),
            uploader.sessions_list(Some(2))
        );
        assert_eq!(a.unwrap(), b.unwrap());
        assert_eq!(probe.catalog_reads.load(Ordering::SeqCst), 1);
        let refresh = {
            let uploader = uploader.clone();
            tokio::spawn(async move { uploader.refresh_sessions_snapshot().await })
        };
        while probe.full_reads.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
        for _ in 0..3 {
            let rows =
                tokio::time::timeout(Duration::from_millis(10), uploader.sessions_list(Some(2)))
                    .await
                    .unwrap()
                    .unwrap();
            assert_eq!(rows["sessions"][0]["status"], "checking");
        }
        assert_eq!(probe.catalog_reads.load(Ordering::SeqCst), 1);
        probe.full_gate.add_permits(1);
        assert!(refresh.await.unwrap().unwrap());
        let rows = uploader.sessions_list(Some(2)).await.unwrap();
        assert_eq!(rows["sessions"][0]["status"], "uploaded");
        probe.fail.store(true, Ordering::SeqCst);
        probe.full_gate.add_permits(1);
        assert!(uploader.refresh_sessions_snapshot().await.is_err());
        assert_eq!(uploader.sessions_list(Some(2)).await.unwrap(), rows);
    }

    #[tokio::test]
    async fn expanding_a_snapshot_keeps_proven_badges_and_caches_short_pages() {
        let (uploader, probe) = snapshot_uploader();
        let mut first = uploader.sessions_list(Some(2)).await.unwrap();
        for row in first["sessions"].as_array_mut().unwrap() {
            row["status"] = json!("uploaded");
        }
        let generation = uploader.changes.load(Ordering::SeqCst);
        uploader
            .publish_sessions(generation, 2, true, first.clone())
            .unwrap();
        let expanded = uploader.sessions_list(Some(4)).await.unwrap();
        assert_eq!(expanded["sessions"][0]["status"], "uploaded");
        assert_eq!(expanded["sessions"][2]["status"], "checking");
        assert!(!uploader
            .publish_sessions(generation, 8, true, expanded.clone())
            .unwrap());
        assert!(!uploader
            .publish_sessions(generation, 2, true, first)
            .unwrap());
        assert_eq!(uploader.sessions_list(Some(8)).await.unwrap(), expanded);
        assert_eq!(probe.catalog_reads.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn session_snapshot_respects_pages_and_discards_old_account_and_mutation_reads() {
        let (uploader, probe) = snapshot_uploader();
        assert_eq!(
            uploader.sessions_list(Some(2)).await.unwrap()["sessions"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            uploader.sessions_list(Some(4)).await.unwrap()["sessions"]
                .as_array()
                .unwrap()
                .len(),
            4
        );
        assert_eq!(
            uploader.sessions_list(Some(1)).await.unwrap()["sessions"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(probe.catalog_reads.load(Ordering::SeqCst), 2);
        for account_change in [true, false] {
            let before = probe.full_reads.load(Ordering::SeqCst);
            let refresh = {
                let uploader = uploader.clone();
                tokio::spawn(async move { uploader.refresh_sessions_snapshot().await })
            };
            while probe.full_reads.load(Ordering::SeqCst) == before {
                tokio::task::yield_now().await;
            }
            if account_change {
                uploader.attach(Install::from_json(
                    &json!({"site_url":"https://example.test","account_id":"b"}),
                ));
            } else {
                uploader.pause(true).await.unwrap();
            }
            let fresh = uploader.sessions_list(Some(2)).await.unwrap();
            assert_eq!(fresh["sessions"][0]["account"], "b");
            probe.full_gate.add_permits(1);
            assert_eq!(
                refresh.await.unwrap().unwrap_err().data.kind,
                ErrorKind::Busy
            );
            assert_eq!(uploader.sessions_list(Some(2)).await.unwrap(), fresh);
        }
    }

    #[cfg(unix)]
    fn script(dir: &std::path::Path, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = dir.join(format!("probe-{}.sh", NEXT.fetch_add(1, Ordering::SeqCst)));
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_process_runner_reads_the_answer_or_the_safe_sentence() {
        let dir = tempfile::tempdir().unwrap();
        let ok = ProcessRunner::new(script(
            dir.path(),
            "echo progress; echo '{\"ok\":true,\"args\":\"'\"$*\"'\"}'",
        ));
        let value = ok
            .run(
                vec!["status".into(), "--json".into()],
                Some(Duration::from_secs(5)),
            )
            .await
            .unwrap();
        assert_eq!(value, json!({"ok": true, "args": "status --json"}));

        let failing = ProcessRunner::new(script(
            dir.path(),
            "echo 'detail' >&2; echo 'This workspace is busy.' >&2; exit 1",
        ));
        let error = failing.run(vec!["start".into()], None).await.unwrap_err();
        assert_eq!(error.message, "This workspace is busy.");

        let missing = ProcessRunner::new(dir.path().join("nothing"));
        assert_eq!(
            missing.run(vec![], None).await.unwrap_err().message,
            MISSING
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_finished_command_does_not_wait_for_a_descendant_holding_its_output() {
        let dir = tempfile::tempdir().unwrap();
        let runner = ProcessRunner::new(script(dir.path(), "sleep 30 & echo '{\"started\":true}'"));
        let started = std::time::Instant::now();
        let value = runner.run(vec!["start".into()], None).await.unwrap();
        assert_eq!(value, json!({"started": true}));
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_command_past_its_deadline_is_stopped() {
        let dir = tempfile::tempdir().unwrap();
        let slow = ProcessRunner::new(script(dir.path(), "sleep 30"));
        let started = std::time::Instant::now();
        let error = slow
            .run(vec!["compact".into()], Some(Duration::from_millis(200)))
            .await
            .unwrap_err();
        assert_eq!(error.message, timeout_message("compact"));
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(slow.children.lock().unwrap().is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancel_all_stops_running_commands_and_refuses_older_ones() {
        let dir = tempfile::tempdir().unwrap();
        let runner = Arc::new(ProcessRunner::new(script(dir.path(), "sleep 30")));
        let running = {
            let runner = runner.clone();
            tokio::spawn(async move { runner.run(vec!["sessions".into()], None).await })
        };
        for _ in 0..200 {
            if !runner.children.lock().unwrap().is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        runner.cancel_all().await.unwrap();
        let error = running.await.unwrap().unwrap_err();
        assert!(error.cancelled);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn an_install_streams_its_events_then_its_outcome() {
        let dir = tempfile::tempdir().unwrap();
        let runner = ProcessRunner::new(script(
            dir.path(),
            "echo '{\"event\":\"authenticated\",\"account_id\":\"u1\"}'; echo 'not json'; \
             echo \"{\\\"event\\\":\\\"ready\\\",\\\"token\\\":\\\"$CLOUD_API_ACCESS_TOKEN\\\"}\"",
        ));
        let mut run = runner
            .install(vec!["cloud".into()], Some(Secret::new("handoff")))
            .unwrap();
        let first = run.events.recv().await.unwrap();
        assert_eq!(first["event"], "authenticated");
        let second = run.events.recv().await.unwrap();
        assert_eq!(second, json!({"event": "ready", "token": "handoff"}));
        assert_eq!(run.finished.await.unwrap(), Ok(()));

        let refusing = ProcessRunner::new(script(
            dir.path(),
            "echo 'Could not inspect older upload schedules. Check them, then retry with --acknowledge-uninspected-schedules.' >&2; exit 1",
        ));
        let run = refusing.install(vec![], None).unwrap();
        let error = run.finished.await.unwrap().unwrap_err();
        assert!(error.needs_schedule_acknowledgement());

        let slow = ProcessRunner::new(script(dir.path(), "sleep 30"));
        let run = slow.install(vec![], None).unwrap();
        (run.cancel)();
        assert!(run.finished.await.unwrap().unwrap_err().cancelled);
    }
}
