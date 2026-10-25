//! This computer's sessions, as the core's `SessionDirectory` and
//! `Injector`: Codex threads and Claude Code sessions found from their own
//! state and the kernel's process table, fleet workers left to the fleet,
//! and each session kind's own route in and final answer out.
//!
//! `plugins` builds the daemon with these, Claude Code's direct-delivery
//! setting, and the relay-send socket.

use crate::relay::claude::{self, ClaudeConfig};
use crate::relay::claude_settings::{ClaudeSettings, DirectDeliveryError};
use crate::relay::codex::app_server::TurnError;
use crate::relay::codex::rollout::{self, RolloutSummary};
use crate::relay::codex::router::{CodexRoutes, QueueError};
use crate::relay::codex::{self, CodexConfig, CodexRouter, SystemCodexRoutes};
use crate::relay::daemon::{Config, Plugins};
use crate::relay::devin::{self, DevinConfig};
use crate::relay::existing_session::enablement;
use crate::relay::existing_session::grok::ExistingLeaderAuthority;
use crate::relay::fleet::{Fleet, Worker};
use crate::relay::grok::{GrokConfig, GrokSettings};
use crate::relay::harness::muse::courier;
use crate::relay::inject::{InjectOutcome, Injector};
use crate::relay::managed_sessions::{
    ManagedAuthority, ManagedBinding, ManagedLaunch, ManagedSessions,
};
use crate::relay::muse::MuseConfig;
use crate::relay::openclaw::OpenClawConfig;
use crate::relay::opencode::{OpenCodeConfig, OpenCodeSettings};
use crate::relay::opencode_existing;
use crate::relay::outbound::{self, RelaySend, ServingPath};
use crate::relay::outbox::effects;
use crate::relay::process::{
    claude_start_matches, codex_caller_thread, codex_locked_threads, resume_argument, ProcessTable,
    SystemProcesses, MAX_ANCESTRY,
};
use crate::relay::sessions::{
    CallerMiss, DiscoveredSession, SessionDirectory, UnreadableSessionFile,
};
use crate::relay::setup::DirectDelivery;
use crate::relay::store::{is_uuid, SessionKind, Target};
use crate::relay::workspace;
use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::Duration;

mod registered;
mod session_directory;
use session_directory::fleet_key;
mod routes;
mod terminal;

/// Where this computer's sessions keep their state, and whose they are.
#[derive(Clone, Debug)]
pub struct LocalConfig {
    pub pi: crate::relay::pi::PiConfig,
    /// Private records of leaders this core spawned; independent of existing-session discovery.
    pub spawned_grok: Option<PathBuf>,
    pub codex: CodexConfig,
    pub claude: ClaudeConfig,
    pub grok: GrokConfig,
    pub muse: MuseConfig,
    /// Delivery into Muse sessions started and owned by Relay.
    pub muse_spawn: bool,
    pub fleet: Fleet,
    /// Only this user's processes are sessions.
    pub uid: u32,
    /// Working trees automatic activation must never admit.
    pub auto_activate_excluded_dirs: Vec<PathBuf>,
    /// The already-open Grok route's own registry and journal, under the
    /// app's data directory; `None` while `AGENT_RELAY_ENABLE_EXISTING_GROK`
    /// is off, and until `plugins_with` sets it.
    pub existing_grok: Option<enablement::Paths>,
    /// The Relay-owned Muse route's delivery journal, under app data.
    pub muse_spawn_journal: Option<PathBuf>,
    pub opencode: OpenCodeConfig,
    /// Delivery into OpenCode sessions through Agent Relay's OpenCode
    /// plugin. Sessions appear only once the person turns the plugin on in
    /// Settings; `AGENT_RELAY_ENABLE_OPENCODE_OPEN=0` turns the route off.
    pub opencode_open: bool,
    /// The plugin route's delivery journal, under the app data directory;
    /// `None` while the route is off, and until `plugins_with` sets it.
    pub opencode_open_journal: Option<PathBuf>,
    /// Where Devin keeps `session_locks/` and the relay inbox its hooks drain.
    pub devin: DevinConfig,
    /// The probe install root (`~/.agentworkforce/probe`) whose per-install
    /// history catalogs list Devin Cloud sessions as remote rows — the
    /// delivery surface's only view of a session no local `devin` process
    /// has ever run. `None` leaves cloud sessions unlisted.
    pub devin_probe_root: Option<PathBuf>,
    /// The person's local OpenClaw Gateway and this core's state for it;
    /// `None` until `plugins_with` sets it, and while
    /// `AGENT_RELAY_ENABLE_OPENCLAW=0` turns the route off.
    pub openclaw: Option<OpenClawConfig>,
    /// The person's Hermes home and this core's state for it; `None` until
    /// `plugins_with` sets it, and while `AGENT_RELAY_ENABLE_HERMES=0`.
    pub hermes: Option<crate::relay::hermes::HermesConfig>,
}

impl LocalConfig {
    pub fn from_env(env: &dyn Fn(&str) -> Option<String>, home: &Path) -> LocalConfig {
        let auto_activate_excluded_dirs = env("AGENT_RELAY_AUTO_ACTIVATE_EXCLUDED_DIRS")
            .map(|value| {
                value
                    // `PATH`'s separator: `;` on Windows, where `:` is in
                    // every drive path.
                    .split(if cfg!(windows) { ';' } else { ':' })
                    .filter(|part| !part.is_empty())
                    .map(|part| expand_path(part, home))
                    .collect()
            })
            .unwrap_or_else(|| {
                vec![
                    std::env::temp_dir(),
                    PathBuf::from("/tmp"),
                    PathBuf::from("/var/tmp"),
                ]
            });
        LocalConfig {
            pi: crate::relay::pi::PiConfig::from_env(env, home),
            spawned_grok: None,
            codex: CodexConfig::from_env(env, home),
            claude: ClaudeConfig::from_env(env, home),
            grok: GrokConfig::from_env(env, home),
            muse: MuseConfig::from_env(env, home),
            muse_spawn: true,
            fleet: Fleet::new(workspace::relay_home(env, home)),
            uid: crate::relay::peer::current_uid(),
            auto_activate_excluded_dirs,
            existing_grok: None,
            muse_spawn_journal: None,
            opencode: OpenCodeConfig::from_env(env, home),
            opencode_open: env("AGENT_RELAY_ENABLE_OPENCODE_OPEN").as_deref() != Some("0"),
            opencode_open_journal: None,
            devin: DevinConfig::from_env(env, home),
            devin_probe_root: None,
            openclaw: None,
            hermes: None,
        }
    }
}

fn expand_path(value: &str, home: &Path) -> PathBuf {
    value
        .strip_prefix("~/")
        .map(|rest| home.join(rest))
        .unwrap_or_else(|| {
            if value == "~" {
                home.to_path_buf()
            } else {
                PathBuf::from(value)
            }
        })
}

/// A lexical absolute spelling, so a missing path cannot bypass a temporary
/// root merely because `canonicalize` needs it to exist.
fn normalized(path: &Path) -> PathBuf {
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => result.push(prefix.as_os_str()),
            Component::RootDir => result.push(Path::new("/")),
            Component::CurDir => {}
            Component::ParentDir => {
                result.pop();
            }
            Component::Normal(part) => result.push(part),
        }
    }
    result
}

fn path_variants(path: &Path) -> Vec<PathBuf> {
    let lexical = normalized(path);
    let mut paths = vec![lexical.clone()];
    if let Ok(resolved) = std::fs::canonicalize(path) {
        let resolved = normalized(&resolved);
        if resolved != lexical {
            paths.push(resolved);
        }
    }
    paths
}

fn is_under(path: &Path, roots: &[PathBuf]) -> bool {
    let paths = path_variants(path);
    let roots: Vec<PathBuf> = roots.iter().flat_map(|root| path_variants(root)).collect();
    paths
        .iter()
        .any(|candidate| roots.iter().any(|root| candidate.starts_with(root)))
}

/// The sessions on this computer, found from their own state.
pub struct LocalSessions {
    config: LocalConfig,
    table: Arc<dyn ProcessTable>,
    /// The fleet's sessions as last read, kept out of the listing while
    /// a broker cannot be read.
    fleet_owned: std::sync::Mutex<HashSet<Target>>,
    /// Codex's threads as last read, kept while Codex holds its database.
    codex_threads: std::sync::Mutex<Vec<DiscoveredSession>>,
    managed: Option<Arc<ManagedSessions>>,
    /// The Gateway's agents as last listed.
    openclaw: crate::relay::openclaw::Listing,
    /// Whether the Hermes API answered, as last checked.
    hermes: crate::relay::hermes::Listing,
}

impl LocalSessions {
    /// Whether a live `grok-open` row can be reached. Never bound, or bound
    /// and proving, it can. A stored binding that no longer proves can be
    /// reached only once its leader is proven dead: delivery then rebinds the
    /// session to the running leader (`rebind_open_grok`), as after Grok
    /// restarts its leader. While that leader is not proven dead, delivery
    /// waits and does not rebind, so the session is not reachable even when
    /// another leader of this user keeps its row live. Fails closed when
    /// either registry cannot be read.
    fn grok_open_reachable(&self, session_id: &str) -> bool {
        let Some(paths) = &self.config.existing_grok else {
            return false;
        };
        let Ok(existing) =
            existing_grok_bindings(&self.config, &self.table, self.managed.as_deref())
        else {
            return false;
        };
        if existing
            .free
            .iter()
            .any(|binding| binding.session_id == session_id)
        {
            return true;
        }
        let stored = match enablement::Registry::open(&paths.bindings)
            .map(|registry| registry.stored(session_id))
        {
            Ok(Ok(stored)) => stored,
            _ => return false,
        };
        match stored {
            None => true,
            Some(binding) => {
                use crate::relay::existing_session::grok::Authority;
                use crate::relay::existing_session::grok::ExistingLeaderAuthority;
                ExistingLeaderAuthority::new(self.table.clone()).dead(&binding)
            }
        }
    }

    pub fn new(config: LocalConfig, table: Arc<dyn ProcessTable>) -> LocalSessions {
        LocalSessions {
            config,
            table,
            fleet_owned: Default::default(),
            codex_threads: Default::default(),
            managed: None,
            openclaw: Default::default(),
            hermes: Default::default(),
        }
    }

    pub fn with_managed(mut self, managed: Arc<ManagedSessions>) -> Self {
        self.managed = Some(managed);
        self
    }

    fn all(&self) -> Vec<DiscoveredSession> {
        let mut found = match codex::try_discover(&self.config.codex, &*self.table, self.config.uid)
        {
            Some(threads) => {
                *self.codex_threads.lock().unwrap() = threads.clone();
                threads
            }
            None => self.codex_threads.lock().unwrap().clone(),
        };
        found.extend(claude::discover(&self.config.claude, &*self.table));
        // Each Grok row is offered exactly when delivery would use it: a
        // managed row is judged by the same per-session claim `grok_route`
        // reads, so a session both routes claim, or one whose claim cannot
        // be read, is listed under neither kind.
        if let Some(managed) = &self.managed {
            let routed = |session: &DiscoveredSession| {
                session.target.kind != SessionKind::Grok
                    || self.config.existing_grok.is_none()
                    || matches!(
                        existing_grok_claim(
                            &self.config,
                            &self.table,
                            self.managed.as_deref(),
                            &session.target.id,
                        ),
                        Ok(ExistingClaim::Absent)
                    )
            };
            found.extend(managed.sessions().into_iter().filter(routed));
        }
        if let Ok(existing) =
            existing_grok_bindings(&self.config, &self.table, self.managed.as_deref())
        {
            // A proved binding says the leader runs, not that the client
            // does: the shared leader outlives a closed TUI. The row is live
            // only while the session is still deliverable: the TUI registry
            // lists it, or the Paseo stdio client is attached to a leader
            // that is running.
            let open =
                crate::relay::grok::open_sessions(&self.config.grok, &*self.table, self.config.uid);
            let hosted: HashSet<String> =
                crate::relay::grok::paseo_sessions(&*self.table, self.config.uid)
                    .into_iter()
                    .map(|session| session.session_id)
                    .collect();
            found.extend(existing.free.iter().map(|binding| {
                let live = open.iter().any(|session| {
                    session.session_id == binding.session_id
                        && session.cwd.as_deref().is_some_and(|cwd| {
                            Path::new(cwd) == binding.cwd
                                || std::fs::canonicalize(cwd).ok()
                                    == std::fs::canonicalize(&binding.cwd).ok()
                        })
                });
                DiscoveredSession {
                    title: crate::relay::grok::binding_title(binding, &*self.table)
                        .unwrap_or_else(|| format!("Grok {}", binding.model_id)),
                    live,
                    host: hosted
                        .contains(&binding.session_id)
                        .then(|| crate::relay::paseo::HOST.to_string()),
                    ..enablement::session(binding)
                }
            }));
            found.extend(self.open_grok_sessions(&existing));
        }
        // Only Muse sessions started by Relay are listed. Arbitrary terminal
        // and app-hosted Muse sessions are intentionally not discovered.
        if self.config.muse_spawn {
            found.extend(crate::relay::muse::discover(
                &self.config.muse,
                &*self.table,
                self.config.uid,
                true,
                &|_| false,
            ));
        }
        found.extend(crate::relay::pi::discover(
            &self.config.pi,
            &*self.table,
            self.config.uid,
        ));
        // OpenCode sessions held by a process running Agent Relay's plugin,
        // which the person installs from Settings.
        if self.config.opencode_open && self.config.opencode.installed() {
            found.extend(crate::relay::opencode::discover(
                &self.config.opencode,
                &*self.table,
                self.config.uid,
            ));
            // OpenCode windows opened before the plugin was on: listed, not
            // live, until OpenCode restarts.
            found.extend(crate::relay::opencode::needing_restart(
                &self.config.opencode,
                &*self.table,
                self.config.uid,
            ));
        }
        // Devin sessions a person has running: each `devin` process proves
        // its session by the `session_locks/<id>.lock` it holds open.
        found.extend(crate::relay::devin::discover(
            &self.config.devin,
            &*self.table,
            self.config.uid,
        ));
        // Devin Cloud sessions the history catalog lists as remote stay
        // registered and deliverable while the connector's sign-in
        // resolves — the registration surface a cloud-only session could
        // never reach through a local lock. A session held locally keeps
        // its local row.
        if let Some(root) = &self.config.devin_probe_root {
            let held: HashSet<String> = found
                .iter()
                .map(|session| session.target.id.clone())
                .collect();
            found.extend(
                crate::relay::devin_cloud::discover(&self.config.devin, root)
                    .into_iter()
                    .filter(|session| !held.contains(&session.target.id)),
            );
        }
        found.extend(self.gateway_sessions());
        found
    }

    /// The Grok sessions this user has open, from Grok's own live-session
    /// registry and from `grok agent stdio` processes Paseo is driving, as
    /// `grok-open` rows that adding binds. A session already listed from its
    /// binding, or claimed by the managed registry, is not listed again; a
    /// managed registry that cannot be read lists none, as a conflict cannot
    /// be ruled out. A TUI row is live only while an already-open leader of
    /// this user is running. A Paseo row is live only while that stdio client
    /// is attached to a leader that is running: a `--no-leader` client is
    /// listed and is not deliverable.
    fn open_grok_sessions(&self, existing: &ExistingGrokBindings) -> Vec<DiscoveredSession> {
        if self.config.existing_grok.is_none() {
            return Vec::new();
        }
        let Ok(claims) = ManagedGrokClaims::read(self.managed.as_deref()) else {
            return Vec::new();
        };
        let bound: HashSet<&str> = existing
            .free
            .iter()
            .map(|binding| binding.session_id.as_str())
            .collect();
        let leader =
            !crate::relay::existing_session::grok::open_leader_pids(&*self.table, self.config.uid)
                .is_empty();
        crate::relay::grok::discover(
            &self.config.grok,
            &*self.table,
            self.config.uid,
            leader,
            &|session| bound.contains(session) || claims.sessions.contains(session),
        )
    }

    /// The Claude Code terminal session or Codex thread the process `pid`
    /// is nearest inside: the first ancestor (itself included) that is a
    /// live Claude Code session with its recorded start time, or a trusted
    /// Codex, which names its thread only by `resume <thread>`; the walk
    /// ends at the first Codex either way, so a Codex process never lends a
    /// caller an outer session's identity. A running Claude Code session
    /// whose registry file does not parse also ends the walk, as
    /// `CallerMiss::Unreadable`. A present `CODEX_THREAD_ID`
    /// decides alone after the nearest trusted Codex's writer lock is
    /// checked, including the claimed lock of a shared app-server.
    fn caller_target(&self, pid: i32) -> Result<Target, CallerMiss> {
        let table = &*self.table;
        let uid = self.config.uid;
        let claude = claude::registry(&self.config.claude, table);
        // An agent started inside another inherits its session variables,
        // so while OpenCode is the nearest agent above the caller, an
        // inherited `CODEX_THREAD_ID` or `GROK_SESSION_ID` names nobody, and
        // otherwise an inherited OpenCode tag does not.
        let opencode_nearest = self.opencode_is_nearest(pid, &claude);
        // And while Devin is the nearest agent — a session nested inside
        // Codex, say — an inherited `CODEX_THREAD_ID` or `GROK_SESSION_ID`
        // names nobody either: the walk below must reach the `devin`
        // ancestor and let its lock decide.
        let devin_nearest = self.devin_is_nearest(pid, &claude);
        if grok_caller::codex_tag_names_caller(table, pid, uid, opencode_nearest, devin_nearest) {
            return codex_caller_thread(table, pid, uid)
                .map(|id| Target::new(SessionKind::Codex, id))
                .ok_or(CallerMiss::NotASession);
        }
        // Grok gives each tool process its session's id as
        // `GROK_SESSION_ID`, the way Codex gives `CODEX_THREAD_ID`. It
        // decides alone, once the process is proven to run under a Grok
        // leader of this user and Grok lists that session.
        if let Some(session_id) = table
            .environment_var(pid, "GROK_SESSION_ID")
            .map(|id| id.trim().to_lowercase())
            .filter(|id| !opencode_nearest && !devin_nearest && is_uuid(id))
        {
            return self
                .grok_target(pid, &session_id)
                .ok_or(CallerMiss::NotASession);
        }
        // OpenCode's shells carry `AGENT_RELAY_OPENCODE_SESSION`, which
        // Agent Relay's plugin sets from OpenCode's own `shell.env` hook.
        // Where it can be read, it decides alone, once the nearest OpenCode
        // process above the caller is proven to hold that session in its
        // plugin record. macOS shows no other process the environment of an
        // Apple binary such as `curl` or `zsh`, so there the walk below
        // decides instead.
        if let Some(session_id) = table
            .environment_var(pid, OPENCODE_SESSION_VAR)
            .map(|id| id.trim().to_string())
            .filter(|id| opencode_nearest && crate::relay::opencode::is_session_id(id))
        {
            return self
                .opencode_caller(pid, Some(&session_id))
                .ok_or(CallerMiss::NotASession);
        }
        // One Grok leader can hold several sessions, and without
        // `GROK_SESSION_ID` nothing in a tool process says which one started
        // it. So while the already-open route is on, such a process under
        // any Grok leader of this user is nobody: the walk stops there rather
        // than naming one of its sessions, or an outer session, as the
        // sender. It is read from argv alone, so no registry or socket
        // failure can let the walk past a leader.
        let stop_at_grok_leaders =
            self.config.existing_grok.is_some() || self.config.spawned_grok.is_some();
        let mut current = pid;
        for _ in 0..MAX_ANCESTRY {
            if current <= 1 {
                return Err(CallerMiss::NotASession);
            }
            // An intermediate of another user (a `sudo`, say) is walked
            // past; only a session of this user's can be the caller's.
            let process = table.process(current).ok_or(CallerMiss::NotASession)?;
            let own = process.uid == uid;
            let session = claude.sessions.iter().find(|s| {
                own && s.pid == current
                    && s.can_reply()
                    && s.proc_start.as_deref().is_some_and(|start| {
                        claude_start_matches(table.start_clock(), start, &process)
                    })
            });
            if let Some(session) = session {
                // Still the same process after the registry was read.
                if table.process(current) == Some(process) {
                    return Ok(Target::new(
                        SessionKind::ClaudeTerminal,
                        session.session_id.clone(),
                    ));
                }
                return Err(CallerMiss::NotASession);
            }
            // This process is a running Claude Code session whose own
            // registry file does not parse. It is the caller's nearest
            // session, so the walk ends here rather than naming an outer
            // one, and the caller learns which file to look at.
            if let Some(file) = claude.unreadable.iter().find(|f| own && f.pid == current) {
                return Err(CallerMiss::Unreadable(file.clone()));
            }
            if own
                && stop_at_grok_leaders
                && crate::relay::existing_session::grok::is_leader(&table.arguments(current))
            {
                return Err(CallerMiss::NotASession);
            }
            // Under OpenCode, without a session tag that can be read, the
            // caller is the one session that OpenCode process holds, or
            // nobody when it holds several or none: the walk never passes an
            // OpenCode process to name an outer session.
            if own && crate::relay::opencode::is_opencode_process(table, current) {
                return self
                    .opencode_caller(pid, None)
                    .ok_or(CallerMiss::NotASession);
            }
            // Only a Relay-spawned Muse process may identify a session. An
            // arbitrary Muse process is a boundary and never borrows an
            // outer session's relay identity.
            if own && self.config.muse_spawn && crate::relay::muse::is_muse_process(table, current)
            {
                let session =
                    crate::relay::muse::session_for_pid(&self.config.muse, table, uid, current);
                let same = table.process(current) == Some(process);
                return session
                    .filter(|_| same)
                    .map(|session| Target::new(SessionKind::MuseOpen, session.session_id))
                    .ok_or(CallerMiss::NotASession);
            }
            // The first `devin` ancestor decides: it is the session whose
            // `session_locks/<id>.lock` it holds open, or nobody — a Devin
            // command that is not a session never lends a caller the outer
            // session's identity.
            if own && devin::is_devin_process(table, current) {
                let session = devin::held_session(&self.config.devin, table, current);
                let same = table.process(current) == Some(process);
                return session
                    .filter(|_| same)
                    .map(|id| Target::new(SessionKind::Devin, id))
                    .ok_or(CallerMiss::NotASession);
            }
            let trusted = own
                && table
                    .executable(current)
                    .is_some_and(|exe| table.is_trusted_codex(&exe));
            if trusted {
                let arguments = table.arguments(current);
                let thread = resume_argument(&arguments)
                    .map(str::to_lowercase)
                    .filter(|id| is_uuid(id));
                let same = table.process(current) == Some(process);
                return thread
                    .filter(|_| same)
                    .map(|id| Target::new(SessionKind::Codex, id))
                    .ok_or(CallerMiss::NotASession);
            }
            current = process.parent;
        }
        Err(CallerMiss::NotASession)
    }
}

impl SessionDirectory for LocalSessions {
    fn title_capability(&self, source: &str, session_id: &str) -> crate::relay::contract::agents::SessionTitleCapability {
        self.native_title_capability(source, session_id)
    }

    fn set_title(&self, source: &str, session_id: &str, title: &str) -> Result<String, String> {
        self.set_native_title(source, session_id, title)
    }

    fn sessions(&self) -> Vec<DiscoveredSession> {
        self.discovered_sessions()
    }

    fn auto_activation_sessions(&self) -> Vec<DiscoveredSession> {
        let claude_sessions = claude::registry(&self.config.claude, &*self.table).sessions;
        let grok_reachable = |session_id: &str| self.grok_open_reachable(session_id);
        self.sessions()
            .into_iter()
            .filter(|session| {
                if !session.live {
                    return false;
                }
                // A Devin Cloud row's `live` already proved this machine's
                // sign-in can reach it — the caller proof a local lock
                // proves for a local row — so it activates the same way,
                // and a remote directory has nothing local to exclude.
                if session.target.kind == SessionKind::Devin
                    && session.host.as_deref() == Some(crate::relay::devin_cloud::CLOUD_HOST)
                {
                    return true;
                }
                if let Some(admitted) = self.gateway_admits(session.target.kind) {
                    return admitted;
                }
                let Some(directory) = session.directory.as_deref().map(Path::new) else {
                    return false;
                };
                if is_under(directory, &self.config.auto_activate_excluded_dirs) {
                    return false;
                }
                match session.target.kind {
                    SessionKind::ClaudeTerminal => claude::terminal_session(
                        &self.config.claude,
                        &*self.table,
                        &session.target.id,
                    )
                    .is_some_and(|terminal| {
                        claude::is_interactive_terminal(&*self.table, &terminal)
                            || claude::is_conductor_chat(
                                &*self.table,
                                self.config.uid,
                                &terminal,
                                &claude_sessions,
                            )
                            || claude::is_app_hosted_chat(&*self.table, &terminal, &claude_sessions)
                    }),
                    SessionKind::Codex => true,
                    SessionKind::ClaudeCloud => false,
                    // A Grok TUI session is live only while a leader of this
                    // user is running, the one route into it; registering it
                    // binds and proves that leader first, and a binding that
                    // does not prove is refused, so nothing is sent.
                    SessionKind::GrokOpen => grok_reachable(&session.target.id),
                    // Launched by the probe, which registers it itself.
                    SessionKind::Grok | SessionKind::OpenCode => false,
                    // Relay's spawner registers Muse itself; discovery never
                    // turns a Muse registry record into a new agent.
                    SessionKind::MuseOpen => false,
                    // Opt-in, like every provider route the plugin opens.
                    SessionKind::OpenCodeOpen | SessionKind::Pi => false,
                    // A Devin row exists only while a `devin` process holds
                    // the session's lock open, which is also its caller
                    // proof. Devin Cloud rows return early above; any other
                    // hosted row is never activated.
                    SessionKind::Devin => session.host.is_none(),
                    SessionKind::OpenClaw | SessionKind::Hermes => false,
                }
            })
            .collect()
    }

    fn archived(&self, targets: &[Target]) -> HashSet<Target> {
        let of_kind = |kinds: &[SessionKind]| {
            targets
                .iter()
                .filter(|target| kinds.contains(&target.kind))
                .map(|target| target.id.as_str())
                .collect::<Vec<_>>()
        };
        let codex = of_kind(&[SessionKind::Codex]);
        let codex = codex::threads::archived_ids(&self.config.codex, codex);
        let opencode = of_kind(&[SessionKind::OpenCode, SessionKind::OpenCodeOpen]);
        let opencode = crate::relay::opencode::archived_ids(&self.config.opencode, opencode);
        // A Claude app session's archive is learned from the send it
        // refuses; the other kinds have no archive.
        targets
            .iter()
            .filter(|target| match target.kind {
                SessionKind::Codex => codex.contains(&target.id),
                SessionKind::OpenCode | SessionKind::OpenCodeOpen => opencode.contains(&target.id),
                _ => false,
            })
            .cloned()
            .collect()
    }

    fn caller(&self, pid: i32) -> Result<DiscoveredSession, CallerMiss> {
        // Everything under this user's OpenClaw Gateway (its Codex runtime
        // and the shells that runs, included) is the Gateway's agent, so
        // an inherited Codex thread tag never names the caller.
        let target = match self.openclaw_caller(pid) {
            Some(caller) => caller?,
            None => self.caller_target(pid)?,
        };
        // Named from the session's own state, never by scanning every
        // process: identifying a caller reads only its ancestry.
        let found = match target.kind {
            SessionKind::Codex => codex::thread(&self.config.codex, &target.id),
            SessionKind::ClaudeTerminal => {
                claude::terminal_session(&self.config.claude, &*self.table, &target.id).map(
                    |session| DiscoveredSession {
                        target: target.clone(),
                        title: session.display_name(),
                        directory: session.cwd.clone(),
                        updated_at_ms: session.updated_at_ms,
                        host: if claude::is_paseo_chat(
                            &*self.table,
                            &session,
                            &claude::registry(&self.config.claude, &*self.table).sessions,
                        ) {
                            Some(crate::relay::paseo::HOST.to_string())
                        } else {
                            crate::relay::conductor::host(session.cwd.as_deref())
                        },
                        live: true,
                        holder: Some(claude::holder(&session)),
                    },
                )
            }
            SessionKind::Grok => grok_caller::session(&self.config, &self.table, &target),
            SessionKind::GrokOpen => crate::relay::grok::discover(
                &self.config.grok,
                &*self.table,
                self.config.uid,
                true,
                &|_| false,
            )
            .into_iter()
            .find(|row| row.target == target),
            SessionKind::MuseOpen => crate::relay::muse::discover(
                &self.config.muse,
                &*self.table,
                self.config.uid,
                true,
                &|_| false,
            )
            .into_iter()
            .find(|row| row.target == target),
            SessionKind::OpenCodeOpen => crate::relay::opencode::discover(
                &self.config.opencode,
                &*self.table,
                self.config.uid,
            )
            .into_iter()
            .find(|row| row.target == target),
            SessionKind::Devin => crate::relay::devin::session(
                &self.config.devin,
                &*self.table,
                self.config.uid,
                &target.id,
            ),
            SessionKind::ClaudeCloud
            | SessionKind::OpenCode
            | SessionKind::OpenClaw
            | SessionKind::Hermes
            | SessionKind::Pi => None,
        };
        Ok(found
            .map(|s| DiscoveredSession { live: true, ..s })
            .unwrap_or_else(|| DiscoveredSession {
                title: match target.kind {
                    SessionKind::Codex => "Codex session".into(),
                    SessionKind::ClaudeTerminal | SessionKind::ClaudeCloud => {
                        "Claude Code session".into()
                    }
                    SessionKind::Grok | SessionKind::GrokOpen => "Grok session".into(),
                    SessionKind::OpenCode | SessionKind::OpenCodeOpen => "OpenCode session".into(),
                    SessionKind::MuseOpen => "Muse session".into(),
                    SessionKind::Devin => "Devin session".into(),
                    SessionKind::OpenClaw => "OpenClaw agent".into(),
                    SessionKind::Hermes => "Hermes".into(),
                    SessionKind::Pi => "Pi session".into(),
                },
                target,
                directory: None,
                updated_at_ms: None,
                holder: None,
                host: None,
                live: true,
            }))
    }

    fn holds_codex_thread(&self, pid: i32, thread: &str) -> bool {
        crate::relay::process::has_codex_writer_for_caller(
            &*self.table,
            pid,
            self.config.uid,
            thread,
        )
    }

    fn unreadable_session_files(&self) -> Vec<UnreadableSessionFile> {
        claude::registry(&self.config.claude, &*self.table).unreadable
    }

    fn fleet_owned(&self, target: &Target) -> Result<bool, String> {
        self.config
            .fleet
            .managed_targets_blocking()
            .map(|owned: HashSet<Target>| owned.contains(&fleet_key(target)))
            .map_err(|error| error.message)
    }

    fn launch_managed(&self, launch: ManagedLaunch) -> Result<DiscoveredSession, String> {
        self.managed
            .as_ref()
            .ok_or_else(|| "Managed provider launch is unavailable.".to_string())?
            .launch(launch)
    }

    fn route_binding(&self, target: &Target) -> Option<String> {
        self.live_route_binding(target)
    }

    fn register_existing(
        &self,
        request: enablement::OpenLeaderRequest,
    ) -> Result<DiscoveredSession, String> {
        self.register_existing_with(request, &|binding, authority| {
            crate::relay::existing_session::grok::inspect_session(
                binding,
                authority,
                EXISTING_GROK_INSPECT_TIMEOUT,
            )
        })
    }

    fn managed_authority(
        &self,
        target: &Target,
    ) -> Option<crate::relay::managed_sessions::ManagedAuthority> {
        if !matches!(target.kind, SessionKind::Grok | SessionKind::GrokOpen) {
            return self.managed.as_ref()?.authority(target);
        }
        match grok_route(&self.config, &self.table, self.managed.as_deref(), target) {
            GrokRoute::Managed(binding) => Some(binding.authority()),
            GrokRoute::Existing(binding) => Some(ManagedAuthority {
                workspace_id: binding.workspace_id,
                owner_id: binding.owner_id,
                owner_uid: binding.owner_uid,
            }),
            GrokRoute::Ambiguous | GrokRoute::Unavailable | GrokRoute::None => None,
        }
    }
}

/// What Agent Relay's OpenCode plugin names a shell's session by.
const OPENCODE_SESSION_VAR: &str = "AGENT_RELAY_OPENCODE_SESSION";

/// Grok 1.0.46 can take this long to initialize an ACP client against a
/// resident leader; the managed route allows the same at launch.
const EXISTING_GROK_INSPECT_TIMEOUT: Duration = Duration::from_secs(20);

impl LocalSessions {
    /// `register_existing` with the provider readback supplied, so tests need
    /// no Grok CLI. A session or leader the managed registry claims is
    /// refused, and so is any session while that registry is unreadable.
    fn register_existing_with(
        &self,
        request: enablement::OpenLeaderRequest,
        inspect: &dyn Fn(
            &crate::relay::existing_session::Binding,
            Arc<dyn crate::relay::existing_session::grok::Authority>,
        )
            -> Result<(String, String), crate::relay::existing_session::Failure>,
    ) -> Result<DiscoveredSession, String> {
        let Some(paths) = &self.config.existing_grok else {
            return Err("Already-open Grok registration is turned off.".into());
        };
        let claims = ManagedGrokClaims::read(self.managed.as_deref())
            .map_err(|_| "Managed session registry is unavailable.".to_string())?;
        if claims.sessions.contains(&request.session_id) {
            return Err("This Grok session already has a probe-managed binding.".into());
        }
        let registry = enablement::Registry::open(&paths.bindings)
            .map_err(|_| "The registered Grok binding store is unavailable.".to_string())?;
        if let Some(reason) = crate::relay::grok::paseo_unbindable(
            &self.config.grok,
            &*self.table,
            self.config.uid,
            &request.session_id,
        ) {
            return Err(reason);
        }
        let preferred = self.session_leader_socket(&request.session_id);
        let binding = enablement::register_open_leader_preferring(
            &registry,
            self.table.clone(),
            &request,
            &claims.leaders,
            inspect,
            preferred.as_deref(),
        )?;
        let mut session = enablement::session(&binding);
        if let Some(title) = crate::relay::grok::binding_title(&binding, &*self.table) {
            session.title = title;
        }
        Ok(session)
    }
}

impl LocalSessions {
    /// The leader socket the client of `session_id` is attached to, from the
    /// process Grok lists for it (the TUI, or a Paseo stdio client that
    /// shares a running leader) and that process's own argv and environment.
    /// `None` when Grok does not list the session as deliverable, including
    /// a Paseo client started with `--no-leader`.
    fn session_leader_socket(&self, session_id: &str) -> Option<PathBuf> {
        let tui =
            crate::relay::grok::open_sessions(&self.config.grok, &*self.table, self.config.uid)
                .into_iter()
                .find(|session| session.session_id == session_id)?
                .pid;
        session_leader_socket_of(&*self.table, tui)
    }
}

/// The leader socket registration prefers for a listed Grok client. See
/// [`crate::relay::grok::preferred_leader_socket`]. A Paseo client started
/// with `--no-leader` is not listed, so this is not asked for it.
pub(crate) fn session_leader_socket_of(table: &dyn ProcessTable, tui: i32) -> Option<PathBuf> {
    crate::relay::grok::preferred_leader_socket(table, tui)
}

/// The target a fleet worker would own for `target`. A fleet Grok worker is
/// listed as `grok`, and an already-open registration of that same session
/// must not become its second identity.
/// Which Grok route may carry a delivery to one session. The probe-managed
/// and already-open routes have separate registries and journals; a session
/// both claim is refused rather than resolved by preference.
enum GrokRoute {
    Managed(ManagedBinding),
    Existing(crate::relay::existing_session::Binding),
    Ambiguous,
    /// A registry could not be read, so a conflicting claim cannot be ruled
    /// out.
    Unavailable,
    None,
}

fn grok_route(
    config: &LocalConfig,
    table: &Arc<dyn ProcessTable>,
    managed: Option<&ManagedSessions>,
    target: &Target,
) -> GrokRoute {
    // The target's kind names its one route; a registration can never be
    // carried by the other route, even after its own binding is gone.
    let managed_binding = || managed.and_then(|managed| managed.binding(target));
    match target.kind {
        SessionKind::Grok if config.existing_grok.is_none() => {
            // The other route is off: exactly main's managed lookup.
            managed_binding().map_or(GrokRoute::None, GrokRoute::Managed)
        }
        SessionKind::Grok => match existing_grok_claim(config, table, managed, &target.id) {
            Err(()) => GrokRoute::Unavailable,
            // The same session also has an already-open binding.
            Ok(ExistingClaim::Free(_) | ExistingClaim::Conflicted) => GrokRoute::Ambiguous,
            Ok(ExistingClaim::Absent) => {
                managed_binding().map_or(GrokRoute::None, GrokRoute::Managed)
            }
        },
        SessionKind::GrokOpen => match existing_grok_claim(config, table, managed, &target.id) {
            Err(()) => GrokRoute::Unavailable,
            Ok(ExistingClaim::Conflicted) => GrokRoute::Ambiguous,
            Ok(ExistingClaim::Free(binding)) => GrokRoute::Existing(binding),
            Ok(ExistingClaim::Absent) => GrokRoute::None,
        },
        _ => GrokRoute::None,
    }
}

/// Every Grok binding in the managed registry, live or not, as claims on a
/// session and on a leader process.
#[derive(Default)]
struct ManagedGrokClaims {
    sessions: HashSet<String>,
    leaders: HashSet<(i32, u64)>,
}

impl ManagedGrokClaims {
    fn read(managed: Option<&ManagedSessions>) -> Result<Self, ()> {
        let Some(managed) = managed else {
            return Ok(Self::default());
        };
        let bindings = managed.grok_claims().map_err(|_| ())?;
        Ok(Self {
            sessions: bindings.iter().map(|b| b.session_id.clone()).collect(),
            leaders: bindings
                .iter()
                .map(|b| (b.leader_pid, b.leader_start))
                .collect(),
        })
    }

    fn covers(&self, binding: &crate::relay::existing_session::Binding) -> bool {
        self.sessions.contains(&binding.session_id)
            || self
                .leaders
                .contains(&(binding.leader_pid, binding.leader_start))
    }
}

enum ExistingClaim {
    Free(crate::relay::existing_session::Binding),
    /// Proved, but the managed registry claims its session or its leader.
    Conflicted,
    Absent,
}

/// The already-open binding of one session, judged against the managed
/// registry. `Err` when either registry cannot be read: a conflict cannot
/// then be ruled out. `Absent` while the route is off.
fn existing_grok_claim(
    config: &LocalConfig,
    table: &Arc<dyn ProcessTable>,
    managed: Option<&ManagedSessions>,
    session_id: &str,
) -> Result<ExistingClaim, ()> {
    let Some(paths) = &config.existing_grok else {
        return Ok(ExistingClaim::Absent);
    };
    let claims = ManagedGrokClaims::read(managed)?;
    let registry = enablement::Registry::open(&paths.bindings).map_err(|_| ())?;
    let binding = registry
        .proved_binding(session_id, &ExistingLeaderAuthority::new(table.clone()))
        .map_err(|_| ())?;
    Ok(match binding {
        Some(binding) if claims.covers(&binding) => ExistingClaim::Conflicted,
        Some(binding) => ExistingClaim::Free(binding),
        None => ExistingClaim::Absent,
    })
}

/// Every proved already-open binding no managed claim covers. Empty while
/// the route is off. `Err` when either registry cannot be read, so no
/// conflict can be ruled out.
#[derive(Default)]
struct ExistingGrokBindings {
    free: Vec<crate::relay::existing_session::Binding>,
}

fn existing_grok_bindings(
    config: &LocalConfig,
    table: &Arc<dyn ProcessTable>,
    managed: Option<&ManagedSessions>,
) -> Result<ExistingGrokBindings, ()> {
    let Some(paths) = &config.existing_grok else {
        return Ok(ExistingGrokBindings::default());
    };
    let claims = ManagedGrokClaims::read(managed)?;
    let registry = enablement::Registry::open(&paths.bindings).map_err(|_| ())?;
    let authority = ExistingLeaderAuthority::new(table.clone());
    let mut found = ExistingGrokBindings::default();
    for binding in registry.proved(&authority).map_err(|_| ())? {
        if !claims.covers(&binding) {
            found.free.push(binding);
        }
    }
    Ok(found)
}

/// Reads back a Grok session's model and version through its leader, as
/// `grok::inspect_session` does; tests supply one that starts no Grok.
type GrokInspect = Arc<
    dyn Fn(
            &crate::relay::existing_session::Binding,
            Arc<dyn crate::relay::existing_session::grok::Authority>,
        ) -> Result<(String, String), crate::relay::existing_session::Failure>
        + Send
        + Sync,
>;

/// Each session kind's route in, reply command and final answer.
pub struct LocalInjector {
    config: LocalConfig,
    table: Arc<dyn ProcessTable>,
    codex: CodexRouter,
    grok_inspect: GrokInspect,
    /// Fleet PTY Codex workers carry an isolated `CODEX_SQLITE_HOME`.
    /// Routers are retained by their kernel-proven process binding so a
    /// Waiting handoff keeps its duplicate fence across Connect polls.
    fleet_codex: Mutex<HashMap<String, FleetCodexRouter>>,
    serving: ServingPath,
    /// Runs `claude --cloud`, with the agents' environment.
    claude: claude::SystemRunner,
    managed: Option<Arc<ManagedSessions>>,
    opencode: Option<opencode_existing::OpenCodeInjector>,
    managed_cancellations: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct FleetCodexBinding {
    worker_name: String,
    pid: i32,
    start: u64,
    config: CodexConfig,
}

struct FleetCodexRouter {
    binding: FleetCodexBinding,
    router: Arc<CodexRouter>,
}

enum FleetCodexResolution {
    NotManaged,
    Bound(FleetCodexBinding),
    Unavailable(String),
    Refused(String),
}

#[derive(Debug)]
enum FleetCodexBindingError {
    Unavailable(String),
    Refused(String),
}

impl FleetCodexBindingError {
    #[cfg(test)]
    fn reason(&self) -> &str {
        match self {
            FleetCodexBindingError::Unavailable(reason)
            | FleetCodexBindingError::Refused(reason) => reason,
        }
    }
}

fn descends_from(table: &dyn ProcessTable, mut pid: i32, root: i32, uid: u32) -> bool {
    for _ in 0..MAX_ANCESTRY {
        if pid == root {
            return true;
        }
        let Some(process) = table.process(pid).filter(|process| process.uid == uid) else {
            return false;
        };
        if process.parent <= 1 || process.parent == pid {
            return false;
        }
        pid = process.parent;
    }
    false
}

/// The fleet worker name encoded by the broker's isolated SQLite home.
fn fleet_worker_name(table: &dyn ProcessTable, pid: i32) -> Option<String> {
    fleet_worker_home(table, pid).map(|(name, _)| name)
}

fn fleet_worker_home(table: &dyn ProcessTable, pid: i32) -> Option<(String, PathBuf)> {
    let raw = table.environment_var(pid, "CODEX_SQLITE_HOME")?;
    let path = PathBuf::from(raw.trim());
    if !path.is_absolute() || path.parent()?.file_name()? != "relay-agents" {
        return None;
    }
    let name = path
        .file_name()?
        .to_str()
        .filter(|name| !name.is_empty())
        .map(str::to_string)?;
    Some((name, path))
}

fn local_fleet_codex_names(
    config: &LocalConfig,
    table: &dyn ProcessTable,
    target: &Target,
) -> HashSet<String> {
    table
        .all_pids()
        .into_iter()
        .filter(|pid| {
            table
                .process(*pid)
                .is_some_and(|process| process.uid == config.uid)
                && codex::processes::is_terminal_codex(table, *pid)
                && {
                    let locked = codex_locked_threads(table, *pid);
                    locked.len() == 1 && locked.contains(&target.id)
                }
        })
        .filter_map(|pid| fleet_worker_name(table, pid))
        .collect()
}

/// Same-user fleet SQLite homes whose own Codex catalog contains `target`.
/// Inherited environment alone is not authority: shells and MCP servers below
/// an unrelated fleet worker carry the same home. The catalog tie is what
/// permits a broker lookup while that target's Codex process is still starting.
fn local_fleet_codex_catalog_names(
    config: &LocalConfig,
    table: &dyn ProcessTable,
    target: &Target,
) -> HashSet<String> {
    let homes: HashSet<(String, PathBuf)> = table
        .all_pids()
        .into_iter()
        .filter(|pid| {
            table
                .process(*pid)
                .is_some_and(|process| process.uid == config.uid)
        })
        .filter_map(|pid| fleet_worker_home(table, pid))
        .collect();
    homes
        .into_iter()
        .filter_map(|(name, sqlite_home)| {
            let candidate = CodexConfig {
                sqlite_home,
                ..config.codex.clone()
            };
            codex::threads::contains_unarchived(&candidate, &target.id)
                .is_some_and(|found| found)
                .then_some(name)
        })
        .collect()
}

fn verified_fleet_codex_binding(
    config: &LocalConfig,
    table: &dyn ProcessTable,
    worker: &Worker,
    target: &Target,
) -> Result<FleetCodexBinding, FleetCodexBindingError> {
    let hinted_roots: Vec<i32> = [worker.pid, worker.worker_pid]
        .into_iter()
        .flatten()
        .filter_map(|pid| i32::try_from(pid).ok())
        .collect();
    let roots: Vec<(i32, crate::relay::process::ProcessInfo)> = hinted_roots
        .iter()
        .copied()
        .filter_map(|pid| {
            table
                .process(pid)
                .filter(|process| process.uid == config.uid)
                .map(|process| (pid, process))
        })
        .collect();
    if roots.is_empty() {
        let reason = "The fleet Codex worker has no live provider process.".into();
        return Err(
            if !hinted_roots.is_empty() && hinted_roots.iter().all(|pid| table.process_gone(*pid)) {
                FleetCodexBindingError::Refused(reason)
            } else {
                FleetCodexBindingError::Unavailable(reason)
            },
        );
    }

    let mut candidates = Vec::new();
    let mut saw_terminal_codex = false;
    for pid in table.all_pids() {
        let Some(process) = table
            .process(pid)
            .filter(|process| process.uid == config.uid)
        else {
            continue;
        };
        if !roots
            .iter()
            .any(|(root, _)| descends_from(table, pid, *root, config.uid))
        {
            continue;
        }
        if !codex::processes::is_terminal_codex(table, pid) {
            continue;
        }
        saw_terminal_codex = true;
        let locked = codex_locked_threads(table, pid);
        if locked.len() != 1 || !locked.contains(&target.id) || table.process(pid) != Some(process)
        {
            continue;
        }
        let Some(executable) = table
            .executable(pid)
            .filter(|path| table.is_trusted_codex(path))
        else {
            continue;
        };
        candidates.push((pid, process, executable));
    }
    if roots
        .iter()
        .any(|(pid, process)| table.process(*pid) != Some(*process))
    {
        return Err(FleetCodexBindingError::Unavailable(
            "The fleet Codex worker process changed during verification.".into(),
        ));
    }
    let [(pid, process, executable)] = candidates.as_slice() else {
        return Err(if candidates.is_empty() && !saw_terminal_codex {
            FleetCodexBindingError::Unavailable(
                "The fleet worker has not started an injectable Codex process.".into(),
            )
        } else {
            FleetCodexBindingError::Refused(if candidates.is_empty() {
                "The fleet Codex process does not own this thread.".into()
            } else {
                "More than one fleet Codex process claims this thread.".into()
            })
        });
    };
    if worker
        .session_id
        .as_deref()
        .is_some_and(|session| !session.eq_ignore_ascii_case(&target.id))
    {
        return Err(FleetCodexBindingError::Refused(
            "The fleet worker reports a different Codex thread.".into(),
        ));
    }
    let home = match table.environment_var(*pid, "CODEX_HOME") {
        Some(raw) if !raw.trim().is_empty() => {
            let path = PathBuf::from(raw.trim());
            if !path.is_absolute() {
                return Err(FleetCodexBindingError::Refused(
                    "The fleet Codex process has an invalid CODEX_HOME.".into(),
                ));
            }
            path
        }
        _ => config.codex.home.clone(),
    };
    let sqlite_home = match table.environment_var(*pid, "CODEX_SQLITE_HOME") {
        Some(raw) if !raw.trim().is_empty() => {
            let path = PathBuf::from(raw.trim());
            if !path.is_absolute()
                || fleet_worker_name(table, *pid).as_deref() != Some(&worker.name)
            {
                return Err(FleetCodexBindingError::Refused(
                    "The fleet Codex process has an invalid CODEX_SQLITE_HOME.".into(),
                ));
            }
            path
        }
        _ => {
            return Err(FleetCodexBindingError::Unavailable(
                "The fleet Codex process has no isolated SQLite home yet.".into(),
            ))
        }
    };
    Ok(FleetCodexBinding {
        worker_name: worker.name.clone(),
        pid: *pid,
        start: process.start,
        config: CodexConfig {
            ipc_socket: home.join("ipc/ipc.sock"),
            home,
            sqlite_home,
            executable: Some(executable.clone()),
        },
    })
}

impl LocalInjector {
    pub fn new(
        config: LocalConfig,
        table: Arc<dyn ProcessTable>,
        codex: CodexRouter,
        serving: ServingPath,
    ) -> LocalInjector {
        LocalInjector {
            config,
            table,
            codex,
            grok_inspect: Arc::new(|binding, authority| {
                crate::relay::existing_session::grok::inspect_session(
                    binding,
                    authority,
                    EXISTING_GROK_INSPECT_TIMEOUT,
                )
            }),
            fleet_codex: Mutex::default(),
            serving,
            claude: claude::SystemRunner::default(),
            managed: None,
            opencode: None,
            managed_cancellations: Mutex::default(),
        }
    }

    /// `new` with the Grok readback supplied, so tests need no Grok CLI.
    #[cfg(test)]
    fn with_grok_inspect(mut self, inspect: GrokInspect) -> LocalInjector {
        self.grok_inspect = inspect;
        self
    }

    /// Whether Grok still lists `session_id` as deliverable in `directory`:
    /// its TUI registry, or a Paseo `grok agent stdio` of this user that is
    /// attached to a leader that is running.
    fn grok_session_open(&self, session_id: &str, directory: Option<&Path>) -> bool {
        crate::relay::grok::open_sessions(&self.config.grok, &*self.table, self.config.uid)
            .iter()
            .any(|session| {
                session.session_id == session_id
                    && directory.is_none_or(|wanted| {
                        session.cwd.as_deref().is_some_and(|cwd| {
                            let recorded = Path::new(cwd);
                            recorded == wanted
                                || std::fs::canonicalize(recorded).ok()
                                    == std::fs::canonicalize(wanted).ok()
                        })
                    })
            })
    }

    /// Rebinds an already-open Grok session whose leader Grok replaced (as it
    /// does on update) to the leader now running, under the stored
    /// workspace, owner and uid. `Ok(None)` when there is nothing to rebind.
    fn rebind_open_grok(
        &self,
        target: &Target,
    ) -> Result<Option<crate::relay::existing_session::Binding>, String> {
        let Some(paths) = &self.config.existing_grok else {
            return Ok(None);
        };
        let claims = ManagedGrokClaims::read(self.managed.as_deref())
            .map_err(|_| "Managed session registry is unavailable.".to_string())?;
        let registry = enablement::Registry::open(&paths.bindings)
            .map_err(|_| "The registered Grok binding store is unavailable.".to_string())?;
        let inspect = self.grok_inspect.clone();
        let preferred =
            crate::relay::grok::open_sessions(&self.config.grok, &*self.table, self.config.uid)
                .into_iter()
                .find(|session| session.session_id == target.id)
                .and_then(|session| session_leader_socket_of(&*self.table, session.pid));
        enablement::rebind_replaced_leader(
            &registry,
            self.table.clone(),
            &target.id,
            &|stored| self.grok_session_open(&stored.session_id, Some(&stored.cwd)),
            &claims.leaders,
            &move |binding, authority| inspect(binding, authority),
            preferred.as_deref(),
        )
    }

    /// The directory the session's stored binding was made in, proven or not.
    fn stored_grok_directory(&self, target: &Target) -> Option<PathBuf> {
        let paths = self.config.existing_grok.as_ref()?;
        let registry = enablement::Registry::open(&paths.bindings).ok()?;
        registry.stored(&target.id).ok().flatten().map(|b| b.cwd)
    }

    /// Whether `pinned` names `binding` or a binding it replaced after its
    /// leader was proven gone. `Err` when the registry cannot be read.
    fn existing_pin_accepts(
        &self,
        binding: &crate::relay::existing_session::Binding,
        pinned: &str,
    ) -> Result<bool, ()> {
        let paths = self.config.existing_grok.as_ref().ok_or(())?;
        let registry = enablement::Registry::open(&paths.bindings).map_err(|_| ())?;
        registry.pin_accepts(binding, pinned).map_err(|_| ())
    }

    /// Resolves a broker-owned Codex target to the exact provider process
    /// and that process's isolated SQLite home. Broker I/O is attempted only
    /// after trusted local fleet SQLite-home evidence or a cached binding.
    /// An exact writer lock binds immediately; a still-starting provider stays
    /// unavailable instead of falling through to the desktop Codex queue.
    fn fleet_codex_binding(&self, target: &Target) -> FleetCodexResolution {
        let exact_names = local_fleet_codex_names(&self.config, &*self.table, target);
        let catalog_names = local_fleet_codex_catalog_names(&self.config, &*self.table, target);
        let cached = self
            .fleet_codex
            .lock()
            .unwrap()
            .get(&target.key())
            .map(|cached| cached.binding.clone());
        if exact_names.is_empty() && catalog_names.is_empty() && cached.is_none() {
            return FleetCodexResolution::NotManaged;
        }
        let workers = match self.config.fleet.workers_blocking() {
            Ok(workers) => workers,
            Err(error) => return FleetCodexResolution::Unavailable(error.message),
        };
        let mut bound = Vec::new();
        let mut unavailable = None;
        let mut refused = None;
        for worker in workers
            .into_iter()
            .filter(|worker| worker.provider_key() == "codex")
        {
            let broker_target = worker.managed_target();
            let exact = exact_names.contains(&worker.name);
            let cached_worker = cached
                .as_ref()
                .is_some_and(|binding| binding.worker_name == worker.name);
            let catalog = catalog_names.contains(&worker.name);
            if broker_target.as_ref() != Some(target) && !exact && !catalog && !cached_worker {
                continue;
            }
            match verified_fleet_codex_binding(&self.config, &*self.table, &worker, target) {
                Ok(binding) => bound.push(binding),
                Err(FleetCodexBindingError::Unavailable(reason)) => unavailable = Some(reason),
                Err(FleetCodexBindingError::Refused(reason)) => refused = Some(reason),
            }
        }
        match bound.as_slice() {
            [binding] => FleetCodexResolution::Bound(binding.clone()),
            [] if unavailable.is_some() => FleetCodexResolution::Unavailable(unavailable.unwrap()),
            [] if refused.is_some() => FleetCodexResolution::Refused(refused.unwrap()),
            [] if cached.is_some() => {
                let binding = cached.unwrap();
                if catalog_names.contains(&binding.worker_name) {
                    FleetCodexResolution::Unavailable(
                        "The fleet Codex worker is restarting its provider process.".into(),
                    )
                } else {
                    match self.table.process(binding.pid) {
                        Some(process)
                            if process.start == binding.start && process.uid == self.config.uid =>
                        {
                            FleetCodexResolution::Unavailable(
                                "The fleet worker registration is temporarily unavailable.".into(),
                            )
                        }
                        Some(_) => FleetCodexResolution::Refused(
                            "The fleet Codex process was replaced.".into(),
                        ),
                        None if self.table.process_gone(binding.pid) => {
                            FleetCodexResolution::Refused("The fleet Codex process ended.".into())
                        }
                        None => FleetCodexResolution::Unavailable(
                            "The fleet Codex process could not be verified.".into(),
                        ),
                    }
                }
            }
            [] if !catalog_names.is_empty() => FleetCodexResolution::Unavailable(
                "The fleet broker has not published this local Codex worker yet.".into(),
            ),
            [] => FleetCodexResolution::NotManaged,
            _ => FleetCodexResolution::Refused(
                "More than one fleet worker claims this Codex thread.".into(),
            ),
        }
    }

    fn fleet_codex_router(&self, target: &Target) -> FleetCodexResolutionRouter {
        match self.fleet_codex_binding(target) {
            FleetCodexResolution::NotManaged => {
                let cached = self
                    .fleet_codex
                    .lock()
                    .unwrap()
                    .get(&target.key())
                    .map(|cached| cached.binding.clone());
                let Some(binding) = cached else {
                    return FleetCodexResolutionRouter::NotManaged;
                };
                match self.table.process(binding.pid) {
                    Some(process)
                        if process.start == binding.start && process.uid == self.config.uid =>
                    {
                        FleetCodexResolutionRouter::Unavailable(
                            "The fleet worker registration is temporarily unavailable.".into(),
                        )
                    }
                    Some(_) => FleetCodexResolutionRouter::Refused(
                        "The fleet Codex process was replaced.".into(),
                    ),
                    None if self.table.process_gone(binding.pid) => {
                        FleetCodexResolutionRouter::Refused("The fleet Codex process ended.".into())
                    }
                    None => FleetCodexResolutionRouter::Unavailable(
                        "The fleet Codex process could not be verified.".into(),
                    ),
                }
            }
            FleetCodexResolution::Unavailable(reason) => {
                FleetCodexResolutionRouter::Unavailable(reason)
            }
            FleetCodexResolution::Refused(reason) => FleetCodexResolutionRouter::Refused(reason),
            FleetCodexResolution::Bound(binding) => {
                let mut routes = self.fleet_codex.lock().unwrap();
                if let Some(cached) = routes.get(&target.key()) {
                    if cached.binding == binding {
                        return FleetCodexResolutionRouter::Bound(cached.router.clone());
                    }
                }
                let router = Arc::new(CodexRouter::new(Arc::new(SystemCodexRoutes::new(
                    binding.config.clone(),
                    self.table.clone(),
                    self.config.uid,
                ))));
                routes.insert(
                    target.key(),
                    FleetCodexRouter {
                        binding,
                        router: router.clone(),
                    },
                );
                FleetCodexResolutionRouter::Bound(router)
            }
        }
    }

    /// Spawned OpenCode agents use the managed OpenCode route whatever its
    /// flag says, so its injector is always ready.
    pub fn with_managed(mut self, managed: Arc<ManagedSessions>) -> Self {
        self.opencode = opencode_existing::OpenCodeInjector::system(
            self.table.clone(),
            &managed.journal("opencode"),
        )
        .ok();
        self.managed = Some(managed);
        self
    }

    /// Launches agent CLIs with the supplied `environment` hook.
    pub fn with_agent_environment(mut self, environment: Option<claude::AgentEnvironment>) -> Self {
        self.claude = claude::SystemRunner { environment };
        self
    }

    fn can_reply(&self, target: &Target) -> bool {
        match target.kind {
            SessionKind::Codex => codex::thread_is_live(
                &self.config.codex,
                &*self.table,
                self.config.uid,
                &target.id,
            ),
            SessionKind::ClaudeTerminal => {
                claude::terminal_session(&self.config.claude, &*self.table, &target.id)
                    .is_some_and(|session| session.can_reply())
            }
            SessionKind::ClaudeCloud => false,
            SessionKind::OpenCode => self.managed.as_ref().is_some_and(|managed| {
                crate::relay::opencode::managed::can_reply(
                    managed,
                    &self.config.opencode,
                    &*self.table,
                    target,
                )
            }),
            // A Grok tool process names its session through
            // `GROK_SESSION_ID`, so an open session can answer on the socket.
            // The managed route's sessions run under a probe-launched leader
            // with no such registry entry, so no reply command is offered.
            SessionKind::GrokOpen => {
                self.config.existing_grok.is_some()
                    && crate::relay::grok::open_sessions(
                        &self.config.grok,
                        &*self.table,
                        self.config.uid,
                    )
                    .iter()
                    .any(|session| session.session_id == target.id)
            }
            SessionKind::Grok => {
                grok_caller::bound(&self.config, &self.table, &target.id).is_some()
            }
            // A Relay-spawned Muse tool is identified by its exact Muse
            // ancestor and registry record. Other Muse sessions are not
            // exposed to the relay.
            SessionKind::MuseOpen => {
                self.config.muse_spawn
                    && crate::relay::muse::open_session(
                        &self.config.muse,
                        &*self.table,
                        self.config.uid,
                        &target.id,
                    )
                    .is_some()
            }
            // Agent Relay's plugin tags each of the session's shells, so a
            // session one live plugin process holds can answer on the socket.
            SessionKind::OpenCodeOpen => {
                self.config.opencode_open
                    && crate::relay::opencode::holder(
                        &self.config.opencode,
                        &*self.table,
                        self.config.uid,
                        &target.id,
                    )
                    .is_ok()
            }
            // A Devin session's tools run under the lock-holding `devin`
            // process, so a live holder means a reply command can be named.
            SessionKind::Devin => devin::held(
                &self.config.devin,
                &*self.table,
                self.config.uid,
                &target.id,
            )
            .is_some(),
            // OpenClaw's tools never run under this core's socket: its
            // answer is read back from the Gateway (`final_answer`).
            SessionKind::OpenClaw | SessionKind::Hermes | SessionKind::Pi => false,
        }
    }

    fn inject_managed(
        &self,
        target: &Target,
        delivery_id: &str,
        message_id: &str,
        text: &str,
    ) -> InjectOutcome {
        let Some(manager) = &self.managed else {
            return InjectOutcome::Refused(
                "No verified probe-managed route for this session.".into(),
            );
        };
        let Some(binding) = manager.binding(target) else {
            return InjectOutcome::Refused(
                "No verified probe-managed route for this session.".into(),
            );
        };
        self.deliver_managed(manager, target, binding, delivery_id, message_id, text)
    }

    /// One delivery to a Grok session through the single route that claims
    /// it. A session both routes claim is refused before either is asked.
    fn inject_grok(
        &self,
        target: &Target,
        delivery_id: &str,
        message_id: &str,
        text: &str,
        pinned: Option<&str>,
    ) -> InjectOutcome {
        match grok_route(&self.config, &self.table, self.managed.as_deref(), target) {
            GrokRoute::Managed(binding) => match &self.managed {
                Some(manager) => {
                    self.deliver_managed(manager, target, binding, delivery_id, message_id, text)
                }
                None => InjectOutcome::Refused(
                    "No verified probe-managed route for this session.".into(),
                ),
            },
            GrokRoute::Existing(binding) => {
                // An agent is pinned to the binding it registered against,
                // or to one that binding replaced after its leader was
                // proven gone under the same workspace, owner and uid.
                let accepted = match pinned {
                    Some(pinned) => self.existing_pin_accepts(&binding, pinned),
                    None => Ok(false),
                };
                match accepted {
                    Ok(true) => {
                        if let Some(reason) = crate::relay::grok::paseo_delivery_block(
                            &self.config.grok,
                            &*self.table,
                            self.config.uid,
                            &target.id,
                            &binding.socket_path,
                        ) {
                            return InjectOutcome::Refused(reason);
                        }
                        self.deliver_existing_grok(target, delivery_id, message_id, text, pinned)
                    }
                    Ok(false) => InjectOutcome::Refused(
                        "This agent's Grok binding changed; turn this agent off, then add the session again.".into(),
                    ),
                    Err(()) => {
                        InjectOutcome::Retry("A Grok binding store is unavailable.".into())
                    }
                }
            }
            GrokRoute::Ambiguous => InjectOutcome::Refused(
                "Both Grok routes claim this session; neither binding is used.".into(),
            ),
            GrokRoute::Unavailable => {
                InjectOutcome::Retry("A Grok binding store is unavailable.".into())
            }
            // With the already-open route off, main's managed refusal.
            GrokRoute::None
                if target.kind == SessionKind::Grok && self.config.existing_grok.is_none() =>
            {
                InjectOutcome::Refused("No verified probe-managed route for this session.".into())
            }
            // Grok replaces its own leader on update; a pinned session it
            // still runs is rebound to the new leader and delivered, or waits
            // while the new leader comes up.
            GrokRoute::None if target.kind == SessionKind::GrokOpen && pinned.is_some() => {
                // Waiting is right only while a rebind can still happen: Grok
                // lists the session in the directory the binding was made in.
                let still_open = || {
                    self.stored_grok_directory(target)
                        .is_some_and(|cwd| self.grok_session_open(&target.id, Some(&cwd)))
                };
                match self.rebind_open_grok(target) {
                    Ok(Some(_)) => {
                        self.deliver_existing_grok(target, delivery_id, message_id, text, pinned)
                    }
                    Ok(None) if still_open() => InjectOutcome::Waiting(
                        "Grok's leader was replaced; waiting to rebind this session.".into(),
                    ),
                    Ok(None) => {
                        InjectOutcome::Refused("No verified Grok route for this session.".into())
                    }
                    Err(message) if still_open() => InjectOutcome::Waiting(message),
                    Err(message) => InjectOutcome::Refused(message),
                }
            }
            GrokRoute::None => {
                InjectOutcome::Refused("No verified Grok route for this session.".into())
            }
        }
    }

    /// One Agent Relay message into an already-open Grok session through the
    /// proved ACP adapter. The binding is proved again from the registry, so
    /// a missing or stale one never reaches the transport.
    fn deliver_existing_grok(
        &self,
        target: &Target,
        delivery_id: &str,
        message_id: &str,
        text: &str,
        pinned: Option<&str>,
    ) -> InjectOutcome {
        use crate::relay::existing_session::{grok, Outcome};
        let Some(paths) = &self.config.existing_grok else {
            return InjectOutcome::Refused("No verified Grok route for this session.".into());
        };
        let Ok(registry) = enablement::Registry::open(&paths.bindings) else {
            return InjectOutcome::Retry(
                "The registered Grok binding store is unavailable.".into(),
            );
        };
        let authority = Arc::new(ExistingLeaderAuthority::new(self.table.clone()));
        let outcome = enablement::deliver(
            &registry,
            &paths.journal,
            authority.clone(),
            Arc::new(grok::SystemAcpTransport::new(authority)),
            &target.id,
            delivery_id,
            message_id,
            text,
            Duration::from_secs(30),
            pinned,
        );
        match outcome {
            Outcome::Delivered { .. } => InjectOutcome::Delivered,
            Outcome::Retry(_) => {
                InjectOutcome::Retry("The registered Grok endpoint is unavailable.".into())
            }
            Outcome::Waiting(_) => {
                InjectOutcome::Waiting("The registered Grok session is not ready.".into())
            }
            Outcome::InDoubt(_) => InjectOutcome::InDoubt(
                "Grok may have accepted this message; operator reconciliation is required.".into(),
            ),
            Outcome::Refused(_) => {
                InjectOutcome::Refused("The registered Grok binding was refused.".into())
            }
        }
    }

    fn deliver_managed(
        &self,
        manager: &ManagedSessions,
        target: &Target,
        binding: ManagedBinding,
        delivery_id: &str,
        message_id: &str,
        text: &str,
    ) -> InjectOutcome {
        match binding {
            ManagedBinding::OpenCode(binding) => {
                let Some(injector) = &self.opencode else {
                    return InjectOutcome::Refused(
                        "The managed OpenCode route is unavailable.".into(),
                    );
                };
                let key = format!("{}\0{message_id}", target.key());
                let cancelled = Arc::new(AtomicBool::new(false));
                self.managed_cancellations
                    .lock()
                    .unwrap()
                    .insert(key.clone(), cancelled.clone());
                let request = opencode_existing::Request {
                    binding: &binding,
                    relay_workspace_id: &binding.relay_workspace_id,
                    delivery_id,
                    message_id,
                    text,
                    timeout: Duration::from_secs(120),
                    cancelled: &cancelled,
                };
                let outcome = injector.inject(&request);
                self.managed_cancellations.lock().unwrap().remove(&key);
                match outcome {
                    opencode_existing::Outcome::Completed { .. } => InjectOutcome::Delivered,
                    opencode_existing::Outcome::Waiting(_) => {
                        InjectOutcome::Waiting("The managed OpenCode session is not ready.".into())
                    }
                    opencode_existing::Outcome::InDoubt(_) => InjectOutcome::InDoubt(
                        "OpenCode may have accepted this message; operator reconciliation is required."
                            .into(),
                    ),
                    opencode_existing::Outcome::Refused(_) => {
                        InjectOutcome::Refused("The managed OpenCode binding was refused.".into())
                    }
                }
            }
            ManagedBinding::Grok(binding) => {
                use crate::relay::existing_session::{self, grok, Provider};
                let authority = Arc::new(grok::SystemAuthority::new(self.table.clone()));
                let adapter = Arc::new(grok::GrokAdapter::new(
                    binding.workspace_id.clone(),
                    binding.owner_id.clone(),
                    binding.owner_uid,
                    authority.clone(),
                    Arc::new(grok::SystemAcpTransport::new(authority)),
                ));
                let journal = match existing_session::Journal::new(manager.journal("grok")) {
                    Ok(journal) => journal,
                    // Nothing has been sent yet.
                    Err(_) => {
                        return InjectOutcome::Retry(
                            "The managed Grok delivery journal is unavailable.".into(),
                        )
                    }
                };
                let Some(coordinator) = existing_session::Coordinator::new(
                    existing_session::Gate::enabled([Provider::Grok]),
                    journal,
                    vec![adapter],
                ) else {
                    return InjectOutcome::Refused("The managed Grok route is unavailable.".into());
                };
                let request = existing_session::Request {
                    binding: &binding,
                    delivery_id,
                    message_id,
                    text,
                    timeout: Duration::from_secs(30),
                };
                match coordinator.inject(&request) {
                    existing_session::Outcome::Delivered { .. } => InjectOutcome::Delivered,
                    existing_session::Outcome::Retry(_) => {
                        InjectOutcome::Retry("The managed Grok endpoint is unavailable.".into())
                    }
                    existing_session::Outcome::Waiting(_) => {
                        InjectOutcome::Waiting("The managed Grok session is not ready.".into())
                    }
                    existing_session::Outcome::InDoubt(_) => InjectOutcome::InDoubt(
                        "Grok may have accepted this message; operator reconciliation is required."
                            .into(),
                    ),
                    existing_session::Outcome::Refused(_) => {
                        InjectOutcome::Refused("The managed Grok binding was refused.".into())
                    }
                }
            }
        }
    }
}

enum FleetCodexResolutionRouter {
    NotManaged,
    Bound(Arc<CodexRouter>),
    Unavailable(String),
    Refused(String),
}

impl LocalInjector {
    /// The binding for an open OpenCode agent's session: the one live
    /// process whose plugin holds it, proven and read back over its socket.
    fn opencode_open_binding(
        &self,
        registration: &crate::relay::store::Registration,
    ) -> Result<opencode_existing::Binding, InjectOutcome> {
        if !self.config.opencode_open {
            return Err(InjectOutcome::Refused(
                "The OpenCode plugin route is turned off.".into(),
            ));
        }
        let (process, session) = crate::relay::opencode::holder(
            &self.config.opencode,
            &*self.table,
            self.config.uid,
            &registration.target.id,
        )
        .map_err(|miss| match miss {
            crate::relay::opencode::Miss::NotOpen => InjectOutcome::Waiting(
                "This OpenCode session is not open with the Agent Relay plugin right now; it will be delivered when it is."
                    .into(),
            ),
            crate::relay::opencode::Miss::Ambiguous => InjectOutcome::Waiting(
                "This OpenCode session is open in more than one OpenCode window; close all but one."
                    .into(),
            ),
        })?;
        crate::relay::opencode::binding(
            &*self.table,
            &opencode_existing::SystemHttp,
            &process,
            &session,
            &registration.agent_id,
            &registration.name,
        )
        .map_err(|_| InjectOutcome::Retry("This OpenCode session could not be verified.".into()))
    }

    /// One delivery into an open OpenCode session through its plugin
    /// socket, with the managed route's journal, deterministic message id
    /// and correlated-assistant receipt.
    fn inject_opencode_open(
        &self,
        registration: &crate::relay::store::Registration,
        delivery_id: &str,
        message_id: &str,
        text: &str,
    ) -> InjectOutcome {
        let Some(journal) = &self.config.opencode_open_journal else {
            return InjectOutcome::Refused("The OpenCode plugin route is turned off.".into());
        };
        let binding = match self.opencode_open_binding(registration) {
            Ok(binding) => binding,
            Err(outcome) => return outcome,
        };
        let injector =
            match opencode_existing::OpenCodeInjector::system(self.table.clone(), journal) {
                Ok(injector) => injector,
                // Nothing has been sent yet.
                Err(_) => {
                    return InjectOutcome::Retry(
                        "The OpenCode delivery journal is unavailable.".into(),
                    )
                }
            };
        let key = format!("{}\0{message_id}", registration.target.key());
        let cancelled = Arc::new(AtomicBool::new(false));
        self.managed_cancellations
            .lock()
            .unwrap()
            .insert(key.clone(), cancelled.clone());
        let request = opencode_existing::Request {
            binding: &binding,
            relay_workspace_id: &binding.relay_workspace_id,
            delivery_id,
            message_id,
            text,
            timeout: Duration::from_secs(120),
            cancelled: &cancelled,
        };
        let outcome = injector.inject(&request);
        self.managed_cancellations.lock().unwrap().remove(&key);
        match outcome {
            opencode_existing::Outcome::Completed { .. } => InjectOutcome::Delivered,
            opencode_existing::Outcome::Waiting(_) => {
                InjectOutcome::Waiting("The OpenCode session is busy or not ready.".into())
            }
            opencode_existing::Outcome::InDoubt(_) => InjectOutcome::InDoubt(
                "OpenCode may have accepted this message; operator reconciliation is required."
                    .into(),
            ),
            opencode_existing::Outcome::Refused(_) => {
                InjectOutcome::Refused("The OpenCode session refused this delivery.".into())
            }
        }
    }

    /// One relayed message into a Muse session started and still owned by
    /// Relay. The saved spawn process and live registry entry must agree
    /// before the owned courier route is allowed to send.
    fn inject_muse_spawn(
        &self,
        registration: &crate::relay::store::Registration,
        delivery_id: &str,
        message_id: &str,
        text: &str,
    ) -> InjectOutcome {
        let target_id = &registration.target.id;
        let Some(journal) = &self.config.muse_spawn_journal else {
            return InjectOutcome::Refused("Muse spawning is unavailable.".into());
        };
        let Some(expected) = registration
            .spawn
            .as_ref()
            .filter(|spawn| spawn.harness == "muse" && spawn.taken_over_at.is_none())
            .and_then(|spawn| spawn.process)
        else {
            return InjectOutcome::Refused(
                "Only a Muse session started and owned by Agent Relay can receive messages."
                    .into(),
            );
        };
        let Some(open) = crate::relay::muse::open_session(
            &self.config.muse,
            &*self.table,
            self.config.uid,
            target_id,
        ) else {
            return InjectOutcome::Waiting(
                "This Relay-owned Muse session is not running right now.".into(),
            );
        };
        if open.session.pid != expected.pid
            || !expected.is(self.table.process(expected.pid))
        {
            return InjectOutcome::Refused(
                "The Relay-owned Muse process no longer matches this agent.".into(),
            );
        }
        let Some(workspace_root) = crate::relay::muse::session_cwd(&*self.table, open.session.pid)
        else {
            return InjectOutcome::Retry("This Muse session's workspace is unavailable.".into());
        };
        let target = courier::Target {
            session_id: target_id.clone(),
            workspace_root,
            // Stable, non-empty identity for the delivery journal; the route's
            // real authority is the live-registry and kernel-workspace proof.
            workspace_id: registration.agent_id.clone(),
            owner_id: registration.name.clone(),
            owner_uid: self.config.uid,
        };
        // Muse answers a relayed message only as a request its person passed
        // on; see `muse::framed`.
        let text = crate::relay::muse::framed(text);
        let courier = Arc::new(courier::SystemCourier::new(open.store.clone(), None));
        let receipts = Arc::new(courier::SystemReceipts::new(&open.store));
        match courier::deliver(
            journal,
            courier,
            receipts,
            &target,
            delivery_id,
            message_id,
            &text,
            Duration::from_secs(30),
        ) {
            crate::relay::existing_session::Outcome::Delivered { .. } => InjectOutcome::Delivered,
            crate::relay::existing_session::Outcome::Retry(_) => {
                InjectOutcome::Retry("The Muse courier is unavailable.".into())
            }
            crate::relay::existing_session::Outcome::Waiting(_) => {
                InjectOutcome::Waiting("The Muse courier is not ready.".into())
            }
            crate::relay::existing_session::Outcome::InDoubt(_) => InjectOutcome::InDoubt(
                "Muse may have received this message; operator reconciliation is required.".into(),
            ),
            crate::relay::existing_session::Outcome::Refused(_) => {
                InjectOutcome::Refused("The Muse courier binding was refused.".into())
            }
        }
    }
}

impl Injector for LocalInjector {
    fn inject(&self, target: &Target, message_id: &str, text: &str) -> InjectOutcome {
        match target.kind {
            SessionKind::Codex | SessionKind::ClaudeTerminal => {
                self.inject_terminal(target, message_id, text)
            }
            SessionKind::ClaudeCloud => {
                claude::send_to_cloud(&self.config.claude, &self.claude, &target.id, text)
            }
            SessionKind::Grok => self.inject_grok(target, message_id, message_id, text, None),
            // Only its registered agent, pinned to one binding, may send.
            SessionKind::GrokOpen => InjectOutcome::Refused(
                "An already-open Grok session takes messages only for its registered agent.".into(),
            ),
            SessionKind::OpenCode => self.inject_managed(target, message_id, message_id, text),
            // Only its registered agent, pinned to a binding, may send.
            SessionKind::MuseOpen => InjectOutcome::Refused(
                "A Relay-owned Muse session takes messages only for its registered agent.".into(),
            ),
            SessionKind::OpenCodeOpen => InjectOutcome::Refused(
                "An open OpenCode session takes messages only for its registered agent.".into(),
            ),
            // Devin's inbox is the session's own queue: writing the file is
            // the route, and no binding can point it at another session.
            SessionKind::Devin => match devin::send(
                &self.config.devin,
                &*self.table,
                self.config.uid,
                &target.id,
                message_id,
                text,
            ) {
                // Nothing local holds the session: a cloud-format id may
                // still be reachable through devin-cloud's send route.
                // `None` keeps the local answer — a stopped local session
                // is waiting, not lost.
                InjectOutcome::Waiting(reason) => crate::relay::devin_cloud::send_cloud(
                    &self.config.devin,
                    self.config.devin_probe_root.as_deref(),
                    &target.id,
                    text,
                )
                .unwrap_or(InjectOutcome::Waiting(reason)),
                outcome => outcome,
            },
            // Each sender has a session of its own (`inject_routed`).
            SessionKind::OpenClaw | SessionKind::Hermes | SessionKind::Pi => {
                InjectOutcome::Refused(
                    "This agent takes messages only through its registered agent.".into(),
                )
            }
        }
    }

    fn inject_routed(
        &self,
        registration: &crate::relay::store::Registration,
        route: &crate::relay::inject::DeliveryRoute<'_>,
        text: &str,
    ) -> InjectOutcome {
        self.inject_gateway(registration, route, text)
            .unwrap_or_else(|| {
                self.inject_registered(registration, route.delivery_id, route.message_id, text)
            })
    }

    fn inject_connect(&self, target: &Target, message_id: &str, text: &str) -> InjectOutcome {
        match target.kind {
            SessionKind::Codex => match self.fleet_codex_router(target) {
                FleetCodexResolutionRouter::NotManaged => {
                    self.codex.inject(&target.id, message_id, text)
                }
                FleetCodexResolutionRouter::Bound(router) => {
                    router.inject(&target.id, message_id, text)
                }
                FleetCodexResolutionRouter::Unavailable(reason) => InjectOutcome::Retry(reason),
                FleetCodexResolutionRouter::Refused(reason) => InjectOutcome::Refused(reason),
            },
            _ => self.inject(target, message_id, text),
        }
    }

    fn observe_connect(&self, target: &Target, message_id: &str, text: &str) -> InjectOutcome {
        match target.kind {
            SessionKind::Codex => match self.fleet_codex_router(target) {
                FleetCodexResolutionRouter::Bound(router) => router.observe(&target.id, message_id),
                FleetCodexResolutionRouter::NotManaged => {
                    // This may be an ordinary Codex handoff, or a fleet
                    // handoff after restart with no live process from which
                    // to recover the isolated SQLite home. Either way only
                    // observe the shared rollout/default queue; never resend.
                    self.codex.observe(&target.id, message_id)
                }
                FleetCodexResolutionRouter::Unavailable(reason) => {
                    if let Some(cached) = self.fleet_codex.lock().unwrap().get(&target.key()) {
                        cached.router.observe(&target.id, message_id)
                    } else {
                        InjectOutcome::Accepted(reason)
                    }
                }
                FleetCodexResolutionRouter::Refused(reason) => {
                    let cached = self
                        .fleet_codex
                        .lock()
                        .unwrap()
                        .get(&target.key())
                        .map(|cached| cached.router.clone());
                    if cached.as_ref().is_some_and(|router| {
                        router.observe(&target.id, message_id) == InjectOutcome::Delivered
                    }) {
                        InjectOutcome::Delivered
                    } else {
                        InjectOutcome::InDoubt(format!(
                            "Codex accepted this handoff before its fleet binding was lost — {reason}"
                        ))
                    }
                }
            },
            _ => self.inject_connect(target, message_id, text),
        }
    }

    fn inject_registered(
        &self,
        registration: &crate::relay::store::Registration,
        delivery_id: &str,
        message_id: &str,
        text: &str,
    ) -> InjectOutcome {
        self.deliver_registered(registration, delivery_id, message_id, text)
    }
    fn cancel(&self, target: &Target, message_id: &str) {
        if target.kind == SessionKind::Codex {
            self.codex.cancel(&target.id, message_id);
        } else if matches!(
            target.kind,
            SessionKind::OpenCode | SessionKind::OpenCodeOpen
        ) {
            let key = format!("{}\0{message_id}", target.key());
            if let Some(cancelled) = self.managed_cancellations.lock().unwrap().get(&key) {
                cancelled.store(true, std::sync::atomic::Ordering::SeqCst);
            }
        }
    }

    fn cancel_connect(&self, target: &Target, message_id: &str) {
        if target.kind == SessionKind::Codex {
            match self.fleet_codex_router(target) {
                FleetCodexResolutionRouter::Bound(router) => router.cancel(&target.id, message_id),
                FleetCodexResolutionRouter::NotManaged => {
                    self.codex.cancel(&target.id, message_id);
                }
                FleetCodexResolutionRouter::Unavailable(_)
                | FleetCodexResolutionRouter::Refused(_) => {
                    if let Some(cached) = self.fleet_codex.lock().unwrap().get(&target.key()) {
                        cached.router.cancel(&target.id, message_id);
                    }
                }
            }
        } else {
            self.cancel(target, message_id);
        }
    }

    fn relay_socket(&self, target: &Target) -> Option<(PathBuf, bool)> {
        let socket = self.serving.get()?;
        (self.can_reply(target)).then(|| (socket, self.needs_probe_client(target)))
    }

    fn codex_recorded(&self, target: &Target, message_ref: &str) -> bool {
        target.kind == SessionKind::Codex
            && codex::rollout::recorded(&self.config.codex, &target.id, message_ref)
    }

    fn relay_started_turn(&self, target: &Target, turn: &str) -> bool {
        target.kind == SessionKind::Codex
            && codex::rollout::started_by_relay(&self.config.codex, &target.id, turn)
    }

    fn host_note(&self, target: &Target) -> Option<String> {
        self.claude_host_note(target)
    }

    fn inbox_transcript_tail(&self, target: &Target, max: u64) -> Option<(Vec<u8>, bool)> {
        self.claude_inbox_tail(target, max)
    }

    fn final_answer(&self, target: &Target, message_ref: &str) -> Option<String> {
        match target.kind {
            SessionKind::OpenClaw | SessionKind::Hermes => self.gateway_answer(target, message_ref),
            SessionKind::Codex if is_uuid(&target.id) => {
                codex::final_answer(&self.config.codex, &target.id, message_ref)
            }
            SessionKind::ClaudeTerminal => {
                claude::final_answer(&self.config.claude, &*self.table, &target.id, message_ref)
            }
            SessionKind::MuseOpen => None,
            _ => None,
        }
    }

    fn final_answer_registered(
        &self,
        registration: &crate::relay::store::Registration,
        message_ref: &str,
    ) -> Option<String> {
        if registration.target.kind == SessionKind::Pi {
            return crate::relay::pi::final_answer(
                &self.config.pi,
                self.config.uid,
                registration,
                message_ref,
            );
        }
        if registration.target.kind == SessionKind::OpenCodeOpen {
            let pinned = registration.route_binding.as_deref()?;
            if !crate::relay::opencode::is_route_reference(pinned, &registration.target.id) {
                return None;
            }
            let binding = self.opencode_open_binding(registration).ok()?;
            let journal = self.config.opencode_open_journal.as_ref()?;
            return opencode_existing::OpenCodeInjector::system(self.table.clone(), journal)
                .ok()?
                .final_answer(&binding, message_ref);
        }
        if registration.target.kind == SessionKind::MuseOpen {
            let owned = registration.spawn.as_ref().is_some_and(|spawn| {
                spawn.harness == "muse"
                    && spawn.taken_over_at.is_none()
                    && spawn.process.is_some()
            });
            return owned.then(|| {
                crate::relay::muse::final_answer(
                    &self.config.muse,
                    &registration.target.id,
                    message_ref,
                )
            })?;
        }
        if registration.target.kind != SessionKind::OpenCode {
            return self.final_answer(&registration.target, message_ref);
        }
        let ManagedBinding::OpenCode(binding) =
            self.managed.as_ref()?.binding(&registration.target)?
        else {
            return None;
        };
        self.opencode.as_ref()?.final_answer(&binding, message_ref)
    }
}

impl DirectDelivery for ClaudeSettings {
    fn delivers_directly(&self) -> bool {
        ClaudeSettings::delivers_directly(self)
    }

    fn managed_value(&self) -> Option<String> {
        ClaudeSettings::managed_value(self)
    }

    fn user_choice(&self) -> Option<String> {
        ClaudeSettings::user_choice(self)
    }

    fn set_direct_delivery(&self, enabled: bool) -> Result<(), String> {
        ClaudeSettings::set_direct_delivery(self, enabled).map_err(|error| match error {
            DirectDeliveryError::ManagedPolicy => {
                "Managed Claude settings do not allow direct delivery.".to_string()
            }
            other => other.to_string(),
        })
    }
}

mod gateways;
mod grok_caller;
mod nearest;
mod opencode_reply;
mod plugins;
pub use plugins::{plugins, plugins_with};

/// The Codex side of the desktop mailbox's delivery passes: the same routes
/// injection uses, over this computer's Codex.
pub struct CodexMailboxEffects {
    config: CodexConfig,
    table: Arc<dyn ProcessTable>,
    uid: u32,
    routes: SystemCodexRoutes,
}

impl CodexMailboxEffects {
    pub fn new(config: CodexConfig, table: Arc<dyn ProcessTable>, uid: u32) -> CodexMailboxEffects {
        CodexMailboxEffects {
            routes: SystemCodexRoutes::new(config.clone(), table.clone(), uid),
            config,
            table,
            uid,
        }
    }
}

/// One Codex app connection, as the delivery pass drives it.
struct Window(codex::ipc::Session);

fn bridge_error(error: codex::ipc::IpcError) -> effects::CodexBridgeError {
    use codex::ipc::IpcError;
    use effects::CodexBridgeError;
    match error {
        IpcError::NotRunning => CodexBridgeError::CodexNotRunning,
        IpcError::TimedOut => CodexBridgeError::TimedOut,
        IpcError::Rejected(reason) => CodexBridgeError::Rejected(reason),
        other => CodexBridgeError::Io(other.to_string()),
    }
}

impl effects::CodexWindowDelivering for Window {
    fn owners(
        &mut self,
        thread_ids: &[String],
    ) -> Result<HashMap<String, String>, effects::CodexBridgeError> {
        self.0
            .owners(thread_ids)
            .map(|owners| owners.into_iter().collect())
            .map_err(bridge_error)
    }

    fn start_turn(
        &mut self,
        thread_id: &str,
        text: &str,
        message_id: &str,
        owner: &str,
    ) -> Result<Option<String>, effects::CodexBridgeError> {
        self.0
            .start_relay_turn(thread_id, text, message_id, owner)
            .map_err(bridge_error)
    }
}

impl effects::CodexDeliveryEffects for CodexMailboxEffects {
    fn queue_available(&self) -> bool {
        self.config.executable.is_some()
    }

    fn queue_send(&self, thread_id: &str, text: &str) -> Result<(), effects::CodexQueueError> {
        use effects::CodexQueueError;
        self.routes
            .queue_send(thread_id, text)
            .map_err(|error| match error {
                QueueError::NotInstalled => CodexQueueError::CodexNotInstalled,
                QueueError::Failed(reason) => CodexQueueError::Failed(reason),
                QueueError::TimedOut => CodexQueueError::TimedOut,
            })
    }

    fn queue_waiting(&self, thread_id: &str, reference: &str) -> Option<bool> {
        self.routes.queue_waiting(thread_id, reference)
    }

    fn queue_cleanup(&self, thread_id: &str, reference: &str) {
        self.routes.cleanup(thread_id, reference);
    }

    fn app_server_loaded(&self) -> HashSet<String> {
        codex::app_server_loaded(&self.config, &*self.table, self.uid)
            .into_iter()
            .collect()
    }

    fn app_server_send(
        &self,
        thread_id: &str,
        text: &str,
        message_id: &str,
    ) -> Result<bool, effects::CodexAppServerError> {
        use effects::CodexAppServerError;
        self.routes
            .app_server(thread_id, text, message_id)
            .map_err(|error| match error {
                TurnError::Refused(reason) => CodexAppServerError::Refused(reason),
                TurnError::InDoubt(reason) => CodexAppServerError::InDoubt(reason),
            })
    }

    fn terminal_live(&self, thread_id: &str) -> bool {
        self.routes.terminal_live(thread_id)
    }

    fn rollout(&self, thread_id: &str) -> Option<RolloutSummary> {
        rollout::rollout_path(&self.config, thread_id).and_then(|path| RolloutSummary::read(&path))
    }

    fn idle(&self, thread_id: &str) -> bool {
        self.routes.idle(thread_id)
    }

    fn rollout_readable(&self, thread_id: &str) -> bool {
        self.rollout(thread_id).is_some()
    }

    fn with_window_session(
        &self,
        body: &mut dyn FnMut(
            &mut dyn effects::CodexWindowDelivering,
        ) -> Result<(), effects::WindowSessionError>,
    ) -> Result<(), effects::WindowSessionError> {
        let session =
            codex::ipc::Session::connect(&self.config.ipc_socket).map_err(bridge_error)?;
        body(&mut Window(session))
    }
}

/// The Claude side of the desktop mailbox: `claude --print --cloud`.
pub struct ClaudeMailboxEffects {
    config: ClaudeConfig,
}

impl ClaudeMailboxEffects {
    pub fn new(config: ClaudeConfig) -> ClaudeMailboxEffects {
        ClaudeMailboxEffects { config }
    }
}

impl effects::ClaudeDeliveryEffects for ClaudeMailboxEffects {
    fn is_available(&self) -> bool {
        self.config.executable.is_some()
    }

    fn send(&self, session_id: &str, text: &str) -> Result<(), effects::ClaudeBridgeError> {
        use effects::ClaudeBridgeError;
        // An untagged id would be taken by the CLI as a new session's
        // description: never run it.
        if !crate::relay::store::is_claude_session_id(session_id) {
            return Err(ClaudeBridgeError::Refused("invalid session id".into()));
        }
        let runner = claude::SystemRunner::default();
        let Some(executable) = &self.config.executable else {
            return Err(ClaudeBridgeError::ClaudeNotInstalled);
        };
        let arguments = claude::cloud_arguments(
            session_id,
            claude::supports_json_result(&runner, executable),
        );
        match claude::CommandRunner::run(
            &runner,
            executable,
            &arguments,
            text.as_bytes(),
            claude::SEND_TIMEOUT,
        ) {
            claude::RunOutcome::NotStarted(_) => Err(ClaudeBridgeError::ClaudeNotInstalled),
            claude::RunOutcome::TimedOut => Err(ClaudeBridgeError::TimedOut),
            claude::RunOutcome::Exited {
                code,
                stdout,
                stderr,
            } => match claude::send_outcome(
                code,
                &String::from_utf8_lossy(&stdout),
                &String::from_utf8_lossy(&stderr),
            ) {
                claude::SendOutcome::Sent { .. } => Ok(()),
                claude::SendOutcome::Refused(reason) => Err(ClaudeBridgeError::Refused(reason)),
                claude::SendOutcome::Failed(reason) => Err(ClaudeBridgeError::Failed(reason)),
            },
        }
    }
}

// The fixtures are Unix sockets, shell scripts, file modes and `/tmp`, for
// the Grok, Muse and OpenCode routes Windows does not have.
#[cfg(test)]
#[cfg(unix)]
mod tests {
    mod spawned_delivery;
    use super::*;
    use crate::relay::codex::router::CodexRoutes;
    use crate::relay::opencode_existing::{Clock, HttpResponse, HttpTransport};
    use crate::relay::process::{FakeProcess, FakeProcesses, StartClock};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::time::Instant;

    const UID: u32 = 501;
    const CLAUDE: &str = "727cce8d-8074-4ea3-94a0-dea144bf8747";
    const THREAD: &str = "019a0000-0000-7000-8000-000000000001";
    const OTHER_THREAD: &str = "019a0000-0000-7000-8000-000000000002";

    #[derive(Default)]
    struct UnusedCodexRoutes;

    impl CodexRoutes for UnusedCodexRoutes {
        fn recorded(&self, _: &str, _: &str) -> bool {
            false
        }
        fn queue_waiting(&self, _: &str, _: &str) -> Option<bool> {
            None
        }
        fn relay_waiting(&self, _: &str) -> Option<bool> {
            None
        }
        fn idle(&self, _: &str) -> bool {
            true
        }
        fn app_server(&self, _: &str, _: &str, _: &str) -> Result<bool, TurnError> {
            Ok(false)
        }
        fn window(&self, _: &str, _: &str, _: &str) -> Result<bool, TurnError> {
            Ok(false)
        }
        fn terminal_live(&self, _: &str) -> bool {
            false
        }
        fn queue_send(&self, _: &str, _: &str) -> Result<(), QueueError> {
            Ok(())
        }
        fn cleanup(&self, _: &str, _: &str) {}
    }

    #[derive(Default)]
    struct ObservingCodexRoutes {
        recorded: AtomicBool,
    }

    impl CodexRoutes for ObservingCodexRoutes {
        fn recorded(&self, _: &str, _: &str) -> bool {
            self.recorded.load(Ordering::SeqCst)
        }
        fn queue_waiting(&self, _: &str, _: &str) -> Option<bool> {
            Some(false)
        }
        fn relay_waiting(&self, _: &str) -> Option<bool> {
            Some(false)
        }
        fn idle(&self, _: &str) -> bool {
            true
        }
        fn app_server(&self, _: &str, _: &str, _: &str) -> Result<bool, TurnError> {
            Ok(false)
        }
        fn window(&self, _: &str, _: &str, _: &str) -> Result<bool, TurnError> {
            Ok(false)
        }
        fn terminal_live(&self, _: &str) -> bool {
            false
        }
        fn queue_send(&self, _: &str, _: &str) -> Result<(), QueueError> {
            Ok(())
        }
        fn cleanup(&self, _: &str, _: &str) {}
    }

    struct FixedManagedRuntime(ManagedBinding);

    impl crate::relay::managed_sessions::ManagedRuntime for FixedManagedRuntime {
        fn launch(&self, _: &ManagedLaunch, _: &Path) -> Result<ManagedBinding, ()> {
            Ok(self.0.clone())
        }

        fn verify(&self, binding: &ManagedBinding) -> bool {
            binding == &self.0
        }
    }

    #[derive(Default)]
    struct CompletingOpenCode {
        prompts: Mutex<Vec<(String, String)>>,
        calls: AtomicUsize,
    }

    impl HttpTransport for CompletingOpenCode {
        fn request(
            &self,
            method: &str,
            url: &str,
            _: &str,
            _: &Path,
            body: Option<&[u8]>,
            _: Duration,
        ) -> Option<HttpResponse> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let response = if method == "GET" && url.ends_with("/session/ses_exact") {
                serde_json::json!({
                    "id": "ses_exact",
                    "projectID": "prj_exact",
                    "workspaceID": "wrk_exact",
                    "directory": "/work/project",
                    "time": {"created": 1, "updated": 2}
                })
            } else if method == "GET" && url.ends_with("/session/status") {
                serde_json::json!({})
            } else if method == "POST" && url.ends_with("/session/ses_exact/prompt_async") {
                let body: serde_json::Value = serde_json::from_slice(body?).ok()?;
                let id = body["messageID"].as_str()?.to_string();
                let text = body["parts"][0]["text"].as_str()?.to_string();
                self.prompts.lock().unwrap().push((id, text));
                return Some(HttpResponse {
                    status: 204,
                    body: Vec::new(),
                });
            } else if method == "GET" && url.contains("/message/msg_relay_") {
                let (id, text) = self.prompts.lock().unwrap().last()?.clone();
                serde_json::json!({
                    "info": {"id": id, "sessionID": "ses_exact", "role": "user"},
                    "parts": [{"type": "text", "text": text}]
                })
            } else if method == "GET" && url.ends_with("/session/ses_exact/message") {
                let prompts = self.prompts.lock().unwrap();
                let (id, text) = prompts.last()?;
                let assistant = format!("msg_assistant_{}", prompts.len());
                serde_json::json!([
                    {
                        "info": {"id": id, "sessionID": "ses_exact", "role": "user"},
                        "parts": [{"type": "text", "text": text}]
                    },
                    {
                        "info": {"id": assistant, "sessionID": "ses_exact", "role": "assistant", "parentID": id, "finish": "stop", "time": {"created": 1, "completed": 2}},
                        "parts": [
                            {"id": "prt_text", "sessionID": "ses_exact", "messageID": assistant, "type": "text", "text": "final answer"},
                            {"id": "prt_finish", "sessionID": "ses_exact", "messageID": assistant, "type": "step-finish", "reason": "stop"}
                        ]
                    }
                ])
            } else {
                return None;
            };
            Some(HttpResponse {
                status: 200,
                body: serde_json::to_vec(&response).unwrap(),
            })
        }
    }

    struct ImmediateClock(Mutex<Instant>);

    impl Clock for ImmediateClock {
        fn now(&self) -> Instant {
            *self.0.lock().unwrap()
        }

        fn sleep(&self, duration: Duration) {
            *self.0.lock().unwrap() += duration;
        }
    }

    struct World {
        _temp: tempfile::TempDir,
        sessions: LocalSessions,
        table: Arc<FakeProcesses>,
    }

    fn codex_exe() -> PathBuf {
        PathBuf::from("/opt/codex/bin/codex")
    }

    fn process(parent: i32, start: u64) -> FakeProcess {
        FakeProcess {
            parent,
            uid: UID,
            start,
            executable: Some("/bin/zsh".into()),
            ..FakeProcess::default()
        }
    }

    fn seed_codex_thread_with_source(home: &Path, thread: &str, source: &str) {
        std::fs::create_dir_all(home).unwrap();
        let db = rusqlite::Connection::open(home.join("state_5.sqlite")).unwrap();
        db.execute_batch(
            "create table threads (id text, title text, archived integer, source text)",
        )
        .unwrap();
        db.execute(
            "insert into threads values (?1, 'Fleet worker', 0, ?2)",
            [thread, source],
        )
        .unwrap();
    }

    fn seed_codex_thread(home: &Path, thread: &str) {
        seed_codex_thread_with_source(home, thread, "cli");
    }

    /// A Claude Code session (pid 300, started at tick 100) with a shell
    /// (310) and a command (320) inside it.
    fn world() -> World {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let registry = home.join(".claude/sessions");
        std::fs::create_dir_all(&registry).unwrap();
        std::fs::write(
            registry.join("300.json"),
            serde_json::json!({
                "sessionId": CLAUDE, "pid": 300, "procStart": "100", "peerProtocol": 1,
                "messagingSocketPath": home.join("peer.sock"), "cwd": "/Users/me/api", "name": "API work",
            })
            .to_string(),
        )
        .unwrap();
        let table = Arc::new(FakeProcesses {
            clock: Some(StartClock::Ticks),
            ..FakeProcesses::default()
        });
        table.trust(codex_exe());
        table.insert(300, process(1, 100));
        table.insert(310, process(300, 110));
        table.insert(320, process(310, 120));
        let config = LocalConfig {
            pi: crate::relay::pi::PiConfig::from_env(&|_| None, home),
            spawned_grok: None,
            codex: CodexConfig {
                home: home.join(".codex"),
                sqlite_home: home.join(".codex"),
                executable: None,
                ipc_socket: home.join("ipc.sock"),
            },
            claude: ClaudeConfig {
                home: home.join(".claude"),
                executable: None,
                app_sessions: None,
                dirs: Default::default(),
            },
            grok: GrokConfig {
                home: home.join(".grok"),
            },
            muse: MuseConfig {
                data_dir: home.join(".local").join("share").join("muse"),
            },
            muse_spawn: true,
            fleet: Fleet::new(home.join("relay")),
            uid: UID,
            auto_activate_excluded_dirs: vec![PathBuf::from("/tmp"), PathBuf::from("/var/tmp")],
            existing_grok: None,
            muse_spawn_journal: None,
            opencode: OpenCodeConfig::from_env(&|_| None, home),
            opencode_open: true,
            opencode_open_journal: None,
            devin: DevinConfig::from_env(&|_| None, home),
            devin_probe_root: None,
            openclaw: None,
            hermes: None,
        };
        World {
            sessions: LocalSessions::new(config, table.clone()),
            table,
            _temp: temp,
        }
    }

    fn target_of(world: &World, pid: i32) -> Option<Target> {
        world
            .sessions
            .caller(pid)
            .ok()
            .map(|session| session.target)
    }

    #[test]
    fn fleet_codex_binding_finds_the_kernel_proven_descendant_and_home() {
        let world = world();
        world.table.insert(500, process(1, 50));
        world.table.insert(510, process(500, 51));
        world.table.insert(
            520,
            FakeProcess {
                executable: Some(codex_exe()),
                arguments: vec![
                    "codex".into(),
                    "--dangerously-bypass-approvals-and-sandbox".into(),
                ],
                environment: [(
                    "CODEX_SQLITE_HOME".into(),
                    "/private/.codex/relay-agents/fleet-codex".into(),
                )]
                .into(),
                open_files: vec![PathBuf::from(format!(
                    "/private/.codex/thread-writer-locks/{THREAD}.lock"
                ))],
                has_terminal: true,
                ..process(510, 52)
            },
        );
        // The same thread outside the broker-owned tree is not authority for
        // this worker and must not make its binding ambiguous.
        world.table.insert(
            900,
            FakeProcess {
                executable: Some(codex_exe()),
                arguments: vec!["codex".into(), "resume".into(), THREAD.into()],
                has_terminal: true,
                ..process(1, 90)
            },
        );
        let worker = Worker {
            name: "fleet-codex".into(),
            cli: Some("codex".into()),
            // A starting broker may not have published sessionId yet. The
            // exact descendant's single writer lock remains authoritative.
            session_id: None,
            pid: Some(510),
            worker_pid: Some(500),
            ..Worker::default()
        };
        let binding = verified_fleet_codex_binding(
            &world.sessions.config,
            &*world.table,
            &worker,
            &Target::new(SessionKind::Codex, THREAD),
        )
        .unwrap();
        assert_eq!(binding.pid, 520);
        assert_eq!(binding.start, 52);
        assert_eq!(binding.config.home, world.sessions.config.codex.home);
        assert_eq!(
            binding.config.sqlite_home,
            PathBuf::from("/private/.codex/relay-agents/fleet-codex")
        );
        assert_eq!(binding.config.executable, Some(codex_exe()));
    }

    #[test]
    fn an_ordinary_codex_target_ignores_an_unrelated_fleet_worker_and_stale_broker() {
        let world = world();
        let relay_home = world._temp.path().join("relay");
        std::fs::create_dir_all(relay_home.join("node-claims")).unwrap();
        std::fs::write(
            relay_home.join("connection.json"),
            r#"{"url":"http://127.0.0.1:9","api_key":"never-send"}"#,
        )
        .unwrap();
        let fleet_home = world
            ._temp
            .path()
            .join(".codex/relay-agents/unrelated-fleet-codex");
        seed_codex_thread(&fleet_home, OTHER_THREAD);
        world.table.insert(
            500,
            FakeProcess {
                environment: [(
                    "CODEX_SQLITE_HOME".into(),
                    fleet_home.to_string_lossy().into_owned(),
                )]
                .into(),
                ..process(1, 50)
            },
        );
        world.table.insert(
            520,
            FakeProcess {
                executable: Some(codex_exe()),
                arguments: vec!["codex".into(), "resume".into(), THREAD.into()],
                open_files: vec![PathBuf::from(format!(
                    "/private/.codex/thread-writer-locks/{THREAD}.lock"
                ))],
                has_terminal: true,
                ..process(1, 52)
            },
        );
        let injector = LocalInjector::new(
            world.sessions.config.clone(),
            world.table.clone(),
            CodexRouter::new(Arc::new(UnusedCodexRoutes)),
            ServingPath::default(),
        );

        assert!(matches!(
            injector.fleet_codex_binding(&Target::new(SessionKind::Codex, THREAD)),
            FleetCodexResolution::NotManaged
        ));
        assert!(matches!(
            injector.inject_connect(
                &Target::new(SessionKind::Codex, THREAD),
                "ordinary-message",
                "hello",
            ),
            InjectOutcome::Waiting(_)
        ));
    }

    #[test]
    fn a_starting_fleet_sqlite_home_never_falls_through_to_the_default_codex_router() {
        let world = world();
        let fleet_home = world._temp.path().join(".codex/relay-agents/fleet-codex");
        seed_codex_thread_with_source(&fleet_home, THREAD, "future-fleet-source");
        world.table.insert(
            500,
            FakeProcess {
                environment: [(
                    "CODEX_SQLITE_HOME".into(),
                    fleet_home.to_string_lossy().into_owned(),
                )]
                .into(),
                ..process(1, 50)
            },
        );
        let injector = LocalInjector::new(
            world.sessions.config.clone(),
            world.table.clone(),
            CodexRouter::new(Arc::new(UnusedCodexRoutes)),
            ServingPath::default(),
        );

        assert!(matches!(
            injector.inject_connect(
                &Target::new(SessionKind::Codex, THREAD),
                "starting-message",
                "hello",
            ),
            InjectOutcome::Retry(reason) if reason.contains("not published")
        ));
    }

    #[test]
    fn a_lost_fleet_binding_checks_its_cached_rollout_before_reporting_in_doubt() {
        let world = world();
        // The cached provider PID has been replaced, which makes the current
        // fleet binding a refusal without erasing its isolated router.
        world.table.insert(520, process(1, 99));
        let recorded = Arc::new(ObservingCodexRoutes::default());
        recorded.recorded.store(true, Ordering::SeqCst);
        let cached_router = Arc::new(CodexRouter::new(recorded.clone()));
        let injector = LocalInjector::new(
            world.sessions.config.clone(),
            world.table.clone(),
            CodexRouter::new(Arc::new(UnusedCodexRoutes)),
            ServingPath::default(),
        );
        let target = Target::new(SessionKind::Codex, THREAD);
        injector.fleet_codex.lock().unwrap().insert(
            target.key(),
            FleetCodexRouter {
                binding: FleetCodexBinding {
                    worker_name: "fleet-codex".into(),
                    pid: 520,
                    start: 52,
                    config: world.sessions.config.codex.clone(),
                },
                router: cached_router,
            },
        );

        assert_eq!(
            injector.observe_connect(&target, "recorded-message", "hello"),
            InjectOutcome::Delivered
        );
        recorded.recorded.store(false, Ordering::SeqCst);
        assert!(matches!(
            injector.observe_connect(&target, "missing-message", "hello"),
            InjectOutcome::InDoubt(reason) if reason.contains("binding was lost")
        ));
    }

    #[test]
    fn fleet_codex_binding_refuses_a_mismatched_or_ambiguous_process_tree() {
        let world = world();
        world.table.insert(500, process(1, 50));
        let worker = Worker {
            name: "fleet-codex".into(),
            cli: Some("codex".into()),
            session_id: Some(THREAD.into()),
            worker_pid: Some(500),
            ..Worker::default()
        };
        assert!(matches!(
            verified_fleet_codex_binding(
                &world.sessions.config,
                &*world.table,
                &worker,
                &Target::new(SessionKind::Codex, THREAD),
            ),
            Err(FleetCodexBindingError::Unavailable(reason))
                if reason.contains("has not started")
        ));

        let codex = || FakeProcess {
            executable: Some(codex_exe()),
            arguments: vec!["codex".into(), "--dangerously-bypass".into()],
            environment: [(
                "CODEX_SQLITE_HOME".into(),
                "/private/.codex/relay-agents/fleet-codex".into(),
            )]
            .into(),
            open_files: vec![PathBuf::from(format!(
                "/private/.codex/thread-writer-locks/{THREAD}.lock"
            ))],
            has_terminal: true,
            ..process(500, 52)
        };
        world.table.insert(520, codex());
        assert!(verified_fleet_codex_binding(
            &world.sessions.config,
            &*world.table,
            &worker,
            &Target::new(SessionKind::Codex, "11111111-2222-3333-4444-555555555556"),
        )
        .unwrap_err()
        .reason()
        .contains("does not own"));

        world.table.insert(521, codex());
        assert!(verified_fleet_codex_binding(
            &world.sessions.config,
            &*world.table,
            &worker,
            &Target::new(SessionKind::Codex, THREAD),
        )
        .unwrap_err()
        .reason()
        .contains("More than one"));
    }

    /// End-to-end proof against a worker created solely for this test. The
    /// caller must name both the broker state directory and the exact thread;
    /// there is intentionally no ambient-session fallback.
    #[test]
    #[ignore = "requires an isolated fleet-spawned Codex worker"]
    fn real_fleet_codex_connect_handoff_uses_the_broker_owned_thread() {
        let relay_home = std::env::var("RELAY_DESKTOP_TEST_FLEET_HOME")
            .expect("RELAY_DESKTOP_TEST_FLEET_HOME must name the isolated broker state");
        let thread = std::env::var("RELAY_DESKTOP_TEST_FLEET_THREAD")
            .expect("RELAY_DESKTOP_TEST_FLEET_THREAD must name the isolated Codex thread");
        let message_id = std::env::var("RELAY_DESKTOP_TEST_FLEET_MESSAGE_ID")
            .expect("RELAY_DESKTOP_TEST_FLEET_MESSAGE_ID must be unique to this proof");
        let proof = std::env::var("RELAY_DESKTOP_TEST_FLEET_PROOF")
            .expect("RELAY_DESKTOP_TEST_FLEET_PROOF must name the expected proof token");
        let home = PathBuf::from(std::env::var("HOME").expect("HOME is required"));
        let env = |key: &str| match key {
            "AGENT_RELAY_HOME" => Some(relay_home.clone()),
            _ => std::env::var(key).ok(),
        };
        let config = LocalConfig::from_env(&env, &home);
        let table: Arc<dyn ProcessTable> = Arc::new(SystemProcesses::default());
        let routes = Arc::new(SystemCodexRoutes::new(
            config.codex.clone(),
            table.clone(),
            config.uid,
        ));
        let injector = LocalInjector::new(
            config,
            table,
            CodexRouter::new(routes),
            ServingPath::default(),
        );
        let reference = crate::relay::delivery::policy::MessageRef::of(&message_id);
        let text = format!(
            "[Relay Connect real fleet proof · ref {reference}]\n\n\
             Send a DM to codex-test-mini-node-848f43 containing exactly this token: {proof}"
        );
        let target = Target::new(SessionKind::Codex, thread);
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            let outcome = injector.inject_connect(&target, &message_id, &text);
            match outcome {
                InjectOutcome::Delivered => break,
                InjectOutcome::Accepted(_) | InjectOutcome::WaitingForTurn(_)
                    if Instant::now() < deadline =>
                {
                    std::thread::sleep(Duration::from_millis(250));
                }
                outcome => panic!("isolated fleet handoff did not settle: {outcome:?}"),
            }
        }
    }

    #[test]
    fn recipient_delivery_ids_isolate_managed_journal_entries_with_one_message_id() {
        let temp = tempfile::tempdir().unwrap();
        let executable = std::env::current_exe().unwrap();
        let marker = "probe-marker";
        let table = Arc::new(FakeProcesses::default());
        table.insert(
            42,
            FakeProcess {
                parent: 1,
                uid: crate::relay::peer::current_uid(),
                start: 777,
                executable: Some(executable.clone()),
                arguments: vec![
                    "opencode".into(),
                    "serve".into(),
                    "--hostname".into(),
                    "127.0.0.1".into(),
                    "--port".into(),
                    "4096".into(),
                ],
                environment: [
                    ("OPENCODE_SERVER_USERNAME".into(), "relay".into()),
                    ("OPENCODE_SERVER_PASSWORD".into(), "super-secret".into()),
                    ("AGENT_RELAY_MANAGED_SESSION_MARKER".into(), marker.into()),
                ]
                .into(),
                tcp_listeners: vec![("127.0.0.1".into(), 4096)],
                ..FakeProcess::default()
            },
        );
        let mut binding = opencode_existing::Binding {
            relay_workspace_id: "rw_exact".into(),
            owner_id: "owner-exact".into(),
            session_id: "ses_exact".into(),
            endpoint: "http://127.0.0.1:4096/".into(),
            server_pid: 42,
            server_start: 777,
            server_uid: crate::relay::peer::current_uid(),
            executable: executable.clone(),
            directory: PathBuf::from("/work/project"),
            project_id: "prj_exact".into(),
            opencode_workspace_id: Some("wrk_exact".into()),
            credential_reference: String::new(),
        };
        binding.credential_reference = opencode_existing::credential_reference(&binding, marker);
        let managed_binding = ManagedBinding::OpenCode(binding.clone());
        let manager = Arc::new(ManagedSessions::new(
            temp.path().join("managed"),
            HashSet::from([SessionKind::OpenCode]),
            Arc::new(FixedManagedRuntime(managed_binding)),
        ));
        manager
            .launch(ManagedLaunch {
                kind: SessionKind::OpenCode,
                executable,
                directory: binding.directory.clone(),
                session_id: binding.session_id.clone(),
                authority: crate::relay::managed_sessions::ManagedAuthority {
                    workspace_id: binding.relay_workspace_id.clone(),
                    owner_id: binding.owner_id.clone(),
                    owner_uid: binding.server_uid,
                },
            })
            .unwrap();

        let http = Arc::new(CompletingOpenCode::default());
        let clock = Arc::new(ImmediateClock(Mutex::new(Instant::now())));
        let config = LocalConfig::from_env(&|_| None, temp.path());
        let mut injector = LocalInjector::new(
            config,
            table.clone(),
            CodexRouter::new(Arc::new(UnusedCodexRoutes)),
            ServingPath::default(),
        )
        .with_managed(manager.clone());
        injector.opencode = Some(
            opencode_existing::OpenCodeInjector::new(
                table,
                http.clone(),
                clock,
                &manager.journal("opencode"),
            )
            .unwrap(),
        );

        let registration = |name: &str, agent_id: &str| -> crate::relay::store::Registration {
            serde_json::from_value(serde_json::json!({
                "name": name,
                "agentID": agent_id,
                "target": {"kind": "opencode", "id": "ses_exact"},
                "baseURL": "https://cast.agentrelay.com",
                "registeredAt": "2026-10-04T00:00:00Z"
            }))
            .unwrap()
        };
        let first = registration("recipient-one", "agent-one");
        let second = registration("recipient-two", "agent-two");
        let reference = crate::relay::delivery::policy::MessageRef::of("shared-message");
        let first_text = format!(
            "[via Agent Relay — from @sender to @recipient-one · message shared-message · ref {reference}]\n\nfirst text"
        );

        assert_eq!(
            injector.inject_registered(&first, "delivery-one", "shared-message", &first_text),
            InjectOutcome::Delivered
        );
        assert_eq!(
            injector.inject_registered(&first, "delivery-one", "shared-message", &first_text),
            InjectOutcome::Delivered
        );
        assert_eq!(http.prompts.lock().unwrap().len(), 1);
        assert_eq!(
            injector.final_answer_registered(&first, &reference),
            Some("final answer".into())
        );
        assert_eq!(
            injector.inject_registered(&second, "delivery-two", "shared-message", "second text"),
            InjectOutcome::Delivered
        );
        assert_eq!(http.prompts.lock().unwrap().len(), 2);
    }

    // A Claude Code session in Conductor is asked to quote a relayed
    // message, which Conductor's chat does not show; others are not.
    #[test]
    fn only_a_claude_code_session_in_conductor_gets_the_quote_note() {
        let world = world();
        let injector = LocalInjector::new(
            world.sessions.config.clone(),
            world.table.clone(),
            CodexRouter::new(Arc::new(UnusedCodexRoutes)),
            ServingPath::default(),
        );
        let claude = Target::new(SessionKind::ClaudeTerminal, CLAUDE);
        assert_eq!(
            injector.host_note(&claude),
            None,
            "/Users/me/api is not Conductor's"
        );
        let home = world._temp.path();
        std::fs::write(
            home.join(".claude/sessions/300.json"),
            serde_json::json!({
                "sessionId": CLAUDE, "pid": 300, "procStart": "100", "peerProtocol": 1,
                "messagingSocketPath": home.join("peer.sock"),
                "cwd": "/Users/me/conductor/workspaces/api/amarillo", "name": "amarillo",
            })
            .to_string(),
        )
        .unwrap();
        assert_eq!(
            injector.host_note(&claude).as_deref(),
            Some(crate::relay::conductor::QUOTE_NOTE)
        );
        assert_eq!(
            injector.host_note(&Target::new(SessionKind::Codex, THREAD)),
            None
        );
    }

    // OutboundTests.testFindsNearestRegisteredAncestor,
    // testDirectClaudeResolutionRequiresRegistryStartTime and
    // test_finds_the_nearest_registered_ancestor.
    #[test]
    fn a_command_inside_claude_code_is_that_session() {
        let world = world();
        let claude = Target::new(SessionKind::ClaudeTerminal, CLAUDE);
        assert_eq!(target_of(&world, 320), Some(claude.clone()));
        assert_eq!(target_of(&world, 300), Some(claude));
        let found = world.sessions.caller(320).unwrap();
        assert_eq!(found.title, "API work");
        assert!(found.live);
    }

    /// A `devin` process (pid 400) holding its session lock open, with a
    /// tool shell (410) and a command (420) inside it.
    fn devin_session_process(world: &World, session: &str) {
        let locks = world.sessions.config.devin.session_locks();
        std::fs::create_dir_all(&locks).unwrap();
        let lock = locks.join(format!("{session}.lock"));
        std::fs::write(&lock, "400").unwrap();
        world.table.insert(
            400,
            FakeProcess {
                executable: Some("/opt/devin/bin/devin".into()),
                open_files: vec![lock],
                ..process(1, 100)
            },
        );
        world.table.insert(410, process(400, 110));
        world.table.insert(420, process(410, 120));
    }

    /// An OpenClaw Gateway (600) of this user, its Codex runtime (610,
    /// carrying a Codex thread tag), a tool shell (620) and `curl` (630).
    fn openclaw_gateway_process(world: &mut World, agents: &[&str]) {
        let state = world._temp.path().join(".openclaw");
        std::fs::create_dir_all(&state).unwrap();
        std::fs::write(
            state.join("openclaw.json"),
            "{ gateway: { auth: { token: 't' } } }",
        )
        .unwrap();
        let env = std::collections::BTreeMap::from([(
            "OPENCLAW_STATE_DIR".to_string(),
            state.display().to_string(),
        )]);
        world.sessions.config.openclaw = Some(OpenClawConfig::new(
            &env,
            world._temp.path(),
            &world._temp.path().join("app"),
        ));
        world.sessions.openclaw = crate::relay::openclaw::Listing::seeded(
            agents
                .iter()
                .map(|id| DiscoveredSession {
                    target: Target::new(SessionKind::OpenClaw, *id),
                    title: format!("OpenClaw · {id}"),
                    directory: None,
                    updated_at_ms: None,
                    host: None,
                    live: true,
                    holder: None,
                })
                .collect(),
        );
        world.table.insert(
            600,
            FakeProcess {
                executable: Some("/opt/homebrew/opt/node/bin/node".into()),
                arguments: vec![
                    "/opt/homebrew/opt/node/bin/node".into(),
                    "/opt/homebrew/lib/node_modules/openclaw/dist/index.js".into(),
                    "gateway".into(),
                    "--port".into(),
                    "18789".into(),
                ],
                ..process(1, 600)
            },
        );
        world.table.insert(
            610,
            FakeProcess {
                executable: Some(codex_exe()),
                ..process(600, 610)
            },
        );
        let mut shell = process(610, 620);
        shell.environment.insert(
            "CODEX_THREAD_ID".into(),
            "11111111-2222-3333-4444-555555555555".into(),
        );
        world.table.insert(620, shell);
        world.table.insert(630, process(620, 630));
    }

    #[test]
    fn a_command_under_the_openclaw_gateway_is_its_agent() {
        let mut world = world();
        openclaw_gateway_process(&mut world, &["main"]);
        let agent = Target::new(SessionKind::OpenClaw, "main");
        // Its inherited Codex thread tag names nobody.
        assert_eq!(target_of(&world, 630), Some(agent.clone()));
        assert_eq!(target_of(&world, 620), Some(agent));
        // Outside the Gateway nothing changes.
        assert_eq!(
            target_of(&world, 320),
            Some(Target::new(SessionKind::ClaudeTerminal, CLAUDE))
        );
    }

    #[test]
    fn a_gateway_with_several_agents_names_no_caller() {
        let mut world = world();
        openclaw_gateway_process(&mut world, &["main", "work"]);
        assert_eq!(target_of(&world, 630), None);
    }

    #[test]
    fn a_command_inside_devin_is_that_session() {
        let world = world();
        devin_session_process(&world, "real-gallium");
        let devin = Target::new(SessionKind::Devin, "real-gallium");
        assert_eq!(target_of(&world, 420), Some(devin.clone()));
        assert_eq!(target_of(&world, 400), Some(devin));
        let found = world.sessions.caller(420).unwrap();
        assert_eq!(found.title, "real-gallium");
        assert!(found.live);
    }

    /// A live install `probe/install-a` under the Devin home, its catalog
    /// carrying one remote observation per `rows` entry, with the local
    /// config pointed at the probe root.
    fn cloud_catalog(world: &mut World, rows: &[(&str, &str)]) {
        let install = world
            .sessions
            .config
            .devin
            .home
            .join("probe")
            .join("install-a");
        std::fs::create_dir_all(&install).unwrap();
        std::fs::write(install.join("config.json"), "{}").unwrap();
        let store = ai_hist::SessionStore::open(
            ai_hist::StoreOptions::default().db_path(install.join("history.db")),
        )
        .unwrap();
        store
            .apply_source_observations(ai_hist::SourceObservationBatch::new(
                "devin-cloud",
                "default",
                ai_hist::SessionLocation::Remote,
                rows.iter()
                    .map(|(id, title)| ai_hist::SourceObservation {
                        session: ai_hist::ShallowSession {
                            source: "devin".into(),
                            session_id: (*id).into(),
                            title: Some((*title).into()),
                            source_stamp: Some(format!("cloud:100:active:{id}")),
                            ..Default::default()
                        },
                        raw_locator: Some(format!("v3:sessions/{id}")),
                    })
                    .collect(),
            ))
            .unwrap();
        drop(store);
        world.sessions.config.devin_probe_root =
            Some(world.sessions.config.devin.home.join("probe"));
    }

    /// A Devin Cloud session lives only in the history catalog — no lock,
    /// no process — yet discovery lists it so the relay can register it,
    /// hosted by the service that runs it. A session a local lock also
    /// holds keeps only its local row.
    #[test]
    fn discovery_lists_catalog_devin_cloud_sessions() {
        let mut world = world();
        let cloud = "4b50574f40324da6bd88e9cbd30501cf";
        let held = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        cloud_catalog(
            &mut world,
            &[(cloud, "Cloud-only task"), (held, "Cloud title")],
        );
        devin_session_process(&world, held);
        let found = world.sessions.sessions();
        let cloud_row = found
            .iter()
            .find(|session| session.target.id == cloud)
            .expect("the catalog's remote row is listed");
        assert_eq!(cloud_row.target, Target::new(SessionKind::Devin, cloud));
        assert_eq!(cloud_row.title, "Cloud-only task");
        assert_eq!(cloud_row.host.as_deref(), Some("Devin Cloud"));
        // The locally held session keeps its local row only: one row, no
        // cloud host, the lock's title.
        let held_rows: Vec<_> = found
            .iter()
            .filter(|session| session.target.id == held)
            .collect();
        assert_eq!(held_rows.len(), 1);
        assert!(held_rows[0].host.is_none());
    }

    /// A cloud row's caller proof is the machine's Devin sign-in — the
    /// same credential the send resolves — so it auto-activates like a
    /// lock-holding local session while the connector is configured, and
    /// is inert without one.
    #[test]
    fn a_devin_cloud_session_auto_activates_on_the_sign_in() {
        let _lock = crate::relay::devin_cloud::tests::ENV_LOCK
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let mut world = world();
        let cloud = "4b50574f40324da6bd88e9cbd30501cf";
        cloud_catalog(&mut world, &[(cloud, "Cloud-only task")]);
        let activated = |world: &World| {
            world
                .sessions
                .auto_activation_sessions()
                .iter()
                .any(|session| session.target.id == cloud)
        };
        let _unsigned = crate::relay::devin_cloud::tests::unsigned_env();
        assert!(!activated(&world), "unsigned-in: no caller proof");
        let _env = crate::relay::devin_cloud::tests::signed_in_env();
        assert!(activated(&world), "signed in: the row activates itself");
    }

    // A `devin` command that is not a session — `devin plugins`, say — holds
    // no lock and ends the walk, so a tool it runs inside a Claude Code
    // session is never named that session.
    #[test]
    fn a_devin_command_without_a_lock_ends_the_walk() {
        let world = world();
        world.table.insert(
            500,
            FakeProcess {
                executable: Some("/opt/devin/bin/devin".into()),
                ..process(310, 130)
            },
        );
        world.table.insert(510, process(500, 140));
        assert_eq!(target_of(&world, 510), None);
    }

    // A Devin session nested inside Codex inherits `CODEX_THREAD_ID`, but
    // the nearer `devin` ancestor — the lock it holds — decides who the
    // caller is; the enclosing thread's tag names nobody.
    #[test]
    fn a_devin_nested_inside_codex_is_devin_not_the_enclosing_thread() {
        let world = world();
        // An outer trusted Codex holding the thread's writer lock.
        world.table.insert(
            600,
            FakeProcess {
                executable: Some(codex_exe()),
                open_files: vec![PathBuf::from(format!(
                    "/private/.codex/thread-writer-locks/{THREAD}.lock"
                ))],
                ..process(1, 100)
            },
        );
        // A Devin session (pid 610) running inside it.
        let locks = world.sessions.config.devin.session_locks();
        std::fs::create_dir_all(&locks).unwrap();
        let lock = locks.join("nested-devin.lock");
        std::fs::write(&lock, "610").unwrap();
        world.table.insert(
            610,
            FakeProcess {
                executable: Some("/opt/devin/bin/devin".into()),
                open_files: vec![lock],
                ..process(600, 110)
            },
        );
        // Its tool shell inherited the enclosing session's thread id.
        world.table.insert(
            620,
            FakeProcess {
                environment: [(
                    "CODEX_THREAD_ID".into(),
                    "5f7c1f64-8f53-4c33-9d2f-7c1d2f1f0a11".into(),
                )]
                .into(),
                ..process(610, 120)
            },
        );
        assert_eq!(
            target_of(&world, 620),
            Some(Target::new(SessionKind::Devin, "nested-devin"))
        );
    }

    // A command inside a running Claude Code session whose registry file no
    // longer parses learns which file it is. The walk ends at that session
    // instead of naming an outer one.
    #[test]
    fn a_command_inside_a_session_with_an_unparseable_file_names_that_file() {
        let world = world();
        let registry = world._temp.path().join(".claude/sessions");
        // An outer Claude Code session (200) around the broken one (300).
        std::fs::write(
            registry.join("200.json"),
            serde_json::json!({
                "sessionId": "11111111-2222-3333-4444-555555555555", "pid": 200,
                "procStart": "90", "peerProtocol": 1, "messagingSocketPath": "/s",
            })
            .to_string(),
        )
        .unwrap();
        world.table.insert(200, process(1, 90));
        world.table.insert(300, process(200, 100));
        let file = registry.join("300.json");
        std::fs::write(&file, r#"{"sessionId": "#).unwrap();
        // Without a key recording this process's start, the file is not tied
        // to it, and the walk goes on as before.
        assert_eq!(
            target_of(&world, 320),
            Some(Target::new(
                SessionKind::ClaudeTerminal,
                "11111111-2222-3333-4444-555555555555"
            ))
        );

        std::fs::write(
            registry.join("300.abc.key"),
            serde_json::json!({"peerToken": "tok", "procStart": "100"}).to_string(),
        )
        .unwrap();
        let Err(CallerMiss::Unreadable(found)) = world.sessions.caller(320) else {
            panic!("expected an unreadable session file");
        };
        assert_eq!(found.path, file);
        assert_eq!(found.pid, 300);
        assert_eq!(world.sessions.unreadable_session_files(), vec![found]);
    }

    // testRejectsProcessOutsideSession, testRejectsRecycledPIDStartTime,
    // test_a_process_outside_every_session_is_nobody and
    // test_a_recycled_pid_is_not_the_session.
    #[test]
    fn a_recycled_pid_or_an_outside_process_is_nobody() {
        let world = world();
        world.table.insert(900, process(1, 5));
        assert_eq!(target_of(&world, 900), None);
        world.table.insert(300, process(1, 101));
        assert_eq!(target_of(&world, 320), None);
    }

    // test_a_session_without_a_start_time_never_matches.
    #[test]
    fn a_session_without_a_recorded_start_never_matches() {
        let world = world();
        let registry = world.sessions.config.claude.registry();
        let mut record: serde_json::Value =
            serde_json::from_slice(&std::fs::read(registry.join("300.json")).unwrap()).unwrap();
        record.as_object_mut().unwrap().remove("procStart");
        std::fs::write(registry.join("300.json"), record.to_string()).unwrap();
        assert_eq!(target_of(&world, 320), None);
    }

    // OutboundTests.testDirectResolutionWalksPastDifferentUIDIntermediate.
    #[test]
    fn another_users_intermediate_is_walked_past() {
        let world = world();
        world.table.insert(
            310,
            FakeProcess {
                uid: 0,
                ..process(300, 110)
            },
        );
        assert_eq!(
            target_of(&world, 320),
            Some(Target::new(SessionKind::ClaudeTerminal, CLAUDE))
        );
        // But the session itself must be this user's.
        world.table.insert(
            300,
            FakeProcess {
                uid: 0,
                ..process(1, 100)
            },
        );
        assert_eq!(target_of(&world, 320), None);
    }

    // testDirectCodexResolutionUsesThePeerThreadEnvironment and
    // test_codex_caller_resolves_from_environment_below_trusted_ancestor.
    #[test]
    fn a_codex_command_is_its_thread_even_inside_claude() {
        let world = world();
        // Codex runs inside the Claude session's shell and holds its lock.
        world.table.insert(
            400,
            FakeProcess {
                executable: Some(codex_exe()),
                open_files: vec![PathBuf::from(format!(
                    "/Users/me/.codex/thread-writer-locks/{THREAD}.lock"
                ))],
                ..process(310, 130)
            },
        );
        world.table.insert(
            410,
            FakeProcess {
                environment: [("CODEX_THREAD_ID".to_string(), THREAD.to_string())].into(),
                ..process(400, 140)
            },
        );
        assert_eq!(
            target_of(&world, 410),
            Some(Target::new(SessionKind::Codex, THREAD))
        );
        assert_eq!(world.sessions.caller(410).unwrap().title, "Codex session");
        // A forged thread id is refused, never resolved to the outer
        // Claude session.
        world.table.insert(
            410,
            FakeProcess {
                environment: [(
                    "CODEX_THREAD_ID".to_string(),
                    "019a0000-0000-7000-8000-00000000ffff".to_string(),
                )]
                .into(),
                ..process(400, 140)
            },
        );
        assert_eq!(target_of(&world, 410), None);
    }

    // testCodexPeerResolutionFindsOnlyATrustedResumeAncestor and the
    // nearest-session rule: a Codex never lends a caller an outer identity.
    #[test]
    fn the_walk_ends_at_the_first_codex() {
        let world = world();
        world.table.insert(
            400,
            FakeProcess {
                executable: Some(codex_exe()),
                arguments: vec!["codex".into(), "resume".into(), THREAD.into()],
                ..process(310, 130)
            },
        );
        world.table.insert(410, process(400, 140));
        assert_eq!(
            target_of(&world, 410),
            Some(Target::new(SessionKind::Codex, THREAD))
        );
        world.table.insert(
            400,
            FakeProcess {
                executable: Some(codex_exe()),
                arguments: vec!["codex".into()],
                ..process(310, 130)
            },
        );
        assert_eq!(target_of(&world, 410), None);
        // An untrusted binary named codex is just a process.
        world.table.trusted_codex.lock().unwrap().clear();
        assert_eq!(
            target_of(&world, 410),
            Some(Target::new(SessionKind::ClaudeTerminal, CLAUDE))
        );
    }

    // OutboundTests.testCallerResolutionStaysUnderOneHundredMillisecondsWithLargeFakeTable,
    // testCallerResolutionDoesNotScanUnrelatedProcesses and
    // test_resolution_ignores_a_large_unrelated_process_table_and_is_fast.
    #[test]
    fn resolution_reads_only_the_callers_ancestry() {
        let world = world();
        for pid in 10_000..30_000 {
            world.table.insert(pid, process(1, pid as u64));
        }
        let started = std::time::Instant::now();
        assert!(target_of(&world, 320).is_some());
        assert!(started.elapsed() < std::time::Duration::from_millis(500));
    }

    #[test]
    fn discovery_lists_the_live_claude_session() {
        let world = world();
        let found = world.sessions.sessions();
        assert_eq!(found.len(), 1);
        assert_eq!(
            found[0].target,
            Target::new(SessionKind::ClaudeTerminal, CLAUDE)
        );
        assert_eq!(world.sessions.fleet_owned(&found[0].target), Ok(false));
    }

    #[test]
    fn auto_activation_only_lists_interactive_non_temporary_sessions() {
        let mut world = world();
        {
            let mut processes = world.table.processes.lock().unwrap();
            let claude = processes.get_mut(&300).unwrap();
            claude.arguments = vec!["claude".into()];
            claude.has_terminal = true;
        }
        assert_eq!(world.sessions.auto_activation_sessions().len(), 1);

        world
            .table
            .processes
            .lock()
            .unwrap()
            .get_mut(&300)
            .unwrap()
            .arguments = vec!["claude".into(), "-p".into(), "run tests".into()];
        assert!(world.sessions.auto_activation_sessions().is_empty());

        world
            .table
            .processes
            .lock()
            .unwrap()
            .get_mut(&300)
            .unwrap()
            .arguments = vec!["claude".into(), "--output-format=stream-json".into()];
        assert!(world.sessions.auto_activation_sessions().is_empty());

        {
            let claude = world
                .table
                .processes
                .lock()
                .unwrap()
                .get_mut(&300)
                .unwrap()
                .clone();
            world.table.insert(
                300,
                FakeProcess {
                    arguments: vec!["claude".into()],
                    has_terminal: false,
                    ..claude
                },
            );
        }
        assert!(world.sessions.auto_activation_sessions().is_empty());

        world
            .table
            .processes
            .lock()
            .unwrap()
            .get_mut(&300)
            .unwrap()
            .has_terminal = true;
        world.sessions.config.auto_activate_excluded_dirs = vec![PathBuf::from("/Users/me")];
        assert!(world.sessions.auto_activation_sessions().is_empty());
    }


    // A Conductor chat is a stream-json Agent SDK run with no terminal, like
    // automation, but a person types in it: it is auto-activated when it is
    // in a Conductor workspace and Conductor's sidecar started it.
    #[test]
    fn a_claude_chat_conductor_runs_is_auto_activated() {
        let world = world();
        let home = world._temp.path();
        std::fs::write(
            home.join(".claude/sessions/300.json"),
            serde_json::json!({
                "sessionId": CLAUDE, "pid": 300, "procStart": "100", "peerProtocol": 1,
                "messagingSocketPath": home.join("peer.sock"),
                "cwd": "/Users/me/conductor/workspaces/api/ankara", "name": "ankara-01",
            })
            .to_string(),
        )
        .unwrap();
        let runtime = PathBuf::from(
            "/Users/me/Library/Application Support/com.conductor.app/bin/.internal/conductor-runtime",
        );
        let sdk_run = |parent| FakeProcess {
            arguments: vec![
                "claude".into(),
                "--output-format".into(),
                "stream-json".into(),
                "--input-format".into(),
                "stream-json".into(),
            ],
            has_terminal: false,
            ..process(parent, 100)
        };
        // The same run outside Conductor is automation.
        world.table.insert(300, sdk_run(1));
        assert!(world.sessions.auto_activation_sessions().is_empty());
        // Below Conductor's runtime, but not its sidecar.
        world.table.insert(
            290,
            FakeProcess {
                executable: Some(runtime.clone()),
                arguments: vec![runtime.display().to_string(), "logger".into()],
                ..process(1, 90)
            },
        );
        world.table.insert(300, sdk_run(290));
        assert!(world.sessions.auto_activation_sessions().is_empty());
        // Started by the sidecar, through a launcher script that exec'd.
        world.table.insert(
            290,
            FakeProcess {
                executable: Some(runtime.clone()),
                arguments: vec![runtime.display().to_string(), "sidecar".into()],
                ..process(1, 90)
            },
        );
        let found = world.sessions.auto_activation_sessions();
        assert_eq!(found.len(), 1);
        assert_eq!(
            found[0].target,
            Target::new(SessionKind::ClaudeTerminal, CLAUDE)
        );
        // Review on #382: a `claude -p` the chat runs from its shell has the
        // same workspace and reaches the sidecar only through the chat.
        let nested = "22222222-3333-4444-5555-666666666666";
        std::fs::write(
            home.join(".claude/sessions/400.json"),
            serde_json::json!({
                "sessionId": nested, "pid": 400, "procStart": "140", "peerProtocol": 1,
                "messagingSocketPath": home.join("nested.sock"),
                "cwd": "/Users/me/conductor/workspaces/api/ankara",
            })
            .to_string(),
        )
        .unwrap();
        world.table.insert(390, process(300, 130));
        world.table.insert(
            400,
            FakeProcess {
                arguments: vec!["claude".into(), "-p".into(), "summarize".into()],
                ..process(390, 140)
            },
        );
        let found = world.sessions.auto_activation_sessions();
        assert_eq!(
            found
                .iter()
                .map(|s| s.target.id.as_str())
                .collect::<Vec<_>>(),
            [CLAUDE],
            "only the chat, not the run it started"
        );
        std::fs::remove_file(home.join(".claude/sessions/400.json")).unwrap();
        // A sidecar run outside a Conductor workspace is not a chat.
        std::fs::write(
            home.join(".claude/sessions/300.json"),
            serde_json::json!({
                "sessionId": CLAUDE, "pid": 300, "procStart": "100", "peerProtocol": 1,
                "messagingSocketPath": home.join("peer.sock"), "cwd": "/Users/me/api",
            })
            .to_string(),
        )
        .unwrap();
        assert!(world.sessions.auto_activation_sessions().is_empty());
    }

    #[test]
    fn a_top_level_claude_chat_paseo_runs_is_hosted_and_auto_activated() {
        let world = world();
        let home = world._temp.path();
        std::fs::write(
            home.join(".claude/sessions/300.json"),
            serde_json::json!({
                "sessionId": CLAUDE, "pid": 300, "procStart": "100", "peerProtocol": 1,
                "messagingSocketPath": home.join("peer.sock"),
                "cwd": "/Users/me/api", "name": "api",
            })
            .to_string(),
        )
        .unwrap();
        let helper = PathBuf::from(
            "/Applications/Paseo.app/Contents/Frameworks/Paseo Helper.app/Contents/MacOS/Paseo Helper",
        );
        world.table.insert(
            280,
            FakeProcess {
                executable: Some(helper),
                ..process(1, 80)
            },
        );
        world.table.insert(290, process(280, 90));
        world.table.insert(
            300,
            FakeProcess {
                arguments: vec![
                    "claude".into(),
                    "--output-format".into(),
                    "stream-json".into(),
                    "--input-format".into(),
                    "stream-json".into(),
                ],
                has_terminal: false,
                ..process(290, 100)
            },
        );

        let listed = world.sessions.sessions();
        let chat = listed
            .iter()
            .find(|session| session.target.id == CLAUDE)
            .unwrap();
        assert_eq!(chat.host.as_deref(), Some("paseo"));
        let activated = world.sessions.auto_activation_sessions();
        assert_eq!(activated.len(), 1);
        assert_eq!(activated[0].target.id, CLAUDE);

        // A structured Claude run below the chat is the chat's automation,
        // not another Paseo chat.
        let nested = "22222222-3333-4444-5555-666666666666";
        std::fs::write(
            home.join(".claude/sessions/400.json"),
            serde_json::json!({
                "sessionId": nested, "pid": 400, "procStart": "140", "peerProtocol": 1,
                "messagingSocketPath": home.join("nested.sock"), "cwd": "/Users/me/api",
            })
            .to_string(),
        )
        .unwrap();
        world.table.insert(390, process(300, 130));
        world.table.insert(
            400,
            FakeProcess {
                arguments: vec!["claude".into(), "-p".into(), "summarize".into()],
                ..process(390, 140)
            },
        );
        let activated = world.sessions.auto_activation_sessions();
        assert_eq!(
            activated
                .iter()
                .map(|session| session.target.id.as_str())
                .collect::<Vec<_>>(),
            [CLAUDE]
        );
        let listed = world.sessions.sessions();
        assert_eq!(
            listed
                .iter()
                .find(|session| session.target.id == nested)
                .and_then(|session| session.host.as_deref()),
            None
        );
    }

    #[test]
    fn a_claude_app_chat_is_auto_activated_like_a_terminal() {
        let world = world();
        let home = world._temp.path();
        let record = |entrypoint: &str| {
            serde_json::json!({
                "sessionId": CLAUDE, "pid": 300, "procStart": "100", "peerProtocol": 1,
                "messagingSocketPath": home.join("peer.sock"),
                "cwd": "/Users/me/api", "name": "Ping",
                "kind": "interactive", "entrypoint": entrypoint,
            })
            .to_string()
        };
        let app = PathBuf::from("/Applications/Claude.app/Contents/MacOS/Claude");
        world.table.insert(
            280,
            FakeProcess {
                executable: Some(app),
                ..process(1, 80)
            },
        );
        world.table.insert(290, process(280, 90));
        world.table.insert(
            300,
            FakeProcess {
                arguments: vec![
                    "claude".into(),
                    "--output-format".into(),
                    "stream-json".into(),
                    "--input-format".into(),
                    "stream-json".into(),
                ],
                has_terminal: false,
                ..process(290, 100)
            },
        );

        // Another structured run under the app is not a chat.
        std::fs::write(home.join(".claude/sessions/300.json"), record("sdk-ts")).unwrap();
        assert!(world.sessions.auto_activation_sessions().is_empty());

        std::fs::write(
            home.join(".claude/sessions/300.json"),
            record(crate::relay::claude::app::ENTRYPOINT),
        )
        .unwrap();
        let activated = world.sessions.auto_activation_sessions();
        assert_eq!(activated.len(), 1);
        assert_eq!(activated[0].target.id, CLAUDE);

        // A `claude -p` the chat runs from its tools stays automation.
        let nested = "22222222-3333-4444-5555-666666666666";
        std::fs::write(
            home.join(".claude/sessions/400.json"),
            serde_json::json!({
                "sessionId": nested, "pid": 400, "procStart": "140", "peerProtocol": 1,
                "messagingSocketPath": home.join("nested.sock"), "cwd": "/Users/me/api",
                "kind": "interactive", "entrypoint": crate::relay::claude::app::ENTRYPOINT,
            })
            .to_string(),
        )
        .unwrap();
        world.table.insert(390, process(300, 130));
        world.table.insert(
            400,
            FakeProcess {
                arguments: vec!["claude".into(), "-p".into(), "summarize".into()],
                ..process(390, 140)
            },
        );
        let activated = world.sessions.auto_activation_sessions();
        assert_eq!(
            activated
                .iter()
                .map(|session| session.target.id.as_str())
                .collect::<Vec<_>>(),
            [CLAUDE]
        );
    }

    #[test]
    fn configured_auto_activation_roots_replace_the_temp_defaults() {
        let env = |key: &str| {
            (key == "AGENT_RELAY_AUTO_ACTIVATE_EXCLUDED_DIRS")
                .then(|| "/builds:/scratch".to_string())
        };
        let config = LocalConfig::from_env(&env, Path::new("/Users/me"));
        assert_eq!(
            config.auto_activate_excluded_dirs,
            [PathBuf::from("/builds"), PathBuf::from("/scratch")]
        );
        assert!(is_under(
            Path::new("/builds/team/project"),
            &config.auto_activate_excluded_dirs
        ));
        assert!(!is_under(
            Path::new("/tmp/project"),
            &config.auto_activate_excluded_dirs
        ));
    }

    // Review: while Codex holds its database, its threads stay listed.
    #[test]
    fn codex_threads_survive_an_unreadable_database() {
        let world = world();
        let codex_home = world.sessions.config.codex.home.clone();
        std::fs::create_dir_all(&codex_home).unwrap();
        let db = rusqlite::Connection::open(codex_home.join("state_5.sqlite")).unwrap();
        db.execute_batch(&format!(
            "create table threads (id text, title text, cwd text, archived integer, source text, updated_at integer);
             insert into threads values ('{THREAD}', 'Fix tests', '/p', 0, 'cli', 1790000000);"
        ))
        .unwrap();
        drop(db);
        let listed = |world: &World| {
            world
                .sessions
                .sessions()
                .into_iter()
                .filter(|s| s.target.kind == SessionKind::Codex)
                .count()
        };
        assert_eq!(listed(&world), 1);
        std::fs::write(codex_home.join("state_5.sqlite"), b"not a database").unwrap();
        assert_eq!(listed(&world), 1, "the last list stands");
    }

    // Review: the mailbox never runs `claude --cloud` with an untagged id.
    #[test]
    fn the_mailbox_refuses_an_untagged_claude_id() {
        use crate::relay::outbox::effects::{ClaudeBridgeError, ClaudeDeliveryEffects};
        let world = world();
        let effects = ClaudeMailboxEffects::new(ClaudeConfig {
            executable: Some(PathBuf::from("/nonexistent/claude-for-tests")),
            ..world.sessions.config.claude.clone()
        });
        assert!(matches!(
            effects.send("make a new session about this", "hi"),
            Err(ClaudeBridgeError::Refused(_))
        ));
    }

    // Review: a Codex thread has one spelling, whatever the database holds.
    #[test]
    fn codex_thread_ids_are_lowercase_in_targets() {
        let world = world();
        let codex_home = world.sessions.config.codex.home.clone();
        std::fs::create_dir_all(&codex_home).unwrap();
        let db = rusqlite::Connection::open(codex_home.join("state_5.sqlite")).unwrap();
        db.execute_batch(&format!(
            "create table threads (id text, title text, cwd text, archived integer, source text, updated_at integer);
             insert into threads values ('{}', 'Fix tests', '/p', 0, 'cli', 1790000000);",
            THREAD.to_uppercase()
        ))
        .unwrap();
        drop(db);
        let codex: Vec<Target> = world
            .sessions
            .sessions()
            .into_iter()
            .map(|s| s.target)
            .filter(|t| t.kind == SessionKind::Codex)
            .collect();
        assert_eq!(codex, vec![Target::new(SessionKind::Codex, THREAD)]);
    }

    /// `world()` with the already-open Grok route on, as
    /// `AGENT_RELAY_ENABLE_EXISTING_GROK=1` sets it.
    fn grok_world() -> World {
        let mut world = world();
        let relay = world._temp.path().join("relay");
        world.sessions.config.existing_grok = Some(enablement::Paths {
            bindings: relay.join("grok-bindings"),
            journal: relay.join("grok-journal"),
        });
        world
    }

    fn existing_grok_paths(world: &World) -> enablement::Paths {
        world
            .sessions
            .config
            .existing_grok
            .clone()
            .expect("route on in tests")
    }

    fn grok_binding(session: &str) -> crate::relay::existing_session::Binding {
        use crate::relay::existing_session::{grok, Binding, Provider, Transport};
        let mut binding = Binding {
            provider: Provider::Grok,
            transport: Transport::Acp,
            workspace_id: "workspace-1".into(),
            session_id: session.into(),
            endpoint_id: String::new(),
            owner_id: "owner-1".into(),
            credential_reference: String::new(),
            owner_uid: UID,
            auth_id: String::new(),
            protocol_id: String::new(),
            cwd: PathBuf::from("/tmp/grok-enable/workdir"),
            model_id: "grok-4.7".into(),
            agent_version: "1.0.46".into(),
            executable: PathBuf::from("/tmp/grok-enable/grok"),
            leader_pid: 4242,
            leader_start: 100,
            socket_path: PathBuf::from("/tmp/grok-enable/leader.sock"),
            socket_device: 1,
            socket_inode: 7,
        };
        binding.credential_reference = grok::existing_reference(&binding);
        binding
    }

    /// An already-open Grok leader the kernel checks can prove: this test
    /// process holds a real listening socket and is listed as the leader.
    fn open_grok_leader(
        world: &World,
        session: &str,
    ) -> (
        std::os::unix::net::UnixListener,
        crate::relay::existing_session::Binding,
    ) {
        open_grok_leader_running(world, session, std::env::current_exe().unwrap())
    }

    fn open_grok_leader_running(
        world: &World,
        session: &str,
        executable: PathBuf,
    ) -> (
        std::os::unix::net::UnixListener,
        crate::relay::existing_session::Binding,
    ) {
        use std::os::unix::fs::MetadataExt;
        let root = world._temp.path().join("open-grok");
        std::fs::create_dir_all(&root).unwrap();
        let socket_path = root.join("leader.sock");
        let listener = std::os::unix::net::UnixListener::bind(&socket_path).unwrap();
        let socket = std::fs::symlink_metadata(&socket_path).unwrap();
        let pid = std::process::id() as i32;
        world.table.insert(
            pid,
            FakeProcess {
                parent: 1,
                uid: crate::relay::peer::current_uid(),
                start: 900,
                executable: Some(executable.clone()),
                arguments: vec![
                    "grok".into(),
                    "agent".into(),
                    "leader".into(),
                    "--leader-socket".into(),
                    socket_path.to_string_lossy().into_owned(),
                ],
                ..FakeProcess::default()
            },
        );
        let mut binding = grok_binding(session);
        binding.owner_uid = crate::relay::peer::current_uid();
        binding.cwd = root;
        binding.executable = executable;
        binding.leader_pid = pid;
        binding.leader_start = 900;
        binding.socket_device = socket.dev();
        binding.socket_inode = socket.ino();
        binding.socket_path = socket_path;
        binding.credential_reference =
            crate::relay::existing_session::grok::existing_reference(&binding);
        (listener, binding)
    }

    /// A `grok-open` agent pinned to the binding whose reference is `pinned`.
    fn grok_registration(session: &str, pinned: &str) -> crate::relay::store::Registration {
        serde_json::from_value(serde_json::json!({
            "name": "grok-agent",
            "agentID": "agent-grok",
            "target": {"kind": "grok-open", "id": session},
            "baseURL": "https://cast.agentrelay.com",
            "registeredAt": "2026-10-05T00:00:00Z",
            "routeBinding": pinned
        }))
        .unwrap()
    }

    #[test]
    fn the_already_open_grok_route_is_on_unless_its_own_flag_is_zero() {
        let app = Path::new("/Users/me/Library/Application Support/Agent Relay");
        // `from_env` leaves the route to `plugins_with`, which has the app
        // data directory.
        assert_eq!(
            LocalConfig::from_env(&|_| None, Path::new("/Users/me")).existing_grok,
            None
        );
        // Only an exact `0` turns the route off; the managed route's flag
        // does not touch it.
        let off = |key: &str| (key == enablement::ENABLE).then(|| "0".into());
        assert_eq!(enablement::Paths::from_env(&off, app), None);
        let managed_off =
            |key: &str| (key == "AGENT_RELAY_ENABLE_MANAGED_GROK").then(|| "0".into());
        assert!(enablement::Paths::from_env(&managed_off, app).is_some());
        let truthy = |key: &str| (key == enablement::ENABLE).then(|| "true".into());
        assert!(enablement::Paths::from_env(&truthy, app).is_some());
        let on = |key: &str| (key == enablement::ENABLE).then(|| "1".into());
        assert_eq!(
            enablement::Paths::from_env(&|_| None, app),
            enablement::Paths::from_env(&on, app)
        );
        // Never under the agent-relay CLI's own home, which is read-only here.
        assert_eq!(
            enablement::Paths::from_env(&on, app),
            Some(enablement::Paths {
                bindings: app.join("existing-grok-sessions/bindings"),
                journal: app.join("existing-grok-sessions/journal"),
            })
        );
    }

    #[test]
    fn bound_grok_discovery_rereads_native_titles_from_the_leaders_home() {
        use crate::relay::existing_session::grok::ExistingLeaderAuthority;
        let mut world = grok_world();
        world.sessions.config.uid = crate::relay::peer::current_uid();
        let id = "01a0fe0c-8b26-7ec2-ad2f-bab882c091f4";
        let (_listener, binding) = open_grok_leader(&world, id);
        let native = crate::relay::grok::GrokConfig {
            home: world._temp.path().join("custom-grok-home"),
        };
        world.table.processes.lock().unwrap().get_mut(&binding.leader_pid).unwrap()
            .environment.insert("GROK_HOME".into(), native.home.display().to_string());
        let registry = enablement::Registry::open(&existing_grok_paths(&world).bindings).unwrap();
        registry.register(&binding, &ExistingLeaderAuthority::new(world.table.clone())).unwrap();
        let dir = native.session_dir(binding.cwd.to_str().unwrap(), id);
        std::fs::create_dir_all(&dir).unwrap();
        // Relay's default store must not supply a different session's title.
        let wrong = world.sessions.config.grok.session_dir(binding.cwd.to_str().unwrap(), id);
        std::fs::create_dir_all(&wrong).unwrap();
        std::fs::write(wrong.join("summary.json"), r#"{"generated_title":"Wrong home"}"#).unwrap();
        for title in ["Renamed in Relay".to_string(), "x".repeat(200), "Changed in Grok".into()] {
            std::fs::write(dir.join("summary.json"), serde_json::json!({
                "info":{"id":id,"cwd":binding.cwd}, "generated_title":title,
            }).to_string()).unwrap();
            let found = world.sessions.sessions().into_iter().find(|row| row.target.id == id).unwrap();
            assert_eq!(found.title, title);
        }
        std::fs::remove_file(dir.join("summary.json")).unwrap();
        let found = world.sessions.sessions().into_iter().find(|row| row.target.id == id).unwrap();
        assert_eq!(found.title, format!("Grok {}", binding.model_id));
        world.table.processes.lock().unwrap().get_mut(&binding.leader_pid).unwrap().start += 1;
        assert!(crate::relay::grok::binding_title(&binding, &*world.table).is_none());
    }

    #[test]
    fn an_unproved_grok_binding_is_hidden_and_kept_while_its_leader_may_live() {
        use crate::relay::existing_session::grok::Authority;
        use crate::relay::existing_session::Binding;
        struct Yes;
        impl Authority for Yes {
            fn verify(&self, _: &Binding) -> bool {
                true
            }
        }
        let world = grok_world();
        let registry = enablement::Registry::open(&existing_grok_paths(&world).bindings).unwrap();
        let session = "01a0fe0c-8b26-7ec2-ad2f-bab882c091f4";
        registry.register(&grok_binding(session), &Yes).unwrap();
        let listed = world
            .sessions
            .sessions()
            .into_iter()
            .any(|found| found.target.kind == SessionKind::GrokOpen);
        assert!(!listed);
        // Its leader is not proven gone, so the binding is kept, not deleted.
        assert!(registry.proved_binding(session, &Yes).unwrap().is_some());
    }

    // A session whose own leader stopped keeps its stored binding, which no
    // longer proves. Another leader of this user makes its row live, but
    // delivery rebinds only once the old leader is proven dead; until then it
    // waits, so the session is not activated. Once that leader is proven dead
    // (as after Grok restarts it), delivery rebinds and it is activated again.
    #[test]
    fn a_grok_session_whose_bound_leader_stopped_is_auto_activated_only_once_it_can_rebind() {
        use crate::relay::existing_session::grok::Authority;
        use crate::relay::existing_session::Binding;
        use crate::relay::process::FakeProcess;
        struct Yes;
        impl Authority for Yes {
            fn verify(&self, _: &Binding) -> bool {
                true
            }
        }
        let world = grok_world();
        let session = "01a1136e-00f9-7d10-ba21-5579ce7a4d08";
        let registry = enablement::Registry::open(&existing_grok_paths(&world).bindings).unwrap();
        // Bound to leader 4242, which is not running, so the binding no
        // longer proves.
        registry.register(&grok_binding(session), &Yes).unwrap();
        let grok_home = &world.sessions.config.grok.home;
        std::fs::create_dir_all(grok_home).unwrap();
        std::fs::write(
            grok_home.join("active_sessions.json"),
            serde_json::json!([{"session_id": session, "pid": 400, "cwd": "/Users/me/api"}])
                .to_string(),
        )
        .unwrap();
        world.table.insert(
            400,
            FakeProcess {
                uid: UID,
                start: 400,
                executable: Some("/Users/me/.grok/bin/grok".into()),
                ..FakeProcess::default()
            },
        );
        // An unrelated leader of this user runs.
        world.table.insert(
            500,
            FakeProcess {
                uid: UID,
                start: 500,
                arguments: ["grok", "agent", "leader", "--no-exit-on-disconnect"]
                    .iter()
                    .map(ToString::to_string)
                    .collect(),
                environment: [("HOME".to_string(), "/Users/me".to_string())]
                    .into_iter()
                    .collect(),
                ..FakeProcess::default()
            },
        );
        let row = world
            .sessions
            .sessions()
            .into_iter()
            .find(|found| found.target.kind == SessionKind::GrokOpen && found.target.id == session)
            .expect("listed from Grok's registry");
        assert!(row.live, "another leader makes the row live");
        let activated = world
            .sessions
            .auto_activation_sessions()
            .into_iter()
            .any(|found| found.target.kind == SessionKind::GrokOpen);
        assert!(
            !activated,
            "its leader is not proven dead, so delivery cannot rebind"
        );
        // Grok restarted its leader: pid 4242 now runs another process, so the
        // bound leader is proven dead and delivery rebinds to the running one.
        world.table.insert(
            4242,
            FakeProcess {
                uid: UID,
                start: 999,
                ..FakeProcess::default()
            },
        );
        let activated = world
            .sessions
            .auto_activation_sessions()
            .into_iter()
            .any(|found| found.target.kind == SessionKind::GrokOpen);
        assert!(activated, "its leader is proven dead, so delivery rebinds");
    }

    // An open Grok TUI is auto-activated only while a leader of this user
    // runs, the one route into it; with no leader it is listed but left off.
    #[test]
    fn an_open_grok_session_is_auto_activated_only_while_its_leader_runs() {
        use crate::relay::process::FakeProcess;
        let world = grok_world();
        let grok_home = &world.sessions.config.grok.home;
        std::fs::create_dir_all(grok_home).unwrap();
        let session = "01a1136e-00f9-7d10-ba21-5579ce7a4d08";
        std::fs::write(
            grok_home.join("active_sessions.json"),
            serde_json::json!([{"session_id": session, "pid": 400, "cwd": "/Users/me/api"}])
                .to_string(),
        )
        .unwrap();
        world.table.insert(
            400,
            FakeProcess {
                uid: UID,
                start: 400,
                executable: Some("/Users/me/.grok/bin/grok".into()),
                ..FakeProcess::default()
            },
        );
        let grok_rows = |world: &World| {
            world
                .sessions
                .auto_activation_sessions()
                .into_iter()
                .filter(|found| found.target.kind == SessionKind::GrokOpen)
                .count()
        };
        assert_eq!(
            grok_rows(&world),
            0,
            "no leader runs, so nothing can reach it"
        );
        world.table.insert(
            500,
            FakeProcess {
                uid: UID,
                start: 500,
                arguments: ["grok", "agent", "leader", "--no-exit-on-disconnect"]
                    .iter()
                    .map(ToString::to_string)
                    .collect(),
                environment: [("HOME".to_string(), "/Users/me".to_string())]
                    .into_iter()
                    .collect(),
                ..FakeProcess::default()
            },
        );
        assert_eq!(grok_rows(&world), 1, "its leader runs, so it is activated");
    }

    #[test]
    fn open_grok_tui_sessions_are_listed_from_groks_registry_and_live_only_with_a_leader() {
        use crate::relay::process::FakeProcess;
        let world = grok_world();
        let grok_home = &world.sessions.config.grok.home;
        std::fs::create_dir_all(grok_home).unwrap();
        let session = "01a1136e-00f9-7d10-ba21-5579ce7a4d08";
        let other = "01a1136e-3958-7fe2-ab01-1db35ad55f8f";
        std::fs::write(
            grok_home.join("active_sessions.json"),
            serde_json::json!([
                {"session_id": session, "pid": 400, "cwd": "/Users/me/api"},
                {"session_id": other, "pid": 401, "cwd": "/Users/me/gone"},
            ])
            .to_string(),
        )
        .unwrap();
        world.table.insert(
            400,
            FakeProcess {
                uid: UID,
                start: 400,
                executable: Some("/Users/me/.grok/bin/grok".into()),
                ..FakeProcess::default()
            },
        );
        let rows = |world: &World| -> Vec<DiscoveredSession> {
            world
                .sessions
                .sessions()
                .into_iter()
                .filter(|found| found.target.kind == SessionKind::GrokOpen)
                .collect()
        };
        // No leader runs: the TUI is listed, as unreachable.
        let listed = rows(&world);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].target.id, session);
        assert_eq!(listed[0].title, "api");
        assert_eq!(listed[0].directory.as_deref(), Some("/Users/me/api"));
        assert!(!listed[0].live);
        // The leader Grok spawns for a `--leader` TUI names no socket; it
        // still counts as this user's open leader.
        world.table.insert(
            500,
            FakeProcess {
                uid: UID,
                start: 500,
                arguments: ["grok", "agent", "leader", "--no-exit-on-disconnect"]
                    .iter()
                    .map(ToString::to_string)
                    .collect(),
                environment: [("HOME".to_string(), "/Users/me".to_string())]
                    .into_iter()
                    .collect(),
                ..FakeProcess::default()
            },
        );
        assert!(rows(&world)[0].live);
        // A probe-launched leader carries the marker and is not an open one.
        world
            .table
            .processes
            .lock()
            .unwrap()
            .get_mut(&500)
            .unwrap()
            .environment
            .insert(
                "AGENT_RELAY_MANAGED_SESSION_MARKER".to_string(),
                "x".to_string(),
            );
        assert!(!rows(&world)[0].live);
        // With the route off, Grok's registry is not read at all.
        let mut off = World {
            sessions: LocalSessions::new(world.sessions.config.clone(), world.table.clone()),
            table: world.table.clone(),
            _temp: world._temp,
        };
        off.sessions.config.existing_grok = None;
        assert!(rows(&off).is_empty());
    }

    #[test]
    fn a_pinned_grok_agent_waits_for_a_replaced_leader_while_grok_still_runs_the_session() {
        use crate::relay::existing_session::grok::Authority;
        use crate::relay::existing_session::Binding;
        use crate::relay::process::FakeProcess;
        struct Yes;
        impl Authority for Yes {
            fn verify(&self, _: &Binding) -> bool {
                true
            }
        }
        let world = grok_world();
        let session = "01a0fe0c-8b26-7ec2-ad2f-bab882c091f4";
        let binding = grok_binding(session);
        // The leader the binding names was replaced: same pid, new start.
        world.table.insert(
            binding.leader_pid,
            FakeProcess {
                uid: UID,
                start: binding.leader_start + 1,
                ..FakeProcess::default()
            },
        );
        let registry = enablement::Registry::open(&existing_grok_paths(&world).bindings).unwrap();
        registry.register(&binding, &Yes).unwrap();
        let grok_home = &world.sessions.config.grok.home;
        std::fs::create_dir_all(grok_home).unwrap();
        let tui = 777;
        world.table.insert(
            tui,
            FakeProcess {
                uid: UID,
                start: 7,
                executable: Some("/Users/me/.grok/bin/grok-1.0.46".into()),
                ..FakeProcess::default()
            },
        );
        let listing = |open: bool| {
            let records = if open {
                serde_json::json!([{"session_id": session, "pid": tui, "cwd": binding.cwd}])
            } else {
                serde_json::json!([])
            };
            std::fs::write(grok_home.join("active_sessions.json"), records.to_string()).unwrap();
        };
        let injector = LocalInjector::new(
            world.sessions.config.clone(),
            world.table.clone(),
            CodexRouter::new(Arc::new(UnusedCodexRoutes)),
            ServingPath::default(),
        )
        .with_grok_inspect(Arc::new(|_, _| Ok(("grok-4.7".into(), "1.0.46".into()))));
        let target = Target::new(SessionKind::GrokOpen, session);
        let pinned = grok_registration(&target.id, &binding.credential_reference);
        // No new leader yet (and, under the test uid, none that could be
        // proven): the message waits rather than failing for good.
        listing(true);
        assert!(matches!(
            injector.inject_registered(&pinned, "d-1", "m-1", "relay message do-not-log"),
            InjectOutcome::Waiting(_)
        ));
        // Grok no longer runs the session: nothing will rebind it.
        listing(false);
        assert!(matches!(
            injector.inject_registered(&pinned, "d-1", "m-1", "relay message do-not-log"),
            InjectOutcome::Refused(_)
        ));
        // Without a registration there is no pin to follow.
        listing(true);
        assert!(matches!(
            injector.inject(&target, "m-1", "relay message do-not-log"),
            InjectOutcome::Refused(_)
        ));
        // The stored binding was kept for the rebinding, not replaced.
        assert_eq!(registry.stored(session).unwrap(), Some(binding));
    }

    #[test]
    fn the_daemon_refuses_an_unregistered_grok_session() {
        let world = grok_world();
        let routes = Arc::new(SystemCodexRoutes::new(
            world.sessions.config.codex.clone(),
            world.table.clone(),
            UID,
        ));
        let injector = LocalInjector::new(
            world.sessions.config.clone(),
            world.table.clone(),
            CodexRouter::new(routes),
            ServingPath::default(),
        );
        let target = Target::new(SessionKind::Grok, "01a0fe0c-8b26-7ec2-ad2f-bab882c091f4");
        assert_eq!(
            injector.inject(&target, "m-1", "relay message do-not-log"),
            InjectOutcome::Refused("No verified Grok route for this session.".into())
        );
        // With the route off, main's refusal stands.
        let mut off = world.sessions.config.clone();
        off.existing_grok = None;
        let injector = LocalInjector::new(
            off,
            world.table.clone(),
            CodexRouter::new(Arc::new(UnusedCodexRoutes)),
            ServingPath::default(),
        );
        assert_eq!(
            injector.inject(&target, "m-1", "relay message do-not-log"),
            InjectOutcome::Refused("No verified probe-managed route for this session.".into())
        );
        let open = grok_registration(&target.id, "existing:grok:unbound");
        assert_eq!(
            injector.inject_registered(&open, "d-1", "m-1", "relay message do-not-log"),
            InjectOutcome::Refused("No verified Grok route for this session.".into())
        );
    }

    #[test]
    fn an_unreadable_open_registry_hides_managed_grok_rows_like_delivery_refuses_them() {
        use std::os::unix::fs::PermissionsExt;
        let world = grok_world();
        let session = "01a0fe0c-8b26-7ec2-ad2f-bab882c091f4";
        let target = Target::new(SessionKind::Grok, session);
        let mut launched = grok_binding(session);
        launched.owner_uid = crate::relay::peer::current_uid();
        launched.credential_reference = format!("probe:grok:{}", "a".repeat(64));
        let manager = managed_grok(&world, &launched);
        let sessions = LocalSessions::new(world.sessions.config.clone(), world.table.clone())
            .with_managed(manager.clone());
        assert!(sessions.sessions().iter().any(|row| row.target == target));

        let bindings = existing_grok_paths(&world).bindings;
        std::fs::create_dir_all(&bindings).unwrap();
        std::fs::set_permissions(&bindings, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(!sessions.sessions().iter().any(|row| row.target == target));
        let injector = LocalInjector::new(
            world.sessions.config.clone(),
            world.table.clone(),
            CodexRouter::new(Arc::new(UnusedCodexRoutes)),
            ServingPath::default(),
        )
        .with_managed(manager.clone());
        assert_eq!(
            injector.inject(&target, "m-1", "relay message"),
            InjectOutcome::Retry("A Grok binding store is unavailable.".into())
        );
        // Discovery and registered delivery agree: hidden, and retried.
        let managed_agent: crate::relay::store::Registration =
            serde_json::from_value(serde_json::json!({
                "name": "grok-managed",
                "agentID": "agent-managed",
                "target": {"kind": "grok", "id": session},
                "baseURL": "https://cast.agentrelay.com",
                "registeredAt": "2026-10-05T00:00:00Z"
            }))
            .unwrap();
        assert_eq!(
            injector.inject_registered(&managed_agent, "d-1", "m-1", "relay message"),
            InjectOutcome::Retry("A Grok binding store is unavailable.".into())
        );
        assert!(std::fs::read_dir(manager.journal("grok"))
            .map_or(true, |mut entries| entries.next().is_none()));
        // Other providers stay listed.
        assert!(sessions
            .sessions()
            .iter()
            .any(|row| row.target.kind == SessionKind::ClaudeTerminal));
        // With the route off, main's managed listing is untouched.
        let mut off = world.sessions.config.clone();
        off.existing_grok = None;
        assert!(LocalSessions::new(off, world.table.clone())
            .with_managed(manager)
            .sessions()
            .iter()
            .any(|row| row.target == target));
        std::fs::set_permissions(&bindings, std::fs::Permissions::from_mode(0o700)).unwrap();
    }

    #[test]
    fn one_unreadable_binding_hides_only_its_own_session_and_listing_matches_delivery() {
        use std::os::unix::fs::PermissionsExt;
        let world = grok_world();
        // A managed session, healthy.
        let managed_session = "01a0fe0c-8b26-7ec2-ad2f-bab882c091f4";
        let mut launched = grok_binding(managed_session);
        launched.owner_uid = crate::relay::peer::current_uid();
        launched.credential_reference = format!("probe:grok:{}", "a".repeat(64));
        let manager = managed_grok(&world, &launched);
        // An already-open session, healthy.
        let open_session = "01a0fe0c-8b26-7ec2-ad2f-bab882c091f5";
        let (_listener, open) = open_grok_leader(&world, open_session);
        let registry = enablement::Registry::open(&existing_grok_paths(&world).bindings).unwrap();
        registry
            .register(&open, &ExistingLeaderAuthority::new(world.table.clone()))
            .unwrap();
        // A third session whose binding file is no longer private.
        let broken = "01a0fe0c-8b26-7ec2-ad2f-bab882c091f6";
        let mut other = open.clone();
        other.session_id = broken.into();
        other.credential_reference =
            crate::relay::existing_session::grok::existing_reference(&other);
        registry
            .register(&other, &ExistingLeaderAuthority::new(world.table.clone()))
            .unwrap();
        std::fs::set_permissions(
            registry.path_for(broken),
            std::fs::Permissions::from_mode(0o644),
        )
        .unwrap();

        let sessions = LocalSessions::new(world.sessions.config.clone(), world.table.clone())
            .with_managed(manager.clone());
        let listed: HashSet<Target> = sessions
            .sessions()
            .into_iter()
            .map(|row| row.target)
            .collect();
        let managed_target = Target::new(SessionKind::Grok, managed_session);
        let open_target = Target::new(SessionKind::GrokOpen, open_session);
        let broken_target = Target::new(SessionKind::GrokOpen, broken);
        assert!(listed.contains(&managed_target));
        assert!(listed.contains(&open_target));
        assert!(!listed.contains(&broken_target));
        // Delivery agrees row by row.
        assert!(matches!(
            grok_route(
                &sessions.config,
                &sessions.table,
                Some(&manager),
                &managed_target
            ),
            GrokRoute::Managed(_)
        ));
        assert!(matches!(
            grok_route(
                &sessions.config,
                &sessions.table,
                Some(&manager),
                &open_target
            ),
            GrokRoute::Existing(_)
        ));
        assert!(matches!(
            grok_route(
                &sessions.config,
                &sessions.table,
                Some(&manager),
                &broken_target
            ),
            GrokRoute::Unavailable
        ));
    }

    #[test]
    fn a_registration_never_switches_grok_routes_after_its_binding_is_lost() {
        let world = grok_world();
        let session = "01a0fe0c-8b26-7ec2-ad2f-bab882c091f4";
        let (_listener, open) = open_grok_leader(&world, session);
        let registry = enablement::Registry::open(&existing_grok_paths(&world).bindings).unwrap();
        registry
            .register(&open, &ExistingLeaderAuthority::new(world.table.clone()))
            .unwrap();
        let open_agent = grok_registration(session, &open.credential_reference);
        assert_eq!(open_agent.target.kind, SessionKind::GrokOpen);

        // The already-open leader dies, and its binding is deleted.
        let pid = std::process::id() as i32;
        let leader = world
            .table
            .processes
            .lock()
            .unwrap()
            .get(&pid)
            .cloned()
            .unwrap();
        world.table.insert(
            pid,
            FakeProcess {
                start: leader.start + 1,
                ..leader
            },
        );
        assert!(world
            .sessions
            .sessions()
            .iter()
            .all(|row| row.target.id != session));

        // A managed launch of the same session id then succeeds.
        let mut launched = grok_binding(session);
        launched.owner_uid = crate::relay::peer::current_uid();
        launched.credential_reference = format!("probe:grok:{}", "a".repeat(64));
        let manager = managed_grok(&world, &launched);
        let managed_target = Target::new(SessionKind::Grok, session);
        assert!(manager.binding(&managed_target).is_some());
        let injector = LocalInjector::new(
            world.sessions.config.clone(),
            world.table.clone(),
            CodexRouter::new(Arc::new(UnusedCodexRoutes)),
            ServingPath::default(),
        )
        .with_managed(manager.clone());

        // The already-open registration is refused; it is never carried by
        // the managed leader, and nothing reaches the managed journal.
        assert_eq!(
            injector.inject_registered(&open_agent, "d-1", "m-1", "relay message"),
            InjectOutcome::Refused("No verified Grok route for this session.".into())
        );
        assert!(std::fs::read_dir(manager.journal("grok"))
            .map_or(true, |mut entries| entries.next().is_none()));
        let sessions = LocalSessions::new(world.sessions.config.clone(), world.table.clone())
            .with_managed(manager.clone());
        assert_eq!(
            sessions.managed_authority(&open_agent.target),
            None,
            "the old registration has no authority to re-register"
        );

        // The reverse: a managed registration is never carried by an
        // already-open binding of its session.
        let other = "01a0fe0c-8b26-7ec2-ad2f-bab882c091f5";
        let w = grok_world();
        let (_listener, open) = open_grok_leader(&w, other);
        enablement::Registry::open(&existing_grok_paths(&w).bindings)
            .unwrap()
            .register(&open, &ExistingLeaderAuthority::new(w.table.clone()))
            .unwrap();
        let managed_agent: crate::relay::store::Registration =
            serde_json::from_value(serde_json::json!({
                "name": "grok-managed",
                "agentID": "agent-managed",
                "target": {"kind": "grok", "id": other},
                "baseURL": "https://cast.agentrelay.com",
                "registeredAt": "2026-10-05T00:00:00Z"
            }))
            .unwrap();
        let injector = LocalInjector::new(
            w.sessions.config.clone(),
            w.table.clone(),
            CodexRouter::new(Arc::new(UnusedCodexRoutes)),
            ServingPath::default(),
        );
        assert_eq!(
            injector.inject_registered(&managed_agent, "d-1", "m-1", "relay message"),
            InjectOutcome::Refused(
                "Both Grok routes claim this session; neither binding is used.".into()
            )
        );
        assert!(std::fs::read_dir(existing_grok_paths(&w).journal)
            .map_or(true, |mut entries| entries.next().is_none()));
    }

    #[test]
    fn a_proved_already_open_grok_session_is_listed_registrable_and_named_by_its_tools() {
        let world = grok_world();
        let session = "01a0fe0c-8b26-7ec2-ad2f-bab882c091f4";
        let (_listener, binding) = open_grok_leader(&world, session);
        let registry = enablement::Registry::open(&existing_grok_paths(&world).bindings).unwrap();
        let authority = ExistingLeaderAuthority::new(world.table.clone());
        registry.register(&binding, &authority).unwrap();

        let target = Target::new(SessionKind::GrokOpen, session);
        let rows: Vec<_> = world
            .sessions
            .sessions()
            .into_iter()
            .filter(|found| found.target == target)
            .collect();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].title, "Grok grok-4.7");
        // Bound, but Grok's registry does not list the TUI: not live.
        assert!(!rows[0].live);
        assert_eq!(
            world.sessions.managed_authority(&target),
            Some(ManagedAuthority {
                workspace_id: "workspace-1".into(),
                owner_id: "owner-1".into(),
                owner_uid: crate::relay::peer::current_uid(),
            })
        );
        // A tool under the leader is nobody on the relay-send socket: the
        // leader may hold other sessions. Callers are matched against the
        // configured uid, which production sets to the current one.
        let mut config = world.sessions.config.clone();
        config.uid = crate::relay::peer::current_uid();
        let mine = LocalSessions::new(config, world.table.clone());
        let tool = std::process::id() as i32 + 100_000;
        world.table.insert(
            tool,
            FakeProcess {
                parent: std::process::id() as i32,
                uid: crate::relay::peer::current_uid(),
                start: 901,
                ..FakeProcess::default()
            },
        );
        assert_eq!(mine.caller(tool).ok(), None);

        // With `GROK_SESSION_ID`, as Grok sets it for every tool process,
        // the tool names its session, once Grok's registry lists it for a
        // process of this user's.
        world
            .table
            .processes
            .lock()
            .unwrap()
            .get_mut(&tool)
            .unwrap()
            .environment
            .insert("GROK_SESSION_ID".to_string(), session.to_uppercase());
        assert!(matches!(mine.caller(tool), Err(CallerMiss::NotASession)));
        let grok_home = &mine.config.grok.home;
        std::fs::create_dir_all(grok_home).unwrap();
        let tui = tool + 1;
        world.table.insert(
            tui,
            FakeProcess {
                uid: crate::relay::peer::current_uid(),
                start: 902,
                executable: Some("/Users/me/.grok/bin/grok".into()),
                ..FakeProcess::default()
            },
        );
        std::fs::write(
            grok_home.join("active_sessions.json"),
            serde_json::json!([{"session_id": session, "pid": tui, "cwd": binding.cwd}])
                .to_string(),
        )
        .unwrap();
        let caller = mine.caller(tool).unwrap();
        assert_eq!(caller.target, target);
        assert!(caller.live);
        assert_eq!(
            caller.directory.as_deref(),
            Some(binding.cwd.to_str().unwrap())
        );
        // A tool of this user's that is not under a Grok leader is still
        // nobody, whatever its environment claims.
        let stray = tool + 2;
        world.table.insert(
            stray,
            FakeProcess {
                parent: 1,
                uid: crate::relay::peer::current_uid(),
                start: 903,
                environment: [("GROK_SESSION_ID".to_string(), session.to_string())]
                    .into_iter()
                    .collect(),
                ..FakeProcess::default()
            },
        );
        assert!(matches!(mine.caller(stray), Err(CallerMiss::NotASession)));

        // With the route off, the same stored binding is invisible.
        let mut off = mine.config.clone();
        off.existing_grok = None;
        let sessions = LocalSessions::new(off, world.table.clone());
        assert!(!sessions
            .sessions()
            .iter()
            .any(|found| found.target == target));
        assert_eq!(sessions.managed_authority(&target), None);
        assert_ne!(
            sessions.caller(tool).ok().map(|found| found.target),
            Some(target)
        );
    }

    #[test]
    fn a_grok_session_claimed_by_both_routes_is_hidden_and_refused() {
        let world = grok_world();
        let session = "01a0fe0c-8b26-7ec2-ad2f-bab882c091f4";
        let target = Target::new(SessionKind::Grok, session);
        let (_listener, open) = open_grok_leader(&world, session);
        let registry = enablement::Registry::open(&existing_grok_paths(&world).bindings).unwrap();
        registry
            .register(&open, &ExistingLeaderAuthority::new(world.table.clone()))
            .unwrap();

        let mut launched = grok_binding(session);
        launched.owner_uid = crate::relay::peer::current_uid();
        launched.workspace_id = "workspace-managed".into();
        launched.credential_reference = format!("probe:grok:{}", "a".repeat(64));
        let managed_binding = ManagedBinding::Grok(launched.clone());
        let manager = Arc::new(ManagedSessions::new(
            world._temp.path().join("managed"),
            HashSet::from([SessionKind::Grok]),
            Arc::new(FixedManagedRuntime(managed_binding.clone())),
        ));
        manager
            .launch(ManagedLaunch {
                kind: SessionKind::Grok,
                executable: launched.executable.clone(),
                directory: launched.cwd.clone(),
                session_id: session.into(),
                authority: managed_binding.authority(),
            })
            .unwrap();

        let both = LocalSessions::new(world.sessions.config.clone(), world.table.clone())
            .with_managed(manager.clone());
        assert!(!both.sessions().iter().any(|found| found.target == target));
        assert_eq!(both.managed_authority(&target), None);

        let injector = LocalInjector::new(
            world.sessions.config.clone(),
            world.table.clone(),
            CodexRouter::new(Arc::new(UnusedCodexRoutes)),
            ServingPath::default(),
        )
        .with_managed(manager.clone());
        let refused = InjectOutcome::Refused(
            "Both Grok routes claim this session; neither binding is used.".into(),
        );
        assert_eq!(injector.inject(&target, "m-1", "relay message"), refused);
        let open_target = Target::new(SessionKind::GrokOpen, session);
        assert!(!both
            .sessions()
            .iter()
            .any(|found| found.target == open_target));
        assert_eq!(both.managed_authority(&open_target), None);
        assert_eq!(
            injector.inject_registered(
                &grok_registration(session, &open.credential_reference),
                "d-1",
                "m-1",
                "relay message"
            ),
            refused
        );
        assert_eq!(
            injector.inject_registered(
                &grok_registration(session, &open.credential_reference),
                "d-1",
                "m-1",
                "relay message"
            ),
            refused
        );
        // Neither route wrote a pending receipt it could later send from.
        let journal = existing_grok_paths(&world).journal;
        assert!(std::fs::read_dir(&journal).map_or(true, |mut entries| entries.next().is_none()));
        assert!(std::fs::read_dir(manager.journal("grok"))
            .map_or(true, |mut entries| entries.next().is_none()));
        // Neither binding was rewritten to resolve the conflict.
        assert_eq!(
            registry
                .proved_binding(session, &ExistingLeaderAuthority::new(world.table.clone()))
                .unwrap(),
            Some(open)
        );
        assert_eq!(manager.binding(&target), Some(managed_binding.clone()));

        // With the already-open route off, the managed route is exactly
        // main's: listed under its own authority.
        let mut off = world.sessions.config.clone();
        off.existing_grok = None;
        let managed_only =
            LocalSessions::new(off, world.table.clone()).with_managed(manager.clone());
        let rows: Vec<_> = managed_only
            .sessions()
            .into_iter()
            .filter(|found| found.target == target)
            .collect();
        assert_eq!(rows.len(), 1);
        assert_eq!(
            managed_only.managed_authority(&target),
            Some(managed_binding.authority())
        );
    }

    /// A stand-in Grok CLI that speaks the ACP the transport and readback
    /// use: initialize, `session/load` of `session`, and one prompt. Each
    /// prompt it receives is appended to `prompts`.
    fn fake_acp_grok(world: &World, session: &str) -> (PathBuf, PathBuf) {
        use std::os::unix::fs::PermissionsExt;
        let directory = world._temp.path().join("fake-grok");
        std::fs::create_dir_all(&directory).unwrap();
        let prompts = directory.join("prompts");
        let executable = directory.join("grok");
        let script = format!(
            r#"#!/bin/sh
id() {{ printf '%s' "$1" | sed -E 's/.*"id":"([^"]+)".*/\1/'; }}
read -r initialize || exit 0
printf '{{"jsonrpc":"2.0","id":"%s","result":{{"protocolVersion":1,"_meta":{{"modelState":{{"currentModelId":"grok-4.7"}},"agentVersion":"1.0.46"}}}}}}\n' "$(id "$initialize")"
read -r load || exit 0
printf '{{"jsonrpc":"2.0","id":"%s","result":{{"sessionId":"{session}"}}}}\n' "$(id "$load")"
read -r prompt || exit 0
printf '%s\n' "$prompt" >> '{prompts}'
printf '{{"jsonrpc":"2.0","method":"session/update","params":{{"_meta":{{"promptId":"server-1"}},"update":{{"sessionUpdate":"agent_message_chunk"}}}}}}\n'
printf '{{"jsonrpc":"2.0","method":"_x.ai/session/prompt_complete","params":{{"promptId":"server-1","stopReason":"end_turn","modelId":"grok-4.7"}}}}\n'
printf '{{"jsonrpc":"2.0","id":"%s","result":{{"stopReason":"end_turn","outputTokens":1,"modelId":"grok-4.7","_meta":{{"promptId":"server-1"}}}}}}\n' "$(id "$prompt")"
"#,
            prompts = prompts.display(),
        );
        std::fs::write(&executable, script).unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        (executable, prompts)
    }

    fn open_leader_request(world: &World, session: &str) -> enablement::OpenLeaderRequest {
        enablement::OpenLeaderRequest {
            session_id: session.into(),
            directory: world._temp.path().join("open-grok"),
            workspace_id: "workspace-1".into(),
            owner_id: "owner-1".into(),
            owner_uid: crate::relay::peer::current_uid(),
        }
    }

    fn prompts_sent(prompts: &Path) -> usize {
        std::fs::read_to_string(prompts).map_or(0, |text| text.lines().count())
    }

    fn managed_grok(
        world: &World,
        binding: &crate::relay::existing_session::Binding,
    ) -> Arc<ManagedSessions> {
        let managed_binding = ManagedBinding::Grok(binding.clone());
        let manager = Arc::new(ManagedSessions::new(
            world._temp.path().join("managed"),
            HashSet::from([SessionKind::Grok]),
            Arc::new(FixedManagedRuntime(managed_binding.clone())),
        ));
        manager
            .launch(ManagedLaunch {
                kind: SessionKind::Grok,
                executable: binding.executable.clone(),
                directory: binding.cwd.clone(),
                session_id: binding.session_id.clone(),
                authority: managed_binding.authority(),
            })
            .unwrap();
        manager
    }

    /// A managed binding for `session` held by `open`'s own leader process.
    fn managed_on_leader(
        session: &str,
        open: &crate::relay::existing_session::Binding,
    ) -> crate::relay::existing_session::Binding {
        let mut launched = grok_binding(session);
        launched.owner_uid = crate::relay::peer::current_uid();
        launched.leader_pid = open.leader_pid;
        launched.leader_start = open.leader_start;
        launched.credential_reference = format!("probe:grok:{}", "a".repeat(64));
        launched
    }

    #[test]
    fn sessions_existing_register_proves_the_open_leader_and_delivers_once_end_to_end() {
        let world = grok_world();
        let session = "01a0fe0c-8b26-7ec2-ad2f-bab882c091f4";
        let target = Target::new(SessionKind::GrokOpen, session);
        let (executable, prompts) = fake_acp_grok(&world, session);
        let (_listener, _) = open_grok_leader_running(&world, session, executable);

        // The production producer, with the real ACP readback.
        let registered = world
            .sessions
            .register_existing(open_leader_request(&world, session))
            .unwrap();
        assert_eq!(registered.target, target);
        assert_eq!(registered.title, "Grok grok-4.7");
        assert_eq!(prompts_sent(&prompts), 0, "registration never prompts");
        assert!(world
            .sessions
            .sessions()
            .iter()
            .any(|row| row.target == target));
        // Registering again is the same immutable binding.
        assert!(world
            .sessions
            .register_existing(open_leader_request(&world, session))
            .is_ok());

        let injector = LocalInjector::new(
            world.sessions.config.clone(),
            world.table.clone(),
            CodexRouter::new(Arc::new(UnusedCodexRoutes)),
            ServingPath::default(),
        );
        // `agents.register` pins the agent to the live binding it found.
        let pinned = world.sessions.route_binding(&target).unwrap();
        assert!(pinned.starts_with("existing:grok:"));
        let registration = grok_registration(session, &pinned);
        // Without a registration, or with no pin, nothing is sent.
        assert_eq!(
            injector.inject(&target, "m-0", "hello"),
            InjectOutcome::Refused(
                "An already-open Grok session takes messages only for its registered agent.".into()
            )
        );
        let mut unpinned = registration.clone();
        unpinned.route_binding = None;
        assert_eq!(
            injector.inject_registered(&unpinned, "d-0", "m-0", "hello"),
            InjectOutcome::Refused(
                "This agent is not pinned to a Grok binding; turn this agent off, then add the session again.".into()
            )
        );
        let text =
            "[via Agent Relay — from @owner to @grok-agent · message m-1 · ref e2e00001]\n\nhello";
        assert_eq!(
            injector.inject_registered(&registration, "d-1", "m-1", text),
            InjectOutcome::Delivered
        );
        // The receipt is replayed without prompting Grok again.
        assert_eq!(
            injector.inject_registered(&registration, "d-1", "m-1", text),
            InjectOutcome::Delivered
        );
        assert_eq!(prompts_sent(&prompts), 1);
        assert!(std::fs::read_to_string(&prompts).unwrap().contains("hello"));

        // A leader that fails a check for now keeps its binding, hidden.
        let pid = std::process::id() as i32;
        let leader = world
            .table
            .processes
            .lock()
            .unwrap()
            .get(&pid)
            .cloned()
            .unwrap();
        world.table.remove(pid);
        assert!(!world
            .sessions
            .sessions()
            .iter()
            .any(|row| row.target == target));
        assert_eq!(
            injector.inject_registered(&registration, "d-2", "m-2", text),
            InjectOutcome::Refused("No verified Grok route for this session.".into())
        );
        world.table.insert(pid, leader.clone());
        assert!(world
            .sessions
            .sessions()
            .iter()
            .any(|row| row.target == target));

        // A replaced leader process is dead: nothing more is sent, and its
        // binding stays to pin the session's workspace and owner.
        world.table.insert(
            pid,
            FakeProcess {
                start: leader.start + 1,
                ..leader
            },
        );
        assert!(!world
            .sessions
            .sessions()
            .iter()
            .any(|row| row.target == target));
        let registry = enablement::Registry::open(&existing_grok_paths(&world).bindings).unwrap();
        assert_eq!(
            registry
                .proved_binding(session, &ExistingLeaderAuthority::new(world.table.clone()))
                .unwrap(),
            None
        );
        assert_eq!(
            injector.inject_registered(&registration, "d-3", "m-3", text),
            InjectOutcome::Refused("No verified Grok route for this session.".into())
        );
        assert_eq!(prompts_sent(&prompts), 1);

        // The leader now running there can rebind the session only under
        // the workspace and owner it had.
        let mut elsewhere = open_leader_request(&world, session);
        elsewhere.workspace_id = "workspace-2".into();
        assert!(world.sessions.register_existing(elsewhere).is_err());
        assert!(world
            .sessions
            .sessions()
            .iter()
            .all(|row| row.target != target));
        world
            .sessions
            .register_existing(open_leader_request(&world, session))
            .unwrap();
        assert!(world
            .sessions
            .sessions()
            .iter()
            .any(|row| row.target == target));

        // The old agent's pin names the dead leader's binding, which the
        // new binding replaced under the same workspace, owner and uid: the
        // agent follows its session to the new leader.
        let rebound = world.sessions.route_binding(&target).unwrap();
        assert_ne!(rebound, pinned);
        assert_eq!(
            injector.inject_registered(&registration, "d-4", "m-4", text),
            InjectOutcome::Delivered
        );
        assert_eq!(prompts_sent(&prompts), 2);
        // A pin from nowhere in the session's lineage is still refused.
        let stranger = grok_registration(session, "existing:grok:stranger");
        assert_eq!(
            injector.inject_registered(&stranger, "d-5", "m-5", text),
            InjectOutcome::Refused(
                "This agent's Grok binding changed; turn this agent off, then add the session again.".into()
            )
        );
        assert_eq!(prompts_sent(&prompts), 2);
        // An agent registered against the new binding is delivered.
        let fresh = grok_registration(session, &rebound);
        assert_eq!(
            injector.inject_registered(&fresh, "d-6", "m-6", text),
            InjectOutcome::Delivered
        );
        assert_eq!(prompts_sent(&prompts), 3);
    }

    #[test]
    fn sessions_existing_register_refuses_marked_unreadable_unproved_and_claimed_leaders() {
        let session = "01a0fe0c-8b26-7ec2-ad2f-bab882c091f4";
        let accept =
            |_: &crate::relay::existing_session::Binding,
             _: Arc<dyn crate::relay::existing_session::grok::Authority>| {
                Ok(("grok-4.7".to_string(), "1.0.46".to_string()))
            };
        let pid = std::process::id() as i32;
        let no_grok_rows = |sessions: &LocalSessions| {
            sessions
                .sessions()
                .iter()
                .all(|row| !matches!(row.target.kind, SessionKind::Grok | SessionKind::GrokOpen))
        };

        // Off: the producer refuses before looking.
        let w = grok_world();
        let (_listener, _) = open_grok_leader(&w, session);
        let mut off = w.sessions.config.clone();
        off.existing_grok = None;
        assert!(LocalSessions::new(off, w.table.clone())
            .register_existing_with(open_leader_request(&w, session), &accept)
            .is_err());

        // A leader carrying the managed marker is never a candidate.
        let w = grok_world();
        let (_listener, _) = open_grok_leader(&w, session);
        w.table
            .processes
            .lock()
            .unwrap()
            .get_mut(&pid)
            .unwrap()
            .environment
            .insert("AGENT_RELAY_MANAGED_SESSION_MARKER".into(), "m".into());
        assert!(w
            .sessions
            .register_existing_with(open_leader_request(&w, session), &accept)
            .is_err());
        assert!(no_grok_rows(&w.sessions));

        // An unreadable environment is not read as "no marker".
        let w = grok_world();
        let (_listener, _) = open_grok_leader(&w, session);
        w.table.unreadable_environment.lock().unwrap().insert(pid);
        assert!(w
            .sessions
            .register_existing_with(open_leader_request(&w, session), &accept)
            .is_err());

        // A failed readback stores nothing.
        let w = grok_world();
        let (_listener, _) = open_grok_leader(&w, session);
        let refuse =
            |_: &crate::relay::existing_session::Binding,
             _: Arc<dyn crate::relay::existing_session::grok::Authority>| {
                Err(crate::relay::existing_session::Failure::IdentityMismatch)
            };
        assert!(w
            .sessions
            .register_existing_with(open_leader_request(&w, session), &refuse)
            .is_err());
        assert!(no_grok_rows(&w.sessions));

        // A session, or a leader, the managed registry holds is refused,
        // live or not, and so is everything while it cannot be read.
        let w = grok_world();
        let (_listener, open) = open_grok_leader(&w, session);
        let other = "01a0fe0c-8b26-7ec2-ad2f-bab882c091f5";
        let manager = managed_grok(&w, &managed_on_leader(other, &open));
        let claimed = LocalSessions::new(w.sessions.config.clone(), w.table.clone())
            .with_managed(manager.clone());
        assert!(claimed
            .register_existing_with(open_leader_request(&w, session), &accept)
            .is_err());
        assert!(claimed
            .register_existing_with(open_leader_request(&w, other), &accept)
            .is_err());
        use std::os::unix::fs::PermissionsExt;
        let registry_file = w._temp.path().join("managed/bindings.json");
        std::fs::set_permissions(&registry_file, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(
            claimed
                .register_existing_with(open_leader_request(&w, session), &accept)
                .map(|row| row.target),
            Err("Managed session registry is unavailable.".into())
        );
        assert!(no_grok_rows(&claimed));
    }

    #[test]
    fn an_open_binding_naming_a_managed_leader_is_hidden_refused_and_cannot_speak() {
        let world = grok_world();
        let session = "01a0fe0c-8b26-7ec2-ad2f-bab882c091f4";
        let target = Target::new(SessionKind::GrokOpen, session);
        let (_listener, open) = open_grok_leader(&world, session);
        let registry = enablement::Registry::open(&existing_grok_paths(&world).bindings).unwrap();
        registry
            .register(&open, &ExistingLeaderAuthority::new(world.table.clone()))
            .unwrap();
        // The managed registry holds that same leader for another session.
        let manager = managed_grok(
            &world,
            &managed_on_leader("01a0fe0c-8b26-7ec2-ad2f-bab882c091f5", &open),
        );
        let mut config = world.sessions.config.clone();
        config.uid = crate::relay::peer::current_uid();
        let sessions =
            LocalSessions::new(config.clone(), world.table.clone()).with_managed(manager.clone());
        assert!(!sessions.sessions().iter().any(|row| row.target == target));
        assert_eq!(sessions.managed_authority(&target), None);
        let tool = std::process::id() as i32 + 100_000;
        world.table.insert(
            tool,
            FakeProcess {
                parent: std::process::id() as i32,
                uid: crate::relay::peer::current_uid(),
                start: 901,
                ..FakeProcess::default()
            },
        );
        assert_ne!(
            sessions.caller(tool).ok().map(|row| row.target),
            Some(target.clone())
        );
        let injector = LocalInjector::new(
            config,
            world.table.clone(),
            CodexRouter::new(Arc::new(UnusedCodexRoutes)),
            ServingPath::default(),
        )
        .with_managed(manager);
        assert_eq!(
            injector.inject_registered(
                &grok_registration(session, &open.credential_reference),
                "d-1",
                "m-1",
                "hi"
            ),
            InjectOutcome::Refused(
                "Both Grok routes claim this session; neither binding is used.".into()
            )
        );
    }

    #[test]
    fn the_nearest_session_wins_over_an_enclosing_grok_leader() {
        let world = grok_world();
        let session = "01a0fe0c-8b26-7ec2-ad2f-bab882c091f4";
        let (_listener, open) = open_grok_leader(&world, session);
        enablement::Registry::open(&existing_grok_paths(&world).bindings)
            .unwrap()
            .register(&open, &ExistingLeaderAuthority::new(world.table.clone()))
            .unwrap();
        // Claude Code (pid 300) now runs under the Grok leader.
        let uid = crate::relay::peer::current_uid();
        for pid in [300, 310, 320] {
            let mut process = world
                .table
                .processes
                .lock()
                .unwrap()
                .get(&pid)
                .cloned()
                .unwrap();
            process.uid = uid;
            if pid == 300 {
                process.parent = std::process::id() as i32;
            }
            world.table.insert(pid, process);
        }
        let mut config = world.sessions.config.clone();
        config.uid = uid;
        let sessions = LocalSessions::new(config, world.table.clone());
        assert_eq!(
            sessions.caller(320).ok().map(|row| row.target),
            Some(Target::new(SessionKind::ClaudeTerminal, CLAUDE))
        );
        // The leader's own tools are nobody, not the enclosing session.
        let tool = std::process::id() as i32 + 100_000;
        world.table.insert(
            tool,
            FakeProcess {
                parent: std::process::id() as i32,
                uid,
                start: 901,
                ..FakeProcess::default()
            },
        );
        assert_eq!(sessions.caller(tool).ok(), None);
    }

    #[test]
    fn a_muse_tool_is_identified_only_for_a_relay_spawned_session() {
        let world = world();
        let uid = crate::relay::peer::current_uid();
        let mut config = world.sessions.config.clone();
        config.uid = uid;
        config.muse_spawn = true;
        let registry = config.muse.registry_dir();
        std::fs::create_dir_all(&registry).unwrap();
        let session = "0199c0de-0000-7000-8000-000000000001";
        std::fs::write(
            registry.join(format!("{session}.json")),
            serde_json::json!({
                "session_id": session,
                "target_eligibility": "message_capable",
                "workspace_label": "proj",
                "process_generation_hint": "pid=510",
            })
            .to_string(),
        )
        .unwrap();
        let muse = |parent: i32, start: u64| FakeProcess {
            parent,
            uid,
            start,
            executable: Some(PathBuf::from("/opt/muse/bin/muse")),
            cwd: Some(world._temp.path().to_path_buf()),
            environment: std::collections::HashMap::from([(
                crate::relay::harness::muse::SPAWN_MARKER.to_string(),
                "0199c0de-0000-7000-8000-000000000002".to_string(),
            )]),
            ..FakeProcess::default()
        };
        let plain = |parent: i32, start: u64| FakeProcess {
            parent,
            uid,
            start,
            ..FakeProcess::default()
        };
        // Relay's Muse session (510) runs a shell (515) and a tool (520).
        world
            .table
            .insert(510, muse(std::process::id() as i32, 500));
        world.table.insert(515, plain(510, 501));
        world.table.insert(520, plain(515, 502));
        // A courier Muse (530), which the registry does not list, runs a tool.
        world.table.insert(530, muse(510, 503));
        world.table.insert(540, plain(530, 504));
        let sessions = LocalSessions::new(config.clone(), world.table.clone());
        let muse_target = Target::new(SessionKind::MuseOpen, session);
        assert_eq!(sessions.caller_target(520).ok(), Some(muse_target.clone()));
        // A Relay-owned Muse session gets the same reply command as other CLIs.
        assert!(LocalInjector::new(
            config.clone(),
            world.table.clone(),
            CodexRouter::new(Arc::new(UnusedCodexRoutes)),
            ServingPath::default(),
        )
        .can_reply(&muse_target));
        // The courier's tools are nobody, not the session that started it.
        assert_eq!(sessions.caller_target(540).ok(), None);
        // With Muse spawning off, it is not a caller and cannot reply.
        config.muse_spawn = false;
        let off = LocalSessions::new(config.clone(), world.table.clone());
        assert_eq!(off.caller_target(520).ok(), None);
        assert!(!LocalInjector::new(
            config,
            world.table.clone(),
            CodexRouter::new(Arc::new(UnusedCodexRoutes)),
            ServingPath::default(),
        )
        .can_reply(&muse_target));
    }

    #[test]
    fn a_legacy_nonspawn_muse_registration_cannot_deliver() {
        let world = world();
        let session = "0199c0de-0000-7000-8000-000000000001";
        let registration: crate::relay::store::Registration =
            serde_json::from_value(serde_json::json!({
                "name": "muse-agent",
                "agentID": "agent-muse",
                "target": {"kind": "muse-open", "id": session},
                "baseURL": "https://cast.agentrelay.com",
                "registeredAt": "2026-10-11T00:00:00Z",
                "routeBinding": format!("muse-open:{session}")
            }))
            .unwrap();
        let injector = LocalInjector::new(
            world.sessions.config.clone(),
            world.table,
            CodexRouter::new(Arc::new(UnusedCodexRoutes)),
            ServingPath::default(),
        );
        assert_eq!(
            injector.inject_registered(&registration, "delivery", "message", "hello"),
            InjectOutcome::Refused(
                "Only a Muse session started and owned by Agent Relay can receive messages."
                    .into()
            )
        );
    }

    #[test]
    fn an_opencode_shell_answers_as_the_session_its_opencode_holds() {
        use std::os::unix::fs::PermissionsExt;
        // OpenCode (pid 600) runs inside the Claude Code terminal at pid 300.
        let world = world();
        let uid = crate::relay::peer::current_uid();
        for pid in [300, 310, 320] {
            let mut process = world
                .table
                .processes
                .lock()
                .unwrap()
                .get(&pid)
                .cloned()
                .unwrap();
            process.uid = uid;
            world.table.insert(pid, process);
        }
        let runtime = tempfile::tempdir_in("/tmp").unwrap();
        let mut config = world.sessions.config.clone();
        config.uid = uid;
        config.opencode_open = true;
        config.opencode.runtime = runtime.path().join("rt");
        std::fs::create_dir_all(&config.opencode.runtime).unwrap();
        std::fs::set_permissions(
            &config.opencode.runtime,
            std::fs::Permissions::from_mode(0o700),
        )
        .unwrap();
        let held = "ses_held0000000000";
        let socket = config.opencode.runtime.join("600.sock");
        let _listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
        let record = config.opencode.runtime.join("600.json");
        std::fs::write(
            &record,
            serde_json::json!({"version": 1, "pid": 600, "socket": socket, "directory": "/w",
                "sessions": [{"id": held, "title": "Held", "directory": "/w", "updated": 1}]})
            .to_string(),
        )
        .unwrap();
        std::fs::set_permissions(&record, std::fs::Permissions::from_mode(0o600)).unwrap();
        world.table.insert(
            600,
            FakeProcess {
                parent: 320,
                uid,
                start: 600,
                executable: Some(PathBuf::from("/opt/opencode/bin/opencode")),
                ..FakeProcess::default()
            },
        );
        let shell = |pid: i32, session: Option<&str>| FakeProcess {
            parent: 600,
            uid,
            start: pid as u64,
            environment: session
                .map(|id| [(OPENCODE_SESSION_VAR.to_string(), id.to_string())].into())
                .unwrap_or_default(),
            ..FakeProcess::default()
        };
        world.table.insert(610, shell(610, Some(held)));
        world
            .table
            .insert(620, shell(620, Some("ses_notheld00000000")));
        world.table.insert(630, shell(630, None));
        let sessions = LocalSessions::new(config.clone(), world.table.clone());
        assert_eq!(
            sessions.caller_target(610).ok(),
            Some(Target::new(SessionKind::OpenCodeOpen, held))
        );
        // A session that OpenCode does not hold is nobody's claim.
        assert!(sessions.caller_target(620).is_err());
        // A shell whose tag cannot be read (an Apple binary on macOS) is the
        // one session its OpenCode holds, never the Claude Code session
        // OpenCode runs inside.
        assert_eq!(
            sessions.caller_target(630).ok(),
            Some(Target::new(SessionKind::OpenCodeOpen, held))
        );
        let injector = LocalInjector::new(
            config.clone(),
            world.table.clone(),
            CodexRouter::new(Arc::new(UnusedCodexRoutes)),
            ServingPath::default(),
        );
        assert!(injector.can_reply(&Target::new(SessionKind::OpenCodeOpen, held)));
        assert!(!injector.can_reply(&Target::new(
            SessionKind::OpenCodeOpen,
            "ses_notheld00000000"
        )));
        // Started from a Codex tool, OpenCode's shells inherit its thread
        // id; OpenCode is nearer, so its tag decides.
        let codex_thread = "0199a213-81c0-7800-8aa1-bbab2a035a53";
        let mut inherited = shell(640, Some(held));
        inherited
            .environment
            .insert("CODEX_THREAD_ID".into(), codex_thread.into());
        world.table.insert(640, inherited);
        assert_eq!(
            sessions.caller_target(640).ok(),
            Some(Target::new(SessionKind::OpenCodeOpen, held))
        );
        // A Codex started from an OpenCode shell inherits the tag; Codex is
        // nearer, so its tools are its own thread, not the OpenCode session.
        world.table.insert(
            650,
            FakeProcess {
                parent: 610,
                uid,
                start: 650,
                executable: Some(codex_exe()),
                arguments: vec!["codex".into(), "resume".into(), codex_thread.into()],
                environment: [(OPENCODE_SESSION_VAR.to_string(), held.to_string())].into(),
                ..FakeProcess::default()
            },
        );
        let mut tool = shell(660, Some(held));
        tool.parent = 650;
        world.table.insert(660, tool);
        assert_eq!(
            sessions.caller_target(660).ok(),
            Some(Target::new(SessionKind::Codex, codex_thread))
        );
        // Holding two sessions, only a readable tag says which one.
        let other = "ses_other000000000";
        std::fs::write(
            &record,
            serde_json::json!({"version": 1, "pid": 600, "socket": socket, "directory": "/w",
                "sessions": [{"id": held, "title": "Held", "directory": "/w", "updated": 2},
                             {"id": other, "title": "Other", "directory": "/w", "updated": 1}]})
            .to_string(),
        )
        .unwrap();
        let two = LocalSessions::new(config.clone(), world.table.clone());
        assert_eq!(
            two.caller_target(610).ok(),
            Some(Target::new(SessionKind::OpenCodeOpen, held))
        );
        assert!(two.caller_target(630).is_err());
        // With the route off, OpenCode is not a caller: its tag is ignored
        // and the walk goes on as it did before the route existed.
        config.opencode_open = false;
        let off = LocalSessions::new(config, world.table.clone());
        assert_ne!(
            off.caller_target(610).ok().map(|target| target.kind),
            Some(SessionKind::OpenCodeOpen)
        );
    }

    #[test]
    fn any_grok_leader_stops_the_caller_walk_while_the_route_is_on() {
        // An unregistered leader with no binding at all, run from inside the
        // Claude Code terminal at pid 300.
        let world = grok_world();
        let uid = crate::relay::peer::current_uid();
        for pid in [300, 310, 320] {
            let mut process = world
                .table
                .processes
                .lock()
                .unwrap()
                .get(&pid)
                .cloned()
                .unwrap();
            process.uid = uid;
            world.table.insert(pid, process);
        }
        world.table.insert(
            330,
            FakeProcess {
                parent: 320,
                uid,
                start: 130,
                arguments: ["grok", "agent", "leader", "--leader-socket", "/tmp/s"]
                    .map(String::from)
                    .to_vec(),
                ..FakeProcess::default()
            },
        );
        world.table.insert(
            340,
            FakeProcess {
                parent: 330,
                uid,
                start: 140,
                ..FakeProcess::default()
            },
        );
        let mut config = world.sessions.config.clone();
        config.uid = uid;
        assert_eq!(
            LocalSessions::new(config.clone(), world.table.clone())
                .caller(340)
                .ok(),
            None
        );
        // With the route off, main's walk names the enclosing Claude session.
        config.existing_grok = None;
        assert_eq!(
            LocalSessions::new(config, world.table.clone())
                .caller(340)
                .ok()
                .map(|row| row.target),
            Some(Target::new(SessionKind::ClaudeTerminal, CLAUDE))
        );
    }

    #[test]
    fn two_sessions_on_one_leader_are_each_delivered_and_neither_can_reply() {
        let world = grok_world();
        let first = "01a0fe0c-8b26-7ec2-ad2f-bab882c091f4";
        let second = "01a0fe0c-8b26-7ec2-ad2f-bab882c091f5";
        let (_listener, open) = open_grok_leader(&world, first);
        let registry = enablement::Registry::open(&existing_grok_paths(&world).bindings).unwrap();
        let authority = ExistingLeaderAuthority::new(world.table.clone());
        registry.register(&open, &authority).unwrap();
        let mut other = open.clone();
        other.session_id = second.into();
        other.credential_reference =
            crate::relay::existing_session::grok::existing_reference(&other);
        registry.register(&other, &authority).unwrap();

        let uid = crate::relay::peer::current_uid();
        let mut config = world.sessions.config.clone();
        config.uid = uid;
        let sessions = LocalSessions::new(config.clone(), world.table.clone());
        let rows: Vec<_> = sessions
            .sessions()
            .into_iter()
            .filter(|row| row.target.kind == SessionKind::GrokOpen)
            .map(|row| row.target.id)
            .collect();
        assert_eq!(rows.len(), 2);
        for pid in [100_000, 100_001] {
            let tool = std::process::id() as i32 + pid;
            world.table.insert(
                tool,
                FakeProcess {
                    parent: std::process::id() as i32,
                    uid,
                    start: 901,
                    ..FakeProcess::default()
                },
            );
            assert_eq!(sessions.caller(tool).ok(), None);
        }
        let injector = LocalInjector::new(
            config,
            world.table.clone(),
            CodexRouter::new(Arc::new(UnusedCodexRoutes)),
            ServingPath::default(),
        );
        for session in [first, second] {
            assert!(!injector.can_reply(&Target::new(SessionKind::GrokOpen, session)));
        }
    }
    #[test]
    fn spawned_grok_tools_reply_only_through_their_exact_proven_leader() {
        use crate::relay::existing_session::grok::{credential_reference, MANAGED_MARKER};
        use std::os::unix::fs::DirBuilderExt;
        let mut world = world();
        let id = "01a0fe0c-8b26-7ec2-ad2f-bab882c091f4";
        let (_listener, mut binding) = open_grok_leader(&world, id);
        let uid = crate::relay::peer::current_uid();
        let pid = binding.leader_pid;
        let marker = "test-spawn-leader-marker";
        binding.credential_reference = credential_reference(&binding, marker);
        world
            .table
            .processes
            .lock()
            .unwrap()
            .get_mut(&pid)
            .unwrap()
            .environment
            .insert(MANAGED_MARKER.into(), marker.into());
        let folder = world._temp.path().join("spawned-grok");
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&folder)
            .unwrap();
        let record = crate::relay::harness::grok::SpawnedGrok {
            binding,
            grok_home: world.sessions.config.grok.home.clone(),
        };
        std::fs::write(
            folder.join(format!("{id}.json")),
            serde_json::to_vec(&record).unwrap(),
        )
        .unwrap();
        world.sessions.config.spawned_grok = Some(folder);
        world.sessions.config.uid = uid;
        assert!(world.sessions.config.existing_grok.is_none());
        let tool = 999_000_001;
        let mut child = FakeProcess {
            parent: pid,
            uid,
            start: 1001,
            ..FakeProcess::default()
        };
        child
            .environment
            .insert("GROK_SESSION_ID".into(), id.into());
        // A spawned leader may inherit an outer Codex's variables. Its own
        // exact leader and session must decide instead.
        child.environment.insert(
            "CODEX_THREAD_ID".into(),
            "5f7c1f64-8f53-4c33-9d2f-7c1d2f1f0a11".into(),
        );
        world.table.insert(tool, child.clone());
        let target = Target::new(SessionKind::Grok, id);
        assert_eq!(world.sessions.caller(tool).unwrap().target, target);
        let native = crate::relay::grok::GrokConfig { home: record.grok_home.clone() };
        let dir = native.session_dir(record.binding.cwd.to_str().unwrap(), id);
        std::fs::create_dir_all(&dir).unwrap();
        for title in ["Renamed spawned Grok", "Changed externally"] {
            std::fs::write(dir.join("summary.json"), serde_json::json!({
                "info":{"id":id,"cwd":record.binding.cwd}, "generated_title":title,
            }).to_string()).unwrap();
            assert_eq!(world.sessions.caller(tool).unwrap().title, title);
        }
        let injector = LocalInjector::new(
            world.sessions.config.clone(),
            world.table.clone(),
            CodexRouter::new(Arc::new(UnusedCodexRoutes)),
            ServingPath::default(),
        );
        assert!(injector.can_reply(&target));
        assert!(injector.needs_probe_client(&target));
        // A claim alone, a nested agent, or another leader cannot borrow it.
        let other = 999_000_002;
        let mut unrelated = child.clone();
        unrelated.parent = 1;
        world.table.insert(other, unrelated);
        assert!(world.sessions.caller(other).is_err());
        let mut nested = child.clone();
        nested.executable = Some(PathBuf::from("/tmp/codex"));
        world.table.insert(tool, nested);
        assert!(world.sessions.caller(tool).is_err());
        world.table.insert(tool, child);
        world
            .table
            .unreadable_environment
            .lock()
            .unwrap()
            .insert(tool);
        assert!(world.sessions.caller(tool).is_err());
        world
            .table
            .unreadable_environment
            .lock()
            .unwrap()
            .remove(&tool);
        world
            .table
            .processes
            .lock()
            .unwrap()
            .get_mut(&pid)
            .unwrap()
            .environment
            .insert(MANAGED_MARKER.into(), "other-marker".into());
        assert!(world.sessions.caller(tool).is_err());
        assert!(!injector.can_reply(&target));
        world
            .table
            .processes
            .lock()
            .unwrap()
            .get_mut(&pid)
            .unwrap()
            .environment
            .insert(MANAGED_MARKER.into(), marker.into());
        world
            .table
            .processes
            .lock()
            .unwrap()
            .get_mut(&pid)
            .unwrap()
            .start += 1;
        assert!(world.sessions.caller(tool).is_err());
        assert!(!injector.can_reply(&target));
    }

    #[test]
    fn spawned_opencode_reply_tags_need_the_nearest_verified_private_server() {
        let world = world();
        let mut config = world.sessions.config.clone();
        config.uid = crate::relay::peer::current_uid();
        config.opencode_open = false; // Spawned bindings do not depend on the TUI discovery flag.
        let cli = world._temp.path().join("opencode");
        std::fs::write(&cli, "").unwrap();
        let marker = "synthetic-private-server";
        world.table.insert(
            600,
            FakeProcess {
                uid: config.uid,
                parent: 300,
                start: 600,
                executable: Some(cli.clone()),
                arguments: vec!["opencode".into(), "serve".into()],
                environment: [(crate::relay::opencode_serve::MARKER.into(), marker.into())].into(),
                ..Default::default()
            },
        );
        let tool = |session: Option<&str>| FakeProcess {
            uid: config.uid,
            parent: 600,
            start: 610,
            environment: session
                .map(|id| (OPENCODE_SESSION_VAR.into(), id.into()))
                .into_iter()
                .chain(Some(("CODEX_THREAD_ID".into(), THREAD.into())))
                .collect(),
            ..Default::default()
        };
        world.table.insert(610, tool(Some("ses_exact")));
        world.table.insert(611, tool(Some("ses_wrong")));
        world.table.insert(612, tool(None));
        let mut binding = opencode_existing::Binding {
            relay_workspace_id: "test-workspace".into(),
            owner_id: "test-owner".into(),
            session_id: "ses_exact".into(),
            endpoint: "http://127.0.0.1:10001".into(),
            server_pid: 600,
            server_start: 600,
            server_uid: config.uid,
            executable: cli,
            directory: world._temp.path().to_path_buf(),
            project_id: "test-project".into(),
            opencode_workspace_id: None,
            credential_reference: String::new(),
        };
        binding.credential_reference = opencode_existing::credential_reference(&binding, marker);
        let managed_binding = ManagedBinding::OpenCode(binding);
        let manager = Arc::new(ManagedSessions::new(
            world._temp.path().join("managed-reply"),
            Default::default(),
            Arc::new(FixedManagedRuntime(managed_binding.clone())),
        ));
        manager.adopt(managed_binding).unwrap();
        crate::relay::paths::socket_directory(&config.opencode.runtime).unwrap();
        let attestation = config.opencode.runtime.join("600.managed.json");
        use sha2::{Digest, Sha256};
        std::fs::write(&attestation,serde_json::json!({"version":crate::relay::opencode::PLUGIN_VERSION,"pid":600,"marker_sha256":format!("{:x}",Sha256::digest(marker.as_bytes()))}).to_string()).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&attestation, std::fs::Permissions::from_mode(0o600)).unwrap();
        let sessions =
            LocalSessions::new(config.clone(), world.table.clone()).with_managed(manager.clone());
        let target = Target::new(SessionKind::OpenCode, "ses_exact");
        assert_eq!(sessions.caller_target(610).ok(), Some(target.clone()));
        assert!(sessions.caller_target(611).is_err());
        assert!(sessions.caller_target(612).is_err());
        assert_eq!(sessions.caller(610).unwrap().target, target);
        let injector = LocalInjector::new(
            config,
            world.table.clone(),
            CodexRouter::new(Arc::new(UnusedCodexRoutes)),
            ServingPath::default(),
        )
        .with_managed(manager);
        assert!(injector.can_reply(&target));
        assert!(injector.needs_probe_client(&target));
        std::fs::remove_file(attestation).unwrap();
        assert!(!injector.can_reply(&target));
        assert!(sessions.caller_target(610).is_err());
    }
}
