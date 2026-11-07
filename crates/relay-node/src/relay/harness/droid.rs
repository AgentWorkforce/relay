//! Persistent Droid JSON-RPC workers. A detached probe host owns JSON-RPC stdio and a
//! private control socket, so idle workers can take another turn after the
//! desktop restarts. Existing terminal/Cloud Droid sessions are never adopted.

#[cfg(unix)]
pub mod host;
/// The JSON-RPC host owns a Unix control socket and is admitted by the kernel's
/// peer credentials. The initial managed route is Unix-only; Windows can
/// still collect Factory history.
#[cfg(windows)]
pub mod host {
    use std::path::Path;

    pub fn run(
        _executable: &Path,
        _directory: &Path,
        _runtime: &Path,
        _launch_id: &str,
    ) -> anyhow::Result<()> {
        anyhow::bail!(super::unsupported().unwrap_or_default())
    }
}
#[cfg(unix)]
pub mod protocol;

use super::{
    Builtin, Descriptor, HarnessAdapter, HarnessContext, HarnessId, Installed, SpawnFacet,
};
use crate::relay::droid::DroidConfig;
use crate::relay::existing_session::platform::MetadataExt;
#[cfg(all(test, unix))]
use crate::relay::inject::InjectOutcome;
use crate::relay::process::ProcessTable;
use crate::relay::spawn::intents::Intent;
use crate::relay::spawn::launch::{
    scope_unit, start_scoped_or_plain, stop_process, Launch, LaunchError, Launched, SpawnedProcess,
    Started, TaskHandoff,
};
use crate::relay::spawn::lifecycle::Observation;
use crate::relay::spawn::observe::Watched;
use crate::relay::state::{ProcessLiveness, WorkState};
use crate::relay::store::is_uuid as is_session_id;
use crate::relay::store::{SessionKind, Target};
use serde_json::json;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

pub const ID: HarnessId = HarnessId("droid");
pub const DESCRIPTOR: Descriptor = Descriptor {
    id: ID,
    label: "Factory Droid",
    billing: true,
    full_access: None,
};
pub const BUILTIN: Builtin = Builtin {
    descriptor: &DESCRIPTOR,
    adapter,
};
fn adapter(cx: &HarnessContext) -> Arc<dyn HarnessAdapter> {
    Arc::new(DroidAdapter::new(cx))
}
const MARKER: &str = "AGENT_RELAY_DROID_SPAWN";
const TIMEOUT: Duration = Duration::from_secs(30);
fn unsupported() -> Option<String> {
    (!cfg!(unix)).then(|| "Factory Droid managed messaging is not available on Windows.".into())
}

mod registry;
use registry::exchange;
#[cfg(unix)]
use registry::write_record;
pub use registry::{deliver, runtime, Record};
pub(crate) use registry::{read_record, verified};

pub struct DroidAdapter {
    executable: Option<PathBuf>,
    config: DroidConfig,
    table: Arc<dyn ProcessTable>,
    helper: Option<PathBuf>,
    environment: BTreeMap<String, String>,
    systemd_run: Option<PathBuf>,
    ready_timeout: Duration,
}

impl DroidAdapter {
    fn stop_pending(&self, root: SpawnedProcess, marker: &str) {
        let mut owned = Vec::new();
        for pid in self.table.all_pids() {
            let Some(process) = self.table.process(pid) else {
                continue;
            };
            if process.uid != crate::relay::peer::current_uid()
                || self.table.environment_var(pid, MARKER).as_deref() != Some(marker)
            {
                continue;
            }
            let mut current = pid;
            for _ in 0..crate::relay::process::MAX_ANCESTRY {
                if current == root.pid {
                    owned.push(process);
                    break;
                }
                let Some(parent) = self
                    .table
                    .process(current)
                    .map(|p| p.parent)
                    .filter(|p| *p > 1 && *p != current)
                else {
                    break;
                };
                current = parent;
            }
        }
        if root.is(self.table.process(root.pid)) {
            for process in owned {
                stop_process(self.table.as_ref(), process.pid, Some(process.start));
            }
        }
    }
    pub fn new(cx: &HarnessContext) -> Self {
        let executable = executable(cx);
        let development = cx
            .app_data_dir
            .file_name()
            .is_some_and(|s| s.to_string_lossy().ends_with(".dev"));
        Self {
            executable,
            config: DroidConfig::from_env(&|k| cx.var(k), &cx.home).development(development),
            table: cx.table.clone(),
            helper: std::env::current_exe().ok(),
            environment: cx
                .environment
                .as_ref()
                .map(|f| f("droid", cx.env.clone()))
                .unwrap_or_else(|| cx.env.clone()),
            systemd_run: cx.systemd_run.clone(),
            ready_timeout: TIMEOUT,
        }
    }
    fn record(&self, target: &Target) -> Option<Record> {
        self.owns(target)
            .then(|| read_record(&runtime(&self.config).join(format!("{}.json", target.id))))
            .flatten()
            .filter(|r| r.session_id == target.id)
    }
    fn process_state(&self, agent: &Watched) -> ProcessLiveness {
        if agent.alive {
            return ProcessLiveness::Running;
        }
        let gone = |process: SpawnedProcess| {
            self.table.process_gone(process.pid)
                || self.table.zombie(process.pid)
                || self
                    .table
                    .process(process.pid)
                    .is_some_and(|p| p.start != process.start)
        };
        if agent.process.is_some_and(gone)
            || self
                .record(&agent.target)
                .is_some_and(|r| agent.process == Some(r.host) && gone(r.child))
        {
            ProcessLiveness::Exited
        } else {
            ProcessLiveness::Unknown
        }
    }
}

fn executable(cx: &HarnessContext) -> Option<PathBuf> {
    let usable =
        |p: &Path| std::fs::metadata(p).is_ok_and(|m| m.is_file() && m.mode() & 0o111 != 0);
    if let Some(path) = cx.var("RELAY_DESKTOP_DROID") {
        return Some(PathBuf::from(path)).filter(|p| usable(p));
    }
    cx.var("PATH")
        .into_iter()
        .flat_map(|p| std::env::split_paths(&p).collect::<Vec<_>>())
        .map(|p| p.join("droid"))
        .chain([
            cx.home.join(".local/bin/droid"),
            PathBuf::from("/opt/homebrew/bin/droid"),
        ])
        .find(|p| usable(p))
}

impl HarnessAdapter for DroidAdapter {
    fn descriptor(&self) -> &'static Descriptor {
        &DESCRIPTOR
    }
    fn detect(&self) -> Installed {
        // The initial JSON-RPC host uses a Unix socket; this does not
        // prevent Factory history collection on Windows.
        if let Some(reason) = unsupported() {
            return Installed::Unusable(reason);
        }
        if self.executable.is_some() && self.helper.is_some() {
            Installed::Yes
        } else {
            Installed::No
        }
    }
    fn spawn(&self) -> Option<&dyn SpawnFacet> {
        Some(self)
    }
}

impl SpawnFacet for DroidAdapter {
    fn owns(&self, target: &Target) -> bool {
        target.kind == SessionKind::Droid && is_session_id(&target.id)
    }
    fn launch(&self, launch: &Launch, started: Started) -> Result<Launched, LaunchError> {
        // Refused with the sentence alone: there is no launch to diagnose.
        if let Some(reason) = unsupported() {
            return Err(LaunchError::Unavailable(reason));
        }
        let result = (|| {
            let executable = self
                .executable
                .as_ref()
                .ok_or_else(|| LaunchError::Unavailable("Droid CLI is not installed".into()))?;
            let helper = self.helper.as_ref().ok_or_else(|| {
                LaunchError::Unavailable("Agent Relay helper is unavailable".into())
            })?;
            let dir = runtime(&self.config);
            crate::relay::paths::socket_directory(&dir)
                .map_err(|_| LaunchError::Failed("Droid spawn folder is not private".into()))?;
            let arguments = vec![
                "droid-spawn-host".into(),
                "--executable".into(),
                executable.display().to_string(),
                "--directory".into(),
                launch.directory.display().to_string(),
                "--runtime".into(),
                dir.display().to_string(),
                "--launch-id".into(),
                launch.session_id.clone(),
            ];

            let mut environment = self.environment.clone();
            environment.insert(MARKER.into(), launch.session_id.clone());
            let log = dir.join(format!("{}.host.log", launch.session_id));
            let start = |scope: Option<(&Path, &str)>| {
                let args = arguments
                    .iter()
                    .map(std::ffi::OsString::from)
                    .collect::<Vec<_>>();
                crate::relay::detach::start(
                    scope,
                    helper,
                    &args,
                    &log,
                    &launch.directory,
                    &environment,
                )
            };
            let pid = match &self.systemd_run {
                Some(systemd) => {
                    start_scoped_or_plain(systemd, &scope_unit(&launch.session_id), start)
                }
                None => start(None),
            }
            .map_err(LaunchError::Failed)?;
            let placeholder = Target::new(SessionKind::Droid, launch.session_id.clone());
            let process = self.table.process(pid).map(SpawnedProcess::of);
            started(&placeholder, process);
            let deadline = Instant::now() + self.ready_timeout;
            let ready = dir.join(format!("{}.ready.json", launch.session_id));
            loop {
                if let Some(record) = read_record(&ready).filter(|r| {
                    r.launch_id == launch.session_id && verified(r, self.table.as_ref())
                }) {
                    let target = Target::new(SessionKind::Droid, record.session_id.clone());
                    started(&target, Some(record.host));
                    match exchange(
                        &record,
                        self.table.as_ref(),
                        json!({"op":"prompt","id":launch.message_id,"text":launch.text}),
                    )
                    .and_then(|v| v["status"].as_str().map(str::to_string))
                    .as_deref()
                    {
                        Some("accepted" | "delivered") => {
                            return Ok(Launched {
                                target,
                                process: Some(record.host),
                                task: TaskHandoff::Unconfirmed("jsonrpc-input"),
                            });
                        }
                        _ => {
                            self.stop(&target, Some(&record.host));
                            return Err(LaunchError::Failed(
                                "Droid did not accept its initial task".into(),
                            ));
                        }
                    }
                }
                if self.table.process_gone(pid) || Instant::now() >= deadline {
                    if let Some(process) = process {
                        self.stop_pending(process, &launch.session_id);
                    }
                    return Err(LaunchError::Failed("Droid JSON-RPC session did not start; check `droid auth status` and sign in with `droid auth login`".into()));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        })();
        result.map_err(|error: LaunchError| {
            let args = vec![
                "exec".into(),
                "--input-format".into(),
                "stream-jsonrpc".into(),
                "--output-format".into(),
                "stream-jsonrpc".into(),
            ];
            let log = runtime(&self.config).join(format!("{}.droid.log", launch.session_id));
            error.diagnose(
                self.executable.as_deref().unwrap_or(Path::new("droid")),
                &args,
                &log,
            )
        })
    }
    fn find(&self, intent: &Intent) -> Option<(Target, Option<SpawnedProcess>)> {
        let ready = runtime(&self.config).join(format!("{}.ready.json", intent.session_id));
        let deadline = Instant::now() + TIMEOUT;
        // The host may still be completing a launch the core interrupted.
        let record = loop {
            if let Some(record) = read_record(&ready) {
                break record;
            }
            let running = intent.process.is_some_and(|p| {
                p.is(self.table.process(p.pid))
                    && self.table.environment_var(p.pid, MARKER).as_deref()
                        == Some(&intent.session_id)
            });
            if !running || Instant::now() >= deadline {
                if let Some(process) = intent.process.filter(|_| running) {
                    self.stop_pending(process, &intent.session_id);
                }
                return None;
            }
            std::thread::sleep(Duration::from_millis(50));
        };
        (record.launch_id == intent.session_id && verified(&record, self.table.as_ref())).then(
            || {
                (
                    Target::new(SessionKind::Droid, record.session_id),
                    Some(record.host),
                )
            },
        )
    }
    fn alive(&self, target: &Target, process: Option<&SpawnedProcess>) -> bool {
        self.record(target)
            .is_some_and(|r| process == Some(&r.host) && verified(&r, self.table.as_ref()))
    }
    fn stop(&self, target: &Target, process: Option<&SpawnedProcess>) {
        if let Some(record) = self
            .record(target)
            .filter(|r| process == Some(&r.host) && verified(r, self.table.as_ref()))
        {
            if exchange(&record, self.table.as_ref(), json!({"op":"stop"})).is_some() {
                let deadline = Instant::now() + Duration::from_secs(3);
                while record.host.is(self.table.process(record.host.pid))
                    && Instant::now() < deadline
                {
                    std::thread::sleep(Duration::from_millis(20));
                }
            }
            stop_process(
                self.table.as_ref(),
                record.child.pid,
                Some(record.child.start),
            );
            stop_process(
                self.table.as_ref(),
                record.host.pid,
                Some(record.host.start),
            );
        }
    }
    fn observe(&self, agents: &[Watched]) -> Vec<Observation> {
        agents
            .iter()
            .map(|a| {
                let state = self
                    .record(&a.target)
                    .filter(|r| a.process == Some(r.host))
                    .and_then(|r| exchange(&r, self.table.as_ref(), json!({"op":"status"})))
                    .and_then(|v| v["state"].as_str().map(str::to_string));
                let work = match state.as_deref() {
                    Some("idle") => WorkState::Idle,
                    Some("working") => WorkState::Working,
                    _ => WorkState::Unknown,
                };
                Observation {
                    process: self.process_state(a),
                    work,
                    turn_in_progress: work != WorkState::Idle,
                }
            })
            .collect()
    }
}

#[cfg(all(test, unix))]
mod tests;
