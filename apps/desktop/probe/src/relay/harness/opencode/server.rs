//! OpenCode's server for one spawned agent: an `opencode serve` of its own,
//! started as probe-managed OpenCode sessions start theirs
//! (`opencode_serve`), a session in the spawn's folder carrying the spawn's
//! permission rules, its first message through the managed route's
//! injector and journal, and its status. Behind `OpenCodeServer`, so the
//! adapter is tested with fakes and no test starts OpenCode.

use crate::relay::claude::AgentEnvironment;
use crate::relay::opencode::{managed::spawned, OpenCodeConfig};
use crate::relay::opencode_existing::{
    inspect_session, route_authorization, Binding, Failure, HttpResponse, HttpTransport,
    OpenCodeInjector, Outcome, Request, SystemClock,
};
use crate::relay::opencode_serve::{self, Serve, Served};
use crate::relay::process::{ProcessInfo, ProcessTable};
use crate::relay::spawn::launch::{
    scope_unit, start_scoped_or_plain, stop_process, SpawnedProcess,
};
use crate::relay::store::random_uuid;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Duration;

/// The relay workspace a spawned session's binding names: the spawn's own
/// authority, not a person's. Its owner is the spawn's id.
pub const SPAWN_AUTHORITY: &str = "agent-relay-spawn";

/// How long a server gets to come up with its session. A cold OpenCode can
/// spend tens of seconds loading its database first.
const START_TIMEOUT: Duration = Duration::from_secs(45);
/// How long OpenCode gets to show the first message in its session.
const PROMPT_TIMEOUT: Duration = Duration::from_secs(20);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

/// Why a spawn refuses an OpenCode that drops its permission rules.
pub const RULES_REFUSED: &str = "this OpenCode did not keep the spawned session's permission rules, so it could stop at a prompt nobody answers; update OpenCode, then try again";

/// One server and session to start for a spawn.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ServerStart {
    pub executable: PathBuf,
    pub directory: PathBuf,
    /// The spawn's own id (its intent's session id): the binding's owner,
    /// and the name of its log and pending-server record.
    pub spawn_id: String,
    pub title: String,
    /// The session's permission rules (`harness::opencode::permission_rules`).
    pub rules: Value,
}

/// What OpenCode's server does for a spawn.
pub trait OpenCodeServer: Send + Sync {
    /// Starts a server and a session on it, proved and read back, ready
    /// for delivery. A server that does not get there is ended.
    fn start(&self, start: &ServerStart) -> Result<Binding, String>;
    /// Hands the session one message, at most once under a deterministic
    /// id, as the managed route delivers.
    fn prompt(&self, binding: &Binding, message_id: &str, text: &str) -> Outcome;
    /// The session's status as OpenCode says it (`idle`, `busy`, `retry`);
    /// `None` when the server does not answer.
    fn status(&self, binding: &Binding) -> Option<String>;
    /// First model response: true once it completed successfully, false
    /// while unknown, or the harness's own error message.
    fn startup(&self, binding: &Binding) -> Result<bool, String>;
}

/// Where a spawn records the server it started before the session exists,
/// so a restart in between can end it.
pub fn pending_path(logs: &Path, spawn_id: &str) -> PathBuf {
    logs.join(format!("{spawn_id}.server.json"))
}

/// The server a spawn recorded before its session existed.
pub fn pending(logs: &Path, spawn_id: &str) -> Option<SpawnedProcess> {
    let bytes = std::fs::read(pending_path(logs, spawn_id)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// The real server.
pub struct SystemServer {
    pub table: Arc<dyn ProcessTable>,
    pub http: Arc<dyn HttpTransport>,
    pub environment: Option<AgentEnvironment>,
    pub systemd_run: Option<PathBuf>,
    /// Where each server writes its output, `<spawn id>.log`.
    pub logs: PathBuf,
    /// The managed OpenCode route's delivery journal.
    pub journal: PathBuf,
    /// Where Agent Relay's OpenCode plugin is, and where it listens.
    pub opencode: OpenCodeConfig,
}

impl SystemServer {
    /// The person's environment, with Agent Relay's plugin added to the
    /// server's configuration (`opencode::managed::spawned`), so a shell of the
    /// session can reply over the relay-send socket. A server that cannot
    /// load it still starts; its agent replies through MCP only.
    pub(super) fn environment(&self) -> BTreeMap<String, String> {
        let base: BTreeMap<String, String> = std::env::vars().collect();
        let mut environment = match &self.environment {
            Some(environment) => environment("opencode", base),
            None => base,
        };
        let uid = crate::relay::peer::current_uid();
        let _ = spawned::load_plugin(&self.opencode, uid, &mut environment);
        environment
    }

    /// Starts `opencode` detached, in a scope of its own where a systemd
    /// user manager runs, and records it as pending.
    fn launch(
        &self,
        start: &ServerStart,
        log: &Path,
        arguments: &[OsString],
        environment: &BTreeMap<String, String>,
    ) -> Result<i32, ()> {
        let run = |scope: Option<(&Path, &str)>| {
            let (executable, directory) = (&start.executable, &start.directory);
            crate::relay::detach::start(scope, executable, arguments, log, directory, environment)
        };
        let pid = match &self.systemd_run {
            Some(systemd_run) => {
                start_scoped_or_plain(systemd_run, &scope_unit(&random_uuid()), run)
            }
            None => run(None),
        }
        .map_err(|_| ())?;
        if let Some(process) = self.table.process(pid) {
            let record = serde_json::to_vec(&SpawnedProcess::of(process)).unwrap_or_default();
            let _ = std::fs::write(pending_path(&self.logs, &start.spawn_id), record);
        }
        Ok(pid)
    }

    /// Ready once the session exists on the proved server and reads back.
    /// Each server is asked to create it once, after it answers a read: a
    /// create whose answer is lost may still have made a session, so it is
    /// never sent again and the start fails instead. A server that replaced
    /// one that ended gets a session of its own.
    pub(super) fn ready(
        &self,
        served: &Served,
        start: &ServerStart,
        created: &mut Option<(ProcessInfo, String)>,
    ) -> Option<Result<Binding, String>> {
        let authority = (SPAWN_AUTHORITY, start.spawn_id.as_str());
        let candidate =
            |id: &str| served.binding(authority, id, &start.executable, &start.directory);
        let on_this_server = created
            .as_ref()
            .filter(|(process, _)| *process == served.process)
            .map(|(_, id)| id.clone());
        let id = match on_this_server {
            Some(id) => id,
            None => {
                let probe = candidate("ses_pending");
                let authorization = route_authorization(&*self.table, &probe).ok()?;
                let status = format!("{}/session/status", probe.endpoint);
                let serving = self.request("GET", &status, &authorization, start, None)?;
                (serving.status == 200).then_some(())?;
                let id = match self.create(&probe, &authorization, start) {
                    Ok(id) => id,
                    Err(reason) => return Some(Err(reason)),
                };
                *created = Some((served.process, id.clone()));
                id
            }
        };
        let candidate = candidate(&id);
        let timeout = Duration::from_secs(3);
        let (project_id, opencode_workspace_id) =
            inspect_session(&*self.table, &*self.http, &candidate, timeout).ok()?;
        Some(Ok(Binding {
            project_id,
            opencode_workspace_id,
            ..candidate
        }))
    }

    /// `POST /session`, once, with the spawn's title and permission rules.
    fn create(
        &self,
        server: &Binding,
        authorization: &str,
        start: &ServerStart,
    ) -> Result<String, String> {
        let body = json!({"title": start.title, "permission": start.rules}).to_string();
        let url = format!("{}/session", server.endpoint);
        let response = self
            .request("POST", &url, authorization, start, Some(body.as_bytes()))
            .ok_or("OpenCode did not answer the request to create its session")?;
        if response.status != 200 {
            return Err(format!(
                "OpenCode refused to create its session (HTTP {})",
                response.status
            ));
        }
        created_session(&response.body, &start.rules)
    }

    fn request(
        &self,
        method: &str,
        url: &str,
        authorization: &str,
        start: &ServerStart,
        body: Option<&[u8]>,
    ) -> Option<HttpResponse> {
        let directory = &start.directory;
        self.http
            .request(method, url, authorization, directory, body, REQUEST_TIMEOUT)
    }
}

impl OpenCodeServer for SystemServer {
    fn start(&self, start: &ServerStart) -> Result<Binding, String> {
        std::fs::create_dir_all(&self.logs)
            .map_err(|error| format!("could not make the spawn log folder: {error}"))?;
        let log = self.logs.join(format!("{}.log", start.spawn_id));
        let argv = std::sync::Mutex::new(Vec::new());
        let launch = |arguments: &[OsString], environment: &BTreeMap<String, String>| {
            *argv.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = arguments
                .iter()
                .map(|arg| arg.to_string_lossy().into_owned())
                .collect();
            self.launch(start, &log, arguments, environment)
        };
        let terminate = |process: ProcessInfo| {
            stop_process(&*self.table, process.pid, Some(process.start));
        };
        let serve = Serve {
            table: &*self.table,
            owner_uid: crate::relay::peer::current_uid(),
            environment: self.environment(),
            timeout: START_TIMEOUT,
            start: &launch,
            terminate: &terminate,
        };
        let mut created = None;
        let mut last = None;
        let result = opencode_serve::serve(&serve, &mut |served| {
            last = Some(served.process);
            self.ready(served, start, &mut created)
        });
        match result {
            Ok(Ok(binding)) => Ok(binding),
            Ok(Err(reason)) => {
                if let Some(process) = last {
                    terminate(process);
                }
                Err(super::super::diagnostics::launch_failure(
                    &reason,
                    &start.executable,
                    &argv.lock().unwrap_or_else(|poisoned| poisoned.into_inner()),
                    &log,
                ))
            }
            Err(_) => Err(super::super::diagnostics::launch_failure(
                "its server did not come up with a session",
                &start.executable,
                &argv.lock().unwrap_or_else(|poisoned| poisoned.into_inner()),
                &log,
            )),
        }
    }

    fn prompt(&self, binding: &Binding, message_id: &str, text: &str) -> Outcome {
        let clock = Arc::new(SystemClock);
        let injector =
            OpenCodeInjector::new(self.table.clone(), self.http.clone(), clock, &self.journal);
        let Ok(injector) = injector else {
            return Outcome::Refused(Failure::JournalUnavailable);
        };
        let cancelled = AtomicBool::new(false);
        injector.inject(&Request {
            binding,
            relay_workspace_id: &binding.relay_workspace_id,
            delivery_id: message_id,
            message_id,
            text,
            timeout: PROMPT_TIMEOUT,
            cancelled: &cancelled,
        })
    }

    fn startup(&self, binding: &Binding) -> Result<bool, String> {
        super::startup::read(&self.opencode, &binding.session_id)
    }

    fn status(&self, binding: &Binding) -> Option<String> {
        let authorization = route_authorization(&*self.table, binding).ok()?;
        let url = format!("{}/session/status", binding.endpoint.trim_end_matches('/'));
        let response = self.http.request(
            "GET",
            &url,
            &authorization,
            &binding.directory,
            None,
            REQUEST_TIMEOUT,
        )?;
        (response.status == 200).then_some(())?;
        session_status(&response.body, &binding.session_id)
    }
}

/// The id of the session `POST /session` created, once it is sure to carry
/// every one of `rules`; an OpenCode that drops them is refused.
pub fn created_session(body: &[u8], rules: &Value) -> Result<String, String> {
    let value: Value = serde_json::from_slice(body)
        .map_err(|_| "OpenCode answered the new session unreadably".to_string())?;
    let id = value["id"]
        .as_str()
        .filter(|id| crate::relay::opencode::is_session_id(id))
        .ok_or("OpenCode created a session without a usable id")?;
    let kept = value["permission"].as_array();
    let all_kept = rules.as_array().is_some_and(|rules| {
        rules
            .iter()
            .all(|rule| kept.is_some_and(|kept| kept.contains(rule)))
    });
    if !all_kept {
        return Err(RULES_REFUSED.into());
    }
    Ok(id.to_string())
}

/// A session's status in `GET /session/status`, which lists only sessions
/// that are not idle.
pub fn session_status(body: &[u8], session_id: &str) -> Option<String> {
    let value: Value = serde_json::from_slice(body).ok()?;
    let statuses = value.as_object()?;
    let status = statuses
        .get(session_id)
        .and_then(|status| status["type"].as_str());
    Some(status.unwrap_or("idle").to_string())
}
