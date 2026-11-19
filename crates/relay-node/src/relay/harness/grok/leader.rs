//! Starting a spawned Grok's leader and opening its session: the seam that
//! keeps tests from running Grok.
//!
//! The leader is `grok agent leader` on a socket of its own, started in a
//! new process session through a short-lived shell, so it outlives a core
//! restart (on Linux under a systemd user manager, inside a transient scope
//! of its own). The session is opened by a short-lived ACP client attached
//! to it, `existing_session::grok::LeaderClient`, the same client delivery
//! uses: `initialize`, `session/new`, then the first task as one
//! `session/prompt`. A fork opens a copy of another session instead of a new
//! one (`fork`). The client goes once the leader has the prompt; the turn
//! runs on in the leader.

use crate::relay::existing_session::grok::{leader_identity, loaded_session_id, LeaderClient};
use crate::relay::existing_session::Outcome;
use crate::relay::store::is_uuid;
use serde_json::json;
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::Path;
use std::time::{Duration, Instant};

/// One leader to start.
#[derive(Clone, Copy, Debug)]
pub struct LeaderStart<'a> {
    pub executable: &'a Path,
    pub socket: &'a Path,
    /// Its working folder: the agent's, which Grok's workspace sandbox
    /// keeps it to when full access is off.
    pub directory: &'a Path,
    pub environment: &'a BTreeMap<String, String>,
    /// Where its own output goes.
    pub log: &'a Path,
}

/// The session to open on a started leader.
#[derive(Clone, Copy, Debug)]
pub struct SessionOpen<'a> {
    pub executable: &'a Path,
    pub socket: &'a Path,
    pub directory: &'a Path,
    /// The first task.
    pub text: &'a str,
    /// Budget for each ACP phase; a cold initialization must not consume
    /// the time available for session creation or the first task receipt.
    pub timeout: Duration,
    /// The session to copy, when the agent starts as a fork of it.
    pub fork: Option<ForkFrom<'a>>,
}

/// The session a fork copies: Grok's id for it and the folder it ran in,
/// which is where Grok keeps it.
#[derive(Clone, Copy, Debug)]
pub struct ForkFrom<'a> {
    pub session_id: &'a str,
    pub cwd: &'a Path,
}

/// Why no session was opened.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OpenError {
    /// The leader did not open one; why, for the launch's diagnostic.
    Failed(String),
    /// The leader did not copy the session: the whole `spawn_fork_*`
    /// error Cloud shows, naming no path.
    Fork(String),
}

impl std::fmt::Display for OpenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OpenError::Failed(reason) | OpenError::Fork(reason) => f.write_str(reason),
        }
    }
}

impl std::error::Error for OpenError {}

impl From<&str> for OpenError {
    fn from(reason: &str) -> OpenError {
        OpenError::Failed(reason.into())
    }
}

impl From<String> for OpenError {
    fn from(reason: String) -> OpenError {
        OpenError::Failed(reason)
    }
}

/// What the leader reports of the session it opened.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Opened {
    pub session_id: String,
    pub model_id: String,
    pub agent_version: String,
}

/// Starts leaders and opens sessions on them. Every method may block.
pub trait LeaderRuntime: Send + Sync {
    /// Starts one leader, in `scope` (`systemd-run` and a unit name) when
    /// given; its pid.
    fn start(&self, leader: &LeaderStart, scope: Option<(&Path, &str)>) -> Result<i32, String>;
    /// Opens a session on the leader and, once `accept` takes it, gives it
    /// its first task: the session and how the leader answered the task.
    /// Nothing is sent when `accept` refuses the session.
    fn open(
        &self,
        open: &SessionOpen,
        accept: &dyn Fn(&Opened) -> bool,
    ) -> Result<(Opened, Outcome), OpenError>;
}

/// `grok agent leader` on `socket`, kept running with no client attached,
/// never replacing itself with an update while it hosts the agent (a new
/// leader would be a new process, taken for the agent's end), and not
/// connecting to grok.com's relay unless a remote client asks for it.
pub fn leader_arguments(socket: &Path) -> Vec<OsString> {
    [
        "agent",
        "leader",
        "--no-exit-on-disconnect",
        "--no-auto-update",
        "--relay-on-demand",
        "--leader-socket",
    ]
    .map(OsString::from)
    .into_iter()
    .chain(std::iter::once(socket.as_os_str().to_owned()))
    .collect()
}

/// Grok on this computer.
pub struct SystemLeaders;

impl LeaderRuntime for SystemLeaders {
    fn start(&self, leader: &LeaderStart, scope: Option<(&Path, &str)>) -> Result<i32, String> {
        crate::relay::detach::start(
            scope,
            leader.executable,
            &leader_arguments(leader.socket),
            leader.log,
            leader.directory,
            leader.environment,
        )
    }

    fn open(
        &self,
        open: &SessionOpen,
        accept: &dyn Fn(&Opened) -> bool,
    ) -> Result<(Opened, Outcome), OpenError> {
        if let Some(source) = open.fork {
            super::fork::check_source(source)?;
        }
        let mut client = LeaderClient::start(open.executable, open.socket, open.directory)
            .ok_or("its ACP client did not start")?;
        let initialized = answer(client.initialize(Instant::now() + open.timeout))?;
        let (model_id, agent_version) =
            leader_identity(&initialized).ok_or("its leader speaks another ACP version")?;
        let session_id = match open.fork {
            Some(source) => super::fork::copy(&mut client, source, open.directory, open.timeout)?,
            None => new_session(&mut client, open)?,
        };
        let opened = Opened {
            session_id,
            model_id,
            agent_version,
        };
        if !accept(&opened) {
            if let Some(source) = open.fork {
                super::fork::discard(&mut client, source, &opened.session_id, open.directory);
            }
            return Err("its leader could not be verified".into());
        }
        let outcome = client.prompt(
            &opened.session_id,
            &opened.model_id,
            open.text,
            Instant::now() + open.timeout,
        );
        if let Some(source) = open.fork {
            super::fork::settle(
                &mut client,
                source,
                &opened.session_id,
                open.directory,
                &outcome,
            );
        }
        Ok((opened, outcome))
    }
}

/// A new, empty session in the agent's folder.
fn new_session(client: &mut LeaderClient, open: &SessionOpen) -> Result<String, OpenError> {
    // Always-approve, as nobody answers a spawned agent's prompts; with
    // full access off the leader's sandbox confines it. No MCP servers
    // are added: Grok loads the person's own.
    let params = json!({
        "cwd": open.directory, "mcpServers": [], "_meta": {"yoloMode": true},
    });
    let created = answer(client.request("session/new", params, Instant::now() + open.timeout))?;
    Ok(loaded_session_id(&created)
        .filter(|id| is_uuid(id))
        .ok_or("its leader named no session")?)
}

pub(super) fn answer(
    response: Option<Result<serde_json::Value, ()>>,
) -> Result<serde_json::Value, &'static str> {
    match response {
        Some(Ok(value)) => Ok(value),
        Some(Err(())) => Err("its leader refused"),
        None => Err("its leader did not answer in time"),
    }
}
