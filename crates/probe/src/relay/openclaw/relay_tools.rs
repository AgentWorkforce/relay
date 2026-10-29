//! Agent Relay's own tools for the person's OpenClaw agents, in one click.
//!
//! The hosted Agent Relay MCP (`<site>/cloud/api/v1/mcp/shared-sessions`)
//! lets an agent list the relay's agents, message them and spawn new ones.
//! OpenClaw reaches it as an HTTP MCP server in `openclaw.json`
//! (`mcp.servers.agent_relay`, `auth: "oauth"`) and signs in with `openclaw
//! mcp login`, which prints the hosted MCP's consent page and waits on a
//! loopback callback while the person picks a workspace and approves.
//!
//! - **Connect** reuses a server already pointing at that URL, whatever its
//!   name, or adds `agent_relay` through OpenClaw's own `openclaw mcp add`;
//!   an `agent_relay` with another address is the person's and is never
//!   overwritten. It then starts `openclaw mcp login`, answers with the
//!   authorization URL for the app to open, and keeps the login running in
//!   the background until the browser returns to it.
//! - **Status** is `waiting` while that login runs, else what `openclaw mcp
//!   status --json` reports for the server, read again at most every 30 s.
//!   OpenClaw keeps the credentials; no token is read or shown here.
//!
//! A relay sender who is not trusted never gets these tools: delivery turns
//! the server off in that sender's session (`delivery::owner_servers`).

use super::OpenClawConfig;
use crate::relay::contract::openclaw::{
    OpenClawToolsConnect, OpenClawToolsState, OpenClawToolsStatus,
};
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

mod cli;
mod methods;
mod servers;

pub use cli::Cli;
pub use methods::call;
pub use servers::{authorization, entry, Authorization, Entry};

/// The name Connect gives the server it adds.
pub const SERVER_NAME: &str = "agent_relay";

/// The hosted Agent Relay MCP's path on the site.
pub const MCP_PATH: &str = "/cloud/api/v1/mcp/shared-sessions";

pub const CLI_MISSING: &str =
    "Agent Relay couldn't find OpenClaw's command-line tool on this computer.";
pub const LOGIN_UNSUPPORTED: &str =
    "This version of OpenClaw can't sign in to MCP servers. Updating OpenClaw adds it.";
pub const CONFLICT: &str = "openclaw.json already has an agent_relay server with a different address. Remove or rename it, then connect again.";
pub const LOGIN_FAILED: &str = "OpenClaw couldn't finish signing in. Try Connect again.";
pub const NO_ANSWER: &str = "OpenClaw's command-line tool didn't answer in time.";
pub const ADD_FAILED: &str = "OpenClaw couldn't add Agent Relay's MCP server to openclaw.json.";
pub const TURNED_OFF: &str = "OpenClaw is turned off in Agent Relay's settings.";
pub const STARTING: &str = "OpenClaw's Gateway is still starting. Try again in a moment.";
pub const UNREACHABLE: &str = "Agent Relay can't reach OpenClaw's Gateway to check what it supports. Start OpenClaw, then try again.";
pub const GATEWAY_OWNS: &str = "OpenClaw's Gateway is running, and this version of OpenClaw signs in to MCP servers only while it is stopped. Agent Relay doesn't stop your Gateway: stop it, connect here, then start it again.";
pub const ENABLE_FAILED: &str =
    "OpenClaw couldn't turn on Agent Relay's MCP server in openclaw.json.";

/// Why a handshake did not tell what the Gateway supports.
fn handshake_failure(error: &super::GatewayError) -> String {
    match error {
        super::GatewayError::Busy => STARTING.into(),
        super::GatewayError::Rejected { message, .. } => {
            super::Unavailable::Refused(message.clone()).reason()
        }
        super::GatewayError::Unreachable | super::GatewayError::NoResponse => UNREACHABLE.into(),
    }
}

/// Why the tools are withheld on a Gateway that cannot limit relay
/// sessions: an untrusted sender's session there keeps every MCP server.
pub fn unlimited(version: &str) -> String {
    format!(
        "OpenClaw {version} can't keep these tools away from people who aren't trusted senders. Updating OpenClaw to {} or later lets you connect them.",
        super::LIMITS_FROM
    )
}

/// How long a status read is reused (each one starts node).
const STATUS_TTL: Duration = Duration::from_secs(30);
/// How long `mcp status` and `mcp add` may take.
const CLI_TIMEOUT: Duration = Duration::from_secs(20);
/// How long `mcp login` may take to print its URL.
const LOGIN_URL_TIMEOUT: Duration = Duration::from_secs(20);
/// How often a background login is checked for its end.
const REAP_EVERY: Duration = Duration::from_millis(250);

/// The hosted MCP's URL on `site`.
pub fn mcp_url(site: &str) -> String {
    format!("{}{MCP_PATH}", site.trim().trim_end_matches('/'))
}

/// Whether `url` is the hosted Agent Relay MCP, on any site.
pub fn is_relay_mcp_url(url: &str) -> bool {
    url.trim().trim_end_matches('/').ends_with(MCP_PATH)
}

fn status_of(state: OpenClawToolsState, detail: Option<&str>) -> OpenClawToolsStatus {
    OpenClawToolsStatus {
        state,
        detail: detail.map(str::to_string),
    }
}

/// A login waiting for the browser.
struct Login {
    child: Arc<Mutex<Child>>,
    url: String,
    /// Set when Agent Relay stopped it, so its end is not a failure.
    stopped: Arc<AtomicBool>,
}

#[derive(Default)]
struct State {
    login: Option<Login>,
    cached: Option<(Instant, OpenClawToolsStatus)>,
    /// Why the last background login ended without signing in.
    failed: Option<String>,
    /// Publishes a Settings invalidation.
    changed: Option<crate::relay::settings_watch::SettingsChanged>,
    /// Counts the logins started, so a status read that began before one
    /// is not taken for what came after.
    logins: u64,
}

type Finder = dyn Fn() -> Option<Cli> + Send + Sync;

/// The relay tools' sign-in for one core.
pub struct RelayTools {
    config: OpenClawConfig,
    find: Box<Finder>,
    state: Arc<Mutex<State>>,
    /// One Connect at a time.
    connecting: Mutex<()>,
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl RelayTools {
    /// OpenClaw's CLI as `find` locates it, for `config`'s OpenClaw.
    pub fn new(
        config: &OpenClawConfig,
        find: impl Fn() -> Option<Cli> + Send + Sync + 'static,
    ) -> Self {
        RelayTools {
            config: config.clone(),
            find: Box::new(find),
            state: Arc::default(),
            connecting: Mutex::new(()),
        }
    }

    /// This computer's OpenClaw: a running Gateway of `uid`, else a
    /// launcher where package managers install one, else `PATH`.
    pub fn system(
        config: &OpenClawConfig,
        table: Arc<dyn crate::relay::process::ProcessTable>,
        uid: u32,
        home: &std::path::Path,
    ) -> Self {
        let dirs = {
            let config = config.clone();
            cli::search_dirs(home, &move |key| config.var(key))
        };
        Self::new(config, move || {
            cli::from_gateway(&*table, uid).or_else(|| cli::from_dirs(&dirs))
        })
    }

    /// The CLI, pointed at the config this core reads, with the launcher's
    /// own directory first on `PATH` so its `#!/usr/bin/env node` resolves.
    fn cli(&self) -> Option<Cli> {
        let mut cli = (self.find)()?;
        cli.env.push((
            "OPENCLAW_CONFIG_PATH".into(),
            self.config.config_path.to_string_lossy().into_owned(),
        ));
        if let Some(state) = self.config.var("OPENCLAW_STATE_DIR") {
            cli.env.push(("OPENCLAW_STATE_DIR".into(), state));
        }
        let mut path: Vec<std::path::PathBuf> = cli
            .program
            .parent()
            .map(|dir| dir.to_path_buf())
            .into_iter()
            .collect();
        let inherited = self
            .config
            .var("PATH")
            .unwrap_or_else(|| "/usr/bin:/bin:/usr/sbin:/sbin".into());
        path.extend(std::env::split_paths(&inherited));
        if let Ok(joined) = std::env::join_paths(path) {
            cli.env
                .push(("PATH".into(), joined.to_string_lossy().into_owned()));
        }
        Some(cli)
    }

    fn off(&self) -> Option<OpenClawToolsStatus> {
        if !self.config.installed() {
            Some(super::Unavailable::NotInstalled.reason())
        } else if !self.config.enabled() {
            Some(TURNED_OFF.into())
        } else {
            // Untrusted senders keep every MCP server on a Gateway that
            // cannot limit their sessions, so the tools are withheld,
            // connected or not, and until the Gateway says what it supports.
            match self
                .config
                .seen
                .get()
                .ok_or(())
                .or_else(|_| self.handshake())
            {
                Err(reason) => Some(reason),
                Ok(features) if !features.session_limits => {
                    Some(unlimited(&features.named_version()))
                }
                Ok(_) => None,
            }
        }
        .map(|reason| status_of(OpenClawToolsState::Unavailable, Some(&reason)))
    }

    /// What the Gateway supports, from a handshake (which records it in
    /// `seen`) when this core has not connected to it yet; otherwise why
    /// not, in the words OpenClaw's row uses.
    fn handshake(&self) -> Result<super::Features, String> {
        let gateway = super::gateway(&self.config).map_err(|unavailable| unavailable.reason())?;
        super::Connection::open(&self.config, &gateway)
            .map_err(|error| handshake_failure(&error))?;
        self.config.seen.get().ok_or_else(|| UNREACHABLE.into())
    }

    /// Whether the person's OpenClaw agents can use the relay's tools.
    pub fn status(&self, site: &str) -> OpenClawToolsStatus {
        if let Some(off) = self.off() {
            return off;
        }
        let logins = {
            let state = locked(&self.state);
            if state.login.is_some() {
                return status_of(OpenClawToolsState::Waiting, None);
            }
            if let Some((at, status)) = &state.cached {
                if at.elapsed() < STATUS_TTL {
                    return status.clone();
                }
            }
            state.logins
        };
        let read = self.read_status(site);
        let mut state = locked(&self.state);
        // A login Connect started while this read ran: the read is older
        // than it, so it says nothing of the sign-in now under way.
        if state.login.is_some() {
            return status_of(OpenClawToolsState::Waiting, None);
        }
        if state.logins != logins {
            return read;
        }
        if read.state == OpenClawToolsState::Connected {
            state.failed = None;
        }
        let read = match (&read.state, &state.failed) {
            (OpenClawToolsState::NotConnected, Some(failed)) => status_of(read.state, Some(failed)),
            _ => read,
        };
        if state.login.is_none() {
            state.cached = Some((Instant::now(), read.clone()));
        }
        read
    }

    fn read_status(&self, site: &str) -> OpenClawToolsStatus {
        use OpenClawToolsState::*;
        let Some(cli) = self.cli() else {
            return status_of(Unavailable, Some(CLI_MISSING));
        };
        let name = match entry(&self.config, &mcp_url(site)) {
            Err(reason) => return status_of(Unavailable, Some(&reason)),
            Ok(Entry::Conflict) => return status_of(Unavailable, Some(CONFLICT)),
            Ok(Entry::Absent) => {
                return match supports_login(&cli) {
                    Ok(()) => status_of(NotConnected, None),
                    Err(reason) => status_of(Unavailable, Some(reason)),
                }
            }
            // Turned off in openclaw.json: OpenClaw leaves it out of every
            // session, whatever the CLI says of its sign-in.
            Ok(Entry::Existing { enabled: false, .. }) => return status_of(NotConnected, None),
            Ok(Entry::Existing { name, .. }) => name,
        };
        match cli::run(cli.command(&["mcp", "status", "--json"]), CLI_TIMEOUT) {
            Err(cli::RunError::Missing) => status_of(Unavailable, Some(CLI_MISSING)),
            Err(cli::RunError::TimedOut) => status_of(Unavailable, Some(NO_ANSWER)),
            Ok(ran) if !ran.success => status_of(Unavailable, Some(LOGIN_UNSUPPORTED)),
            Ok(ran) => match authorization(&ran.stdout, &name) {
                Authorization::Authorized => status_of(Connected, None),
                Authorization::NotAuthorized | Authorization::Disabled | Authorization::Missing => {
                    status_of(NotConnected, None)
                }
                Authorization::Unsupported => status_of(Unavailable, Some(LOGIN_UNSUPPORTED)),
            },
        }
    }

    /// Starts signing OpenClaw in to the hosted MCP on `site`: the page to
    /// open, or `connected` when OpenClaw already was. A login already
    /// waiting answers with its own page again.
    pub fn connect(&self, site: &str) -> Result<OpenClawToolsConnect, String> {
        if let Some(off) = self.off() {
            return Err(off.detail.unwrap_or_default());
        }
        let _one = locked(&self.connecting);
        {
            let mut state = locked(&self.state);
            if let Some(login) = &state.login {
                return Ok(OpenClawToolsConnect {
                    state: OpenClawToolsState::Waiting,
                    authorization_url: Some(login.url.clone()),
                });
            }
            state.cached = None;
            state.failed = None;
        }
        let cli = self.cli().ok_or(CLI_MISSING)?;
        let url = mcp_url(site);
        let name = match entry(&self.config, &url)? {
            Entry::Conflict => return Err(CONFLICT.into()),
            Entry::Existing { name, enabled } => {
                // A server the person turned off is turned back on: Connect
                // is asking for it.
                if !enabled {
                    change(
                        &cli,
                        &["mcp", "configure", &name, "--enable"],
                        ENABLE_FAILED,
                    )?;
                }
                name
            }
            Entry::Absent => {
                supports_login(&cli).map_err(str::to_string)?;
                let args = add_args(&url);
                let args: Vec<&str> = args.iter().map(String::as_str).collect();
                change(&cli, &args, ADD_FAILED)?;
                SERVER_NAME.into()
            }
        };
        self.login(&cli, &name)
    }

    fn login(&self, cli: &Cli, name: &str) -> Result<OpenClawToolsConnect, String> {
        let mut child = cli
            .command(&["mcp", "login", name])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|_| CLI_MISSING)?;
        let lines = cli::lines(&mut child);
        let step = cli::await_login(&lines, Instant::now() + LOGIN_URL_TIMEOUT);
        let url = match step {
            Some(cli::Step::Url(url)) => url,
            Some(cli::Step::Saved) => {
                // It exits on its own right after; reaped off this thread.
                std::thread::spawn(move || child.wait());
                self.remember(status_of(OpenClawToolsState::Connected, None));
                return Ok(OpenClawToolsConnect {
                    state: OpenClawToolsState::Connected,
                    authorization_url: None,
                });
            }
            other => {
                cli::stop(&mut child);
                return Err(match other {
                    Some(cli::Step::Unsupported) => LOGIN_UNSUPPORTED,
                    Some(cli::Step::GatewayOwns) => GATEWAY_OWNS,
                    _ => LOGIN_FAILED,
                }
                .into());
            }
        };
        let login = Login {
            child: Arc::new(Mutex::new(child)),
            url: url.clone(),
            stopped: Arc::default(),
        };
        let mut state = locked(&self.state);
        self.reap(&login);
        state.login = Some(login);
        state.logins += 1;
        drop(state);
        Ok(OpenClawToolsConnect {
            state: OpenClawToolsState::Waiting,
            authorization_url: Some(url),
        })
    }

    fn remember(&self, status: OpenClawToolsStatus) {
        locked(&self.state).cached = Some((Instant::now(), status));
    }

    /// Watches a background login until it ends, then forgets it: a login
    /// that ended without signing in is remembered as a failure.
    fn reap(&self, login: &Login) {
        let (child, stopped, state) = (
            login.child.clone(),
            login.stopped.clone(),
            self.state.clone(),
        );
        std::thread::spawn(move || loop {
            std::thread::sleep(REAP_EVERY);
            let ended = match locked(&child).try_wait() {
                Ok(None) => continue,
                Ok(Some(status)) => status.success(),
                Err(_) => false,
            };
            let mut state = locked(&state);
            if state
                .login
                .as_ref()
                .is_some_and(|login| Arc::ptr_eq(&login.child, &child))
            {
                state.login = None;
            }
            state.cached = None;
            if !ended && !stopped.load(Ordering::SeqCst) {
                state.failed = Some(LOGIN_FAILED.into());
            }
            // The apps read Settings again, and with it this row.
            let changed = state.changed.clone();
            drop(state);
            if let Some(changed) = changed {
                changed();
            }
            return;
        });
    }

    /// Tells the apps when a background login ends (`settings_watch`).
    pub fn on_change(&self, changed: crate::relay::settings_watch::SettingsChanged) {
        locked(&self.state).changed = Some(changed);
    }

    /// Stops a login waiting for the browser.
    pub fn stop(&self) {
        if let Some(login) = locked(&self.state).login.take() {
            login.stopped.store(true, Ordering::SeqCst);
            cli::stop(&mut locked(&login.child));
        }
    }
}

impl Drop for RelayTools {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Runs one saved-server change (`mcp add`, `mcp configure`): `failed`
/// when OpenClaw refuses it for another reason than those the row names.
fn change(cli: &Cli, args: &[&str], failed: &str) -> Result<(), String> {
    match cli::run(cli.command(args), CLI_TIMEOUT) {
        Ok(ran) if ran.success => Ok(()),
        Ok(ran) => {
            let output = format!("{}\n{}", ran.stdout, ran.stderr);
            Err(if servers::gateway_owns(&output) {
                GATEWAY_OWNS
            } else if output.to_ascii_lowercase().contains("unknown option")
                || output.to_ascii_lowercase().contains("unknown command")
            {
                LOGIN_UNSUPPORTED
            } else {
                failed
            }
            .into())
        }
        Err(cli::RunError::Missing) => Err(CLI_MISSING.into()),
        Err(cli::RunError::TimedOut) => Err(NO_ANSWER.into()),
    }
}

/// Whether this OpenClaw has `mcp login`, read from its help without
/// adding anything or starting a sign-in.
fn supports_login(cli: &Cli) -> Result<(), &'static str> {
    match cli::run(cli.command(&["mcp", "login", "--help"]), CLI_TIMEOUT) {
        Ok(ran) if servers::supports_login(&format!("{}{}", ran.stdout, ran.stderr)) => Ok(()),
        Ok(_) => Err(LOGIN_UNSUPPORTED),
        Err(cli::RunError::Missing) => Err(CLI_MISSING),
        Err(cli::RunError::TimedOut) => Err(NO_ANSWER),
    }
}

/// The arguments that add the hosted MCP at `url`.
pub fn add_args(url: &str) -> Vec<String> {
    [
        "mcp",
        "add",
        SERVER_NAME,
        "--url",
        url,
        "--transport",
        "streamable-http",
        "--auth",
        "oauth",
        "--no-probe",
    ]
    .map(str::to_string)
    .to_vec()
}

// Its fake OpenClaw is a shell script.
#[cfg(test)]
#[cfg(unix)]
mod tests;
