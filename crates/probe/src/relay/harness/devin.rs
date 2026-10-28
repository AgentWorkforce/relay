//! Persistent Devin ACP workers. A detached probe host owns ACP stdio and a
//! private control socket, so idle workers can take another turn after the
//! desktop restarts. Existing terminal/Cloud Devin sessions are never adopted.

#[cfg(unix)]
pub mod host;
/// The ACP host owns a Unix control socket and is admitted by the kernel's
/// peer credentials. On Windows, where Devin is not available,
/// `relay devin-spawn-host` refuses with the sentence the adapter gives.
#[cfg(windows)]
pub mod host {
    use std::path::Path;

    pub fn run(
        _executable: &Path,
        _directory: &Path,
        _runtime: &Path,
        _launch_id: &str,
        _full_access: bool,
    ) -> anyhow::Result<()> {
        anyhow::bail!(crate::relay::existing_session::platform::unavailable(
            super::DESCRIPTOR.label
        ))
    }
}
pub mod mcp;

use super::{
    Builtin, Descriptor, FullAccess, HarnessAdapter, HarnessContext, HarnessId, Installed,
    SpawnFacet,
};
use crate::relay::devin::{is_session_id, DevinConfig};
use crate::relay::existing_session::platform::{self, MetadataExt, OpenOptionsExt};
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
use crate::relay::store::{SessionKind, Target};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

pub const ID: HarnessId = HarnessId("devin");
pub const DESCRIPTOR: Descriptor = Descriptor {
    id: ID,
    label: "Devin",
    billing: true,
    full_access: Some(FullAccess {
        detail: "Spawned Devin uses dangerous permission mode. Off uses accept-edits and permits only the private Agent Relay send tool; other approval requests are refused.",
        default: false,
    }),
};
pub const BUILTIN: Builtin = Builtin {
    descriptor: &DESCRIPTOR,
    adapter,
};
fn adapter(cx: &HarnessContext) -> Arc<dyn HarnessAdapter> {
    Arc::new(DevinAdapter::new(cx))
}
const MARKER: &str = "AGENT_RELAY_DEVIN_SPAWN";
const TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Record {
    pub launch_id: String,
    pub session_id: String,
    pub host: SpawnedProcess,
    pub child: SpawnedProcess,
    pub socket: PathBuf,
    pub executable: PathBuf,
}

pub fn runtime(config: &DevinConfig) -> PathBuf {
    config.data_dir.join("relay").join(if config.development {
        "spawned-dev"
    } else {
        "spawned"
    })
}

fn private(path: &Path, directory: bool) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|m| {
        m.uid() == crate::relay::peer::current_uid()
            && m.mode() & 0o077 == 0
            && if directory { m.is_dir() } else { m.is_file() }
    })
}

pub(super) fn read_record(path: &Path) -> Option<Record> {
    if !private(path.parent()?, true) || !private(path, false) {
        return None;
    }
    let file = std::fs::File::open(path).ok()?;
    serde_json::from_reader(file.take(16_385)).ok()
}

#[cfg_attr(windows, allow(dead_code))] // Only the Unix ACP host writes one.
pub(super) fn write_record(path: &Path, record: &Record) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&tmp)?;
    serde_json::to_writer(&mut file, record)?;
    file.sync_all()?;
    std::fs::rename(tmp, path)
}

fn verified(record: &Record, table: &dyn ProcessTable) -> bool {
    let uid = crate::relay::peer::current_uid();
    record.host.is(table.process(record.host.pid))
        && record.child.is(table.process(record.child.pid))
        && table.process(record.host.pid).is_some_and(|p| p.uid == uid)
        && table
            .process(record.child.pid)
            .is_some_and(|p| p.uid == uid && p.parent == record.host.pid)
        && table.environment_var(record.host.pid, MARKER).as_deref() == Some(&record.launch_id)
        && table.environment_var(record.child.pid, MARKER).as_deref() == Some(&record.launch_id)
        && std::fs::canonicalize(&record.executable).is_ok_and(|expected| {
            table
                .executable(record.child.pid)
                .and_then(|p| std::fs::canonicalize(p).ok())
                == Some(expected)
        })
        && !table.zombie(record.host.pid)
        && !table.zombie(record.child.pid)
}

/// One request to the host's control socket, admitted only from the host
/// the kernel reports at the other end.
#[cfg(unix)]
pub(super) fn exchange(record: &Record, table: &dyn ProcessTable, request: Value) -> Option<Value> {
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::fs::FileTypeExt;
    use std::os::unix::net::UnixStream;
    if !verified(record, table) {
        return None;
    }
    let metadata = std::fs::symlink_metadata(&record.socket).ok()?;
    if !metadata.file_type().is_socket()
        || metadata.uid() != crate::relay::peer::current_uid()
        || metadata.mode() & 0o077 != 0
    {
        return None;
    }
    let mut stream = UnixStream::connect(&record.socket).ok()?;
    let peer = crate::relay::peer::peer_credentials(&stream).ok()?;
    if peer.uid != crate::relay::peer::current_uid() || peer.pid != Some(record.host.pid) {
        return None;
    }
    stream.set_read_timeout(Some(Duration::from_secs(3))).ok()?;
    stream
        .set_write_timeout(Some(Duration::from_secs(3)))
        .ok()?;
    writeln!(stream, "{request}").ok()?;
    let mut response = String::new();
    BufReader::new(stream)
        .take(32_769)
        .read_line(&mut response)
        .ok()?;
    serde_json::from_str(&response).ok()
}

/// No host runs on Windows, where Devin is not available: nothing answers.
#[cfg(windows)]
pub(super) fn exchange(
    _record: &Record,
    _table: &dyn ProcessTable,
    _request: Value,
) -> Option<Value> {
    None
}

pub fn deliver(
    config: &DevinConfig,
    table: &dyn ProcessTable,
    session: &str,
    id: &str,
    text: &str,
) -> Option<InjectOutcome> {
    if !is_session_id(session) {
        return None;
    }
    let path = runtime(config).join(format!("{session}.json"));
    if !path.exists() {
        return None;
    }
    let Some(record) = read_record(&path).filter(|r| r.session_id == session) else {
        return Some(InjectOutcome::Refused(
            "Devin spawn ownership could not be verified".into(),
        ));
    };
    Some(
        match exchange(&record, table, json!({"op":"prompt", "id":id, "text":text}))
            .and_then(|v| v["status"].as_str().map(str::to_string))
            .as_deref()
        {
            Some("delivered") => InjectOutcome::Delivered,
            Some("accepted") => InjectOutcome::Accepted("Devin ACP host queued this turn".into()),
            Some("refused") => InjectOutcome::Refused("Devin ACP refused the turn".into()),
            Some("in_doubt") | None => InjectOutcome::InDoubt(
                "Devin ACP handoff could not be confirmed; it will not be repeated".into(),
            ),
            _ => InjectOutcome::Waiting("Devin ACP host is not ready".into()),
        },
    )
}

pub struct DevinAdapter {
    executable: Option<PathBuf>,
    config: DevinConfig,
    table: Arc<dyn ProcessTable>,
    helper: Option<PathBuf>,
    environment: BTreeMap<String, String>,
    systemd_run: Option<PathBuf>,
    ready_timeout: Duration,
}

impl DevinAdapter {
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
            config: DevinConfig::from_env(&|k| cx.var(k), &cx.home).development(development),
            table: cx.table.clone(),
            helper: std::env::current_exe().ok(),
            environment: cx
                .environment
                .as_ref()
                .map(|f| f("devin", cx.env.clone()))
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
    if let Some(path) = cx.var("RELAY_DESKTOP_DEVIN") {
        return Some(PathBuf::from(path)).filter(|p| usable(p));
    }
    cx.var("PATH").into_iter().flat_map(|p| std::env::split_paths(&p).collect::<Vec<_>>()).map(|p|p.join("devin"))
        .chain([cx.home.join(".local/bin/devin"), PathBuf::from("/Applications/Devin.app/Contents/Resources/app/extensions/windsurf/devin/bin/devin")]).find(|p|usable(p))
}

impl HarnessAdapter for DevinAdapter {
    fn descriptor(&self) -> &'static Descriptor {
        &DESCRIPTOR
    }
    fn detect(&self) -> Installed {
        // Its ACP host is a Unix-socket process: on Windows, Devin is
        // reported unavailable.
        if let Some(reason) = platform::unsupported(DESCRIPTOR.label) {
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

impl SpawnFacet for DevinAdapter {
    fn owns(&self, target: &Target) -> bool {
        target.kind == SessionKind::Devin && is_session_id(&target.id)
    }
    fn launch(&self, launch: &Launch, started: Started) -> Result<Launched, LaunchError> {
        // Refused with the sentence alone: there is no launch to diagnose.
        if let Some(reason) = platform::unsupported(DESCRIPTOR.label) {
            return Err(LaunchError::Unavailable(reason));
        }
        let result = (|| {
            let executable = self
                .executable
                .as_ref()
                .ok_or_else(|| LaunchError::Unavailable("Devin CLI is not installed".into()))?;
            let helper = self.helper.as_ref().ok_or_else(|| {
                LaunchError::Unavailable("Agent Relay helper is unavailable".into())
            })?;
            let dir = runtime(&self.config);
            crate::relay::paths::socket_directory(&dir)
                .map_err(|_| LaunchError::Failed("Devin spawn folder is not private".into()))?;
            let mut arguments = vec![
                "relay".into(),
                "devin-spawn-host".into(),
                "--executable".into(),
                executable.display().to_string(),
                "--directory".into(),
                launch.directory.display().to_string(),
                "--runtime".into(),
                dir.display().to_string(),
                "--launch-id".into(),
                launch.session_id.clone(),
            ];
            if launch.full_access {
                arguments.push("--full-access".into());
            }
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
            let placeholder = Target::new(SessionKind::Devin, launch.session_id.clone());
            let process = self.table.process(pid).map(SpawnedProcess::of);
            started(&placeholder, process);
            let deadline = Instant::now() + self.ready_timeout;
            let ready = dir.join(format!("{}.ready.json", launch.session_id));
            loop {
                if let Some(record) = read_record(&ready).filter(|r| {
                    r.launch_id == launch.session_id && verified(r, self.table.as_ref())
                }) {
                    let target = Target::new(SessionKind::Devin, record.session_id.clone());
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
                                task: TaskHandoff::Unconfirmed("acp-input"),
                            });
                        }
                        _ => {
                            self.stop(&target, Some(&record.host));
                            return Err(LaunchError::Failed(
                                "Devin did not accept its initial task".into(),
                            ));
                        }
                    }
                }
                if self.table.process_gone(pid) || Instant::now() >= deadline {
                    if let Some(process) = process {
                        self.stop_pending(process, &launch.session_id);
                    }
                    return Err(LaunchError::Failed("Devin ACP session did not start; check `devin auth status` and sign in with `devin auth login`".into()));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        })();
        result.map_err(|error: LaunchError| {
            let args = vec![
                "--permission-mode".into(),
                if launch.full_access {
                    "dangerous"
                } else {
                    "accept-edits"
                }
                .into(),
                "acp".into(),
            ];
            let log = runtime(&self.config).join(format!("{}.devin.log", launch.session_id));
            error.diagnose(
                self.executable.as_deref().unwrap_or(Path::new("devin")),
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
                    Target::new(SessionKind::Devin, record.session_id),
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

// The tests run the ACP host over its Unix control socket.
#[cfg(test)]
#[cfg(unix)]
mod tests;

#[cfg(test)]
#[cfg(windows)]
mod windows_tests {
    use super::*;

    #[test]
    fn devin_is_not_available_on_windows() {
        let home = tempfile::tempdir().unwrap();
        let cx = HarnessContext::local(&BTreeMap::new(), home.path(), &home.path().join("data"));
        let adapter = DevinAdapter::new(&cx);
        assert_eq!(
            adapter.detect(),
            Installed::Unusable("Devin is not available on Windows.".into())
        );
    }
}
