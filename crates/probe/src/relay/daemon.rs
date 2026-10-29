//! `agent-relay-probe relay serve`: the long-running core the desktop UIs
//! drive.
//!
//! One daemon per socket, enforced by an exclusive lock held for the
//! process's life. It serves the bridge on a 0600 Unix socket in a 0700
//! directory (on Windows, on the named pipe `relay::transport` derives from
//! the socket path, limited to this user by its DACL), rediscovers the
//! workspace every 30 s and on request, verifies a newly found key with
//! Relaycast, keeps push channels for registered agents, and stops on
//! SIGTERM/SIGINT (Ctrl-C, Ctrl-Break, console close or system shutdown on
//! Windows), `daemon.shutdown`, or — with `--exit-on-stdin-eof`, when a
//! parent app hosts it — its stdin closing.

use crate::relay::agents::{KeyedLocks, SettingsExtension};
use crate::relay::backoff::{BackoffNotice, RelaycastBackoff, WorkspaceScope};
use crate::relay::claude_delivery_policy::ClaudeDeliveryPolicy;
use crate::relay::cloud_session::{CloudAccess, SignedOut};
use crate::relay::connect::{CloudJoinClient, ConnectJoinClient, ConnectState, CONNECT_STORE_FILE};
use crate::relay::delivery::{DeliveryState, DeliveryTiming};
use crate::relay::inject::{Injector, NoInjector};
use crate::relay::messaging::MessagingState;
use crate::relay::outbound::{Outbound, RelaySend, RelaySocket};
use crate::relay::paths::{self, CorePaths};
use crate::relay::protocol::{ErrorKind, RpcError, BRIDGE_VERSION};
use crate::relay::push::{PushContext, PushManager, PushSignal, PushTarget, PushTiming};
use crate::relay::sessions::{NoSessions, SessionDirectory};
use crate::relay::state::{
    now_ms, DaemonInfo, Hub, Level, MachineInfo, Status, Verification, WorkspaceStatus,
};
use crate::relay::store::{PublishedJournal, Registration, StoreHandle};
use crate::relay::transport::CoreListener;
use crate::relay::workspace::{self, Secret, Workspace};
use crate::relay::{app_store, client, files, machine, server};
use anyhow::{Context, Result};
use fs2::FileExt;
use std::collections::BTreeMap;
use std::fs;
#[cfg(unix)]
use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{mpsc, watch};

mod key_rotation;
mod relaycast_writes;
mod workspace_verification;

/// A failure whose message is safe to print as is.
#[derive(Debug)]
pub struct SafeError(pub String);

impl std::fmt::Display for SafeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for SafeError {}

/// How the daemon was started.
#[derive(Clone, Debug)]
pub struct ServeOptions {
    pub socket: Option<PathBuf>,
    pub app_data_dir: Option<PathBuf>,
    pub exit_on_stdin_eof: bool,
    /// The Agent Relay site this build signs in to; `https://agentrelay.com`
    /// when absent.
    pub site_url: Option<String>,
    /// Run as the Linux headless service: the systemd user unit owns
    /// startup, so the GUI's autostart entry is removed and never written,
    /// and the agent-led setup defaults apply at start.
    pub headless: bool,
    pub connect_ephemeral: bool,
}

/// Everything the core reads from its surroundings, fixed at start. Its
/// `Debug` names the environment's variables but never their values, which
/// can be keys.
#[derive(Clone)]
pub struct Config {
    pub paths: CorePaths,
    pub home: PathBuf,
    pub app_data_dir: PathBuf,
    pub env: BTreeMap<String, String>,
    pub version: String,
    pub host_name: String,
    pub rediscover_every: Duration,
    pub push_timing: PushTiming,
    pub delivery_timing: DeliveryTiming,
}

impl std::fmt::Debug for Config {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Config")
            .field("paths", &self.paths)
            .field("home", &self.home)
            .field("app_data_dir", &self.app_data_dir)
            .field("env", &self.env.keys().collect::<Vec<_>>())
            .field("version", &self.version)
            .field("host_name", &self.host_name)
            .field("rediscover_every", &self.rediscover_every)
            .field("push_timing", &self.push_timing)
            .field("delivery_timing", &self.delivery_timing)
            .finish()
    }
}

impl Config {
    pub fn from_process(options: &ServeOptions) -> Result<Config> {
        let home = paths::home()?;
        let env: BTreeMap<String, String> = std::env::vars().collect();
        let lookup = |key: &str| env.get(key).cloned();
        let paths = CorePaths::resolve(options.socket.as_deref(), lookup, &home)
            .map_err(|error| SafeError(error.to_string()))?;
        let app_data_dir =
            app_store::resolve_data_dir(options.app_data_dir.as_deref(), &lookup, &home);
        Ok(Config {
            paths,
            home,
            app_data_dir,
            // Read before `env` moves into the config.
            delivery_timing: DeliveryTiming::from_env(&lookup),
            env,
            version: crate::VERSION.to_string(),
            host_name: machine::host_name(),
            rediscover_every: Duration::from_secs(30),
            push_timing: PushTiming::default(),
        })
    }
}

/// What the core is built with beyond its configuration: the session side
/// of delivery, discovery, Cloud access, extra settings, and the account
/// with its uploader. Each defaults to an implementation that does nothing.
pub struct Plugins {
    pub injector: Arc<dyn Injector>,
    pub sessions: Arc<dyn SessionDirectory>,
    pub cloud: Arc<dyn CloudAccess>,
    /// Public Relay Connect join and invite-status access. It carries no
    /// account credential and is fakeable for socket-route tests.
    pub connect_cloud: Arc<dyn ConnectJoinClient>,
    pub settings: Vec<Arc<dyn SettingsExtension>>,
    /// The relay-send socket sessions reach the core through; not served
    /// when `None`.
    pub relay_send: Option<RelaySend>,
    /// Sign-in, the uploader, telemetry; usually
    /// also `cloud` (`account::plugins`).
    pub account: Option<Arc<crate::relay::account::Account>>,
    /// Messages for Conductor's Codex chats that Agent Relay's Codex Stop
    /// hook collects (`POST /codex/stop-hook`); none without the hook.
    pub codex_stop_hook: Option<Arc<crate::relay::codex::stop_hook::StopHookInbox>>,
    /// Starts the agents Agent Relay spawns here (`relay::spawn`).
    pub spawner: Arc<dyn crate::relay::spawn::launch::Spawner>,
    /// The trusted senders for OpenClaw and Hermes, whose workspace people
    /// are read from Cloud; none where neither can be set up.
    pub trusted: Option<Arc<crate::relay::trusted::TrustedSettings>>,
}

impl Default for Plugins {
    fn default() -> Plugins {
        Plugins {
            injector: Arc::new(NoInjector),
            sessions: Arc::new(NoSessions),
            cloud: Arc::new(SignedOut),
            connect_cloud: Arc::new(CloudJoinClient),
            settings: Vec::new(),
            relay_send: None,
            account: None,
            codex_stop_hook: None,
            spawner: Arc::new(crate::relay::spawn::launch::NoSpawner),
            trusted: None,
        }
    }
}

/// The running core: state, workspace, the agent store, push channels,
/// delivery and messaging state, and the stop signal.
pub struct Core {
    pub(crate) config: Config,
    pub(crate) hub: Hub,
    workspace: Mutex<Option<Workspace>>,
    push: tokio::sync::Mutex<PushManager>,
    shutdown: watch::Sender<bool>,
    pub(crate) machine_prefix: String,
    pub(crate) store: StoreHandle,
    pub(crate) plugins: Plugins,
    /// Project metadata shared by local discovery and upload history.
    pub(crate) project_names: crate::relay::project::Names,
    /// Completed provider snapshots. Bridge reads never scan providers.
    pub(crate) session_snapshot: crate::relay::local_methods::PresentationSnapshot,
    /// Native title and mobile-state publications fence older roster snapshots.
    pub(crate) roster_revision: std::sync::atomic::AtomicU64,
    /// One change at a time per session (`target.key()`).
    pub(crate) target_locks: KeyedLocks,
    /// One delivery at a time per agent name; a removal waits for it.
    pub(crate) agent_locks: KeyedLocks,
    /// Serialize roster metadata and presence writes for each relay name.
    pub(crate) roster_locks: KeyedLocks,
    /// Names being registered right now, so two sessions cannot claim one.
    pub(crate) claiming: Mutex<std::collections::HashSet<String>>,
    /// Setup routes and the delivery supervisor can both request a pass;
    /// admission limits and lifecycle state are reconciled by one at a
    /// time. The guard also carries the activation journal last mirrored
    /// onto roster metadata — `None` until this daemon has mirrored — so
    /// a failed patch or a cleared journal stays dirty until republished.
    pub(crate) auto_activation: tokio::sync::Mutex<Option<PublishedJournal>>,
    /// Whether the first lifecycle pass has told Relaycast which agents
    /// were already absent when this daemon started.
    pub(crate) presence_announced: std::sync::atomic::AtomicBool,
    /// Held while integration defaults are applied and while the person
    /// changes an integration setting, so a default never lands after an
    /// opt-out it did not see.
    pub(crate) integration_settings: std::sync::Mutex<()>,
    /// Presence changes Relaycast has not confirmed yet, by agent name:
    /// `idle` or `active`. Retried every lifecycle pass until the update
    /// succeeds, so an outage never leaves an ended agent shown active.
    pub(crate) presence_pending: std::sync::Mutex<std::collections::BTreeMap<String, &'static str>>,
    /// Agents being renamed away from: what is already addressed to them
    /// is still delivered, to the same session, until they are removed.
    pub(crate) retiring: Mutex<BTreeMap<String, (Registration, Secret)>>,
    pub(crate) delivery: Mutex<DeliveryState>,
    pub(crate) claude_delivery: ClaudeDeliveryPolicy,
    pub(crate) mobile_claude_plugins: crate::relay::claude_mobile_plugin::Installations,
    /// Workspace-wide pacing shared by queue reads, heartbeats, lifecycle
    /// calls and direct-node token refreshes.
    pub(crate) relaycast_backoff: Arc<RelaycastBackoff>,
    /// Accountless Connect credentials are isolated from workspace registrations.
    pub(crate) connect: Mutex<ConnectState>,
    pub(crate) connect_lifetime: super::connect_lifetime::ConnectLifetime,
    pub(crate) messaging: Mutex<MessagingState>,
    /// One relayfile subscription change at a time: they share workspace
    /// subscription state.
    pub(crate) integration_lock: tokio::sync::Mutex<()>,
    /// Serializes credential-bearing Cloud reconciliations. A sign-out or
    /// workspace clear queued behind an upsert is therefore always last.
    pub(crate) desktop_identity_sync: crate::relay::desktop_identity::DesktopIdentitySync,
    /// Contractor access, made on first use (`contractor_access::of`).
    pub(crate) contractors:
        std::sync::OnceLock<Arc<crate::relay::contractor_access::ContractorAccess>>,
    /// The spawn node, while spawns are on (`relay::spawn`).
    pub(crate) spawn_node: tokio::sync::Mutex<Option<crate::relay::spawn::node::SpawnNode>>,
    pub(crate) me: std::sync::Weak<Core>,
}

impl Core {
    /// Builds the core with no plugins; see [`Core::with_plugins`].
    pub fn new(config: Config) -> (Arc<Core>, mpsc::UnboundedReceiver<PushSignal>) {
        Core::with_plugins(config, Plugins::default())
    }

    /// Builds the core and loads the agent store; the returned receiver
    /// carries its push signals to [`Core::pump_push_signals`].
    pub fn with_plugins(
        config: Config,
        plugins: Plugins,
    ) -> (Arc<Core>, mpsc::UnboundedReceiver<PushSignal>) {
        let machine_prefix = machine::machine_prefix(&config.host_name);
        let hub = Hub::new(
            DaemonInfo {
                build_revision: Some(crate::BUILD_REVISION.into()),
                history_version: crate::history_version().map(Into::into),
                version: config.version.clone(),
                bridge_version: BRIDGE_VERSION,
                pid: std::process::id(),
                started_at_ms: now_ms(),
                socket: config.paths.socket.display().to_string(),
            },
            MachineInfo {
                host_name: config.host_name.clone(),
                machine_prefix: machine_prefix.clone(),
            },
        );
        let (signals, signal_rx) = mpsc::unbounded_channel();
        let relaycast_backoff = Arc::new(RelaycastBackoff::default());
        let push = PushManager::new(PushContext::new(
            config.version.clone(),
            machine_prefix.clone(),
            config.push_timing,
            signals,
            relaycast_backoff.clone(),
        ));
        let (shutdown, _) = watch::channel(false);
        let store = StoreHandle::open_agent_store(
            config.app_data_dir.join(app_store::STORE_FILE),
            &machine_prefix,
        );
        let mut connect = ConnectState::load(config.app_data_dir.join(CONNECT_STORE_FILE));
        // This runs before the core is exposed or begins other startup work:
        // a queued terminal handoff from an expired Connect must not become a
        // turn merely because the probe restarted after its expiry.
        connect.reconcile_expired(plugins.injector.as_ref());
        // Persist the installation-scoped Cloud reconciliation id before
        // any credential-bearing identity sync can run.
        let _ = store.update(|store| store.ensure_desktop_sync_source_id());
        let claude_delivery = ClaudeDeliveryPolicy::open(&config.app_data_dir);
        let project_names = crate::relay::project::Names::new(crate::relay::workspace::relay_home(
            &|key| config.env.get(key).cloned(),
            &config.home,
        ));
        let core = Arc::new_cyclic(|me| Core {
            config,
            hub,
            workspace: Mutex::new(None),
            push: tokio::sync::Mutex::new(push),
            shutdown,
            machine_prefix,
            store,
            plugins,
            project_names,
            session_snapshot: Default::default(),
            roster_revision: std::sync::atomic::AtomicU64::new(0),
            target_locks: KeyedLocks::default(),
            agent_locks: KeyedLocks::default(),
            roster_locks: KeyedLocks::default(),
            claiming: Mutex::default(),
            auto_activation: tokio::sync::Mutex::new(None),
            presence_announced: std::sync::atomic::AtomicBool::new(false),
            integration_settings: std::sync::Mutex::new(()),
            presence_pending: std::sync::Mutex::new(std::collections::BTreeMap::new()),
            retiring: Mutex::default(),
            delivery: Mutex::default(),
            claude_delivery,
            mobile_claude_plugins: Default::default(),
            relaycast_backoff,
            connect: Mutex::new(connect),
            connect_lifetime: Default::default(),
            messaging: Mutex::default(),
            integration_lock: tokio::sync::Mutex::new(()),
            desktop_identity_sync: Default::default(),
            contractors: std::sync::OnceLock::new(),
            spawn_node: tokio::sync::Mutex::new(None),
            me: me.clone(),
        });
        if let Some(trusted) = &core.plugins.trusted {
            trusted.bind_cloud(core.plugins.cloud.clone());
        }
        crate::relay::settings_watch::attach_plugins(&core);
        (core, signal_rx)
    }

    /// This core, for work that outlives the call that starts it.
    pub(crate) fn arc(&self) -> Option<Arc<Core>> {
        self.me.upgrade()
    }

    /// The workspace last discovered.
    pub fn workspace(&self) -> Option<Workspace> {
        self.workspace.lock().unwrap().clone()
    }

    pub fn hub(&self) -> &Hub {
        &self.hub
    }

    pub fn config(&self) -> &Config {
        &self.config
    }

    pub fn status(&self) -> Status {
        self.hub.snapshot()
    }

    pub(crate) fn relaycast_scope(&self, base_url: &str, key: &Secret) -> WorkspaceScope {
        let label = self
            .workspace()
            .filter(|workspace| workspace.base_url == base_url && workspace.key == *key)
            .and_then(|_| {
                let workspace = self.status().workspace;
                workspace.workspace_name.or(workspace.workspace_id)
            })
            .unwrap_or_else(|| "this workspace".into());
        WorkspaceScope::credential(base_url, key, label)
    }

    pub(crate) fn relaycast_registration_scope(
        &self,
        registration: &Registration,
        agent_token: &Secret,
    ) -> WorkspaceScope {
        let key = self
            .key_for(registration)
            .unwrap_or_else(|| agent_token.clone());
        self.relaycast_scope(&registration.base_url, &key)
    }

    pub(crate) fn relaycast_workspace_id_scope(
        &self,
        base_url: &str,
        workspace_id: &str,
        label: impl Into<String>,
    ) -> WorkspaceScope {
        WorkspaceScope::id(base_url, workspace_id, label)
    }

    pub(crate) fn relaycast_poll_allowed(&self, workspace: &WorkspaceScope) -> bool {
        self.relaycast_backoff.allowed(workspace)
    }

    pub(crate) fn relaycast_write_allowed(&self, workspace: &WorkspaceScope) -> bool {
        self.relaycast_backoff.allowed_write(workspace)
    }

    pub(crate) fn observe_relaycast_result<T>(
        &self,
        workspace: &WorkspaceScope,
        result: &relaycast::Result<T>,
    ) {
        match result {
            Ok(_) => self.relaycast_backoff.record_success(workspace),
            Err(error) => {
                if let Some(notice) = self.relaycast_backoff.record_error(workspace, error) {
                    self.report_relaycast_backoff(workspace, &notice);
                }
                self.schedule_verification_after_refusal(workspace, error);
            }
        }
    }

    fn report_relaycast_backoff(&self, workspace: &WorkspaceScope, notice: &BackoffNotice) {
        self.hub
            .activity(Level::Warning, notice.message(workspace.label()));
    }

    /// The signed-in account's workspace, as the agent store records it now.
    pub fn discover(&self) -> Option<Workspace> {
        let env = |key: &str| self.config.env.get(key).cloned();
        workspace::resolve(
            app_store::load_cloud(&self.config.app_data_dir).as_ref(),
            &env,
        )
    }

    /// The local half of `refresh_workspace`: records the workspace
    /// discovery finds now, and answers whether Relaycast is still to be
    /// asked about it. Nothing here waits on the network.
    pub fn rediscover_workspace(&self) -> bool {
        let found = self.discover();
        let changed = {
            let mut current = self.workspace.lock().unwrap();
            let changed = *current != found;
            *current = found.clone();
            changed
        };
        if changed {
            self.hub
                .update(|status| status.workspace = WorkspaceStatus::discovered(found.as_ref()));
            match &found {
                Some(workspace) => self.hub.activity(
                    Level::Info,
                    format!(
                        "Using your account's Agent Relay workspace at {}.",
                        workspace.base_url
                    ),
                ),
                None => self
                    .hub
                    .activity(Level::Warning, "Sign in to use an Agent Relay workspace."),
            }
            // The spawn node follows the workspace. At start the first agent
            // sync can run before discovery, and nothing else would bring
            // the node up once the workspace is found.
            if let (Some(core), Ok(runtime)) = (self.arc(), tokio::runtime::Handle::try_current()) {
                runtime.spawn(async move { core.sync_spawn_node().await });
            }
        }
        let verification = self.status().workspace.verification;
        found.is_some()
            && (changed
                || matches!(
                    verification,
                    Verification::Pending | Verification::Unreachable
                ))
    }

    /// Keeps one push channel per target (the delivery runtime's call). A
    /// stopped channel leaves the snapshot through its `Stopped` signal.
    pub async fn sync_push(&self, targets: Vec<PushTarget>) {
        self.push.lock().await.sync(targets).await;
    }

    /// Folds push signals into the status snapshot, handing wakes to
    /// `on_wake`, for the daemon's life.
    pub async fn pump_push_signals(
        self: Arc<Core>,
        mut signals: mpsc::UnboundedReceiver<PushSignal>,
        on_wake: impl Fn(String, Option<serde_json::Value>) + Send + 'static,
    ) {
        while let Some(signal) = signals.recv().await {
            match signal {
                PushSignal::State { agent, state } => {
                    self.hub.update(|status| {
                        status.push.insert(agent, state);
                    });
                }
                PushSignal::Stopped { agent } => {
                    self.hub.update(|status| {
                        status.push.remove(&agent);
                    });
                }
                PushSignal::Wake { agent, frame } => on_wake(agent, frame),
                PushSignal::Presence { target, sent_at } => {
                    self.record_push_presence(&target, sent_at);
                }
                PushSignal::Backoff { workspace, notice } => {
                    self.report_relaycast_backoff(&workspace, &notice);
                }
            }
        }
    }

    pub fn request_shutdown(&self) {
        let _ = self.shutdown.send(true);
    }

    pub fn shutdown_requested(&self) -> watch::Receiver<bool> {
        self.shutdown.subscribe()
    }

    /// Whether shutdown was requested: no new work starts.
    pub(crate) fn stopping(&self) -> bool {
        *self.shutdown.borrow()
    }

    /// Stops every push channel and tells clients the daemon is going.
    pub async fn stop(&self) {
        self.hub.shutting_down();
        self.push.lock().await.stop().await;
        self.stop_spawn_node().await;
    }
}

/// Holds the single-instance lock for `paths` for as long as it lives.
pub struct InstanceLock {
    _file: fs::File,
}

impl InstanceLock {
    pub fn acquire(paths: &CorePaths) -> Result<InstanceLock> {
        paths::socket_directory(paths.directory()).map_err(|error| SafeError(error.to_string()))?;
        let file = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&paths.lock)?;
        // Windows: the lock file inherits the user profile's private ACL.
        #[cfg(unix)]
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
        file.try_lock_exclusive().map_err(|_| {
            SafeError("Agent Relay core is already running for this socket.".into())
        })?;
        Ok(InstanceLock { _file: file })
    }
}

/// The bound socket; removes its own inode (and only that) when dropped.
/// On Windows there is no file: the pipe goes when its last instance closes.
pub struct BoundSocket {
    listener: Option<CoreListener>,
    path: PathBuf,
    #[cfg(unix)]
    inode: (u64, u64),
}

impl BoundSocket {
    /// Binds `paths.socket`. The caller holds the instance lock, so a socket
    /// already at the path belongs to a daemon that is gone and is replaced;
    /// anything that is not a socket is never deleted.
    #[cfg(unix)]
    pub fn bind(paths: &CorePaths) -> Result<BoundSocket> {
        if let Ok(metadata) = fs::symlink_metadata(&paths.socket) {
            if !metadata.file_type().is_socket() {
                return Err(SafeError(format!(
                    "{} exists and is not a socket; move it aside.",
                    paths.socket.display()
                ))
                .into());
            }
            fs::remove_file(&paths.socket)?;
        }
        let listener = CoreListener::bind(&paths.socket)
            .with_context(|| format!("could not listen on {}", paths.socket.display()))?;
        fs::set_permissions(&paths.socket, fs::Permissions::from_mode(0o600))?;
        let metadata = fs::symlink_metadata(&paths.socket)?;
        Ok(BoundSocket {
            listener: Some(listener),
            path: paths.socket.clone(),
            inode: (metadata.dev(), metadata.ino()),
        })
    }

    /// Creates the named pipe for `paths.socket`. A pipe a process that is
    /// gone created closed with it, so there is nothing stale to replace;
    /// one another process holds is never joined.
    #[cfg(windows)]
    pub fn bind(paths: &CorePaths) -> Result<BoundSocket> {
        let listener = CoreListener::bind(&paths.socket).with_context(|| {
            format!(
                "could not listen on {} for {}",
                crate::relay::transport::pipe_name(&paths.socket),
                paths.socket.display()
            )
        })?;
        Ok(BoundSocket {
            listener: Some(listener),
            path: paths.socket.clone(),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The listener, for the accept loop; the socket file stays owned here.
    pub fn take_listener(&mut self) -> Option<CoreListener> {
        self.listener.take()
    }
}

#[cfg(unix)]
impl Drop for BoundSocket {
    fn drop(&mut self) {
        if let Ok(metadata) = fs::symlink_metadata(&self.path) {
            if (metadata.dev(), metadata.ino()) == self.inode {
                let _ = fs::remove_file(&self.path);
            }
        }
    }
}

/// Runs the daemon until it is told to stop.
pub fn serve(options: ServeOptions) -> Result<()> {
    let config = Config::from_process(&options)?;
    let _lock = InstanceLock::acquire(&config.paths)?;
    crate::relay::diagnostics::initialize(&config.home, &config.app_data_dir);
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .thread_name("relay-core")
        .build()?;
    let result = runtime.block_on(async move {
        // Before the socket exists: a client that sees it may signal at once.
        let stop_signals = StopSignals::register();
        let headless_cleanup = cleanup_gui_autostart(&options, &config.home, &config.env);
        let socket = BoundSocket::bind(&config.paths)?;
        let mut local = crate::relay::local::plugins_with(&config, None);
        if let Some(relay_send) = &mut local.relay_send {
            relay_send.agent_led_defaults_at_start = options.headless;
        }
        let plugins = crate::relay::account::with_account(
            local,
            &config,
            options.site_url.as_deref(),
            options.headless,
        );
        let (core, signals) = Core::with_plugins(config, plugins);
        // A user may install and open the app after a standalone probe was
        // started. Once the app's launchd core is registered for this HOME,
        // yield the socket so its KeepAlive job can take over.
        #[cfg(target_os = "macos")]
        if options.headless {
            watch_macos_app_takeover(core.clone());
        }
        match headless_cleanup {
            Some(Ok(true)) => core.hub.activity(
                Level::Info,
                "Removed the app's login entry: the headless service starts Agent Relay.",
            ),
            Some(Err(_)) => core.hub.activity(
                Level::Warning,
                "The app's login entry could not be removed; the headless service still runs.",
            ),
            _ => {}
        }
        if options.connect_ephemeral {
            watch_connect_idle(core.clone());
        }
        if options.exit_on_stdin_eof {
            watch_stdin(core.clone());
        }
        run_with(core, socket, signals, stop_signals).await
    });
    runtime.shutdown_timeout(Duration::from_secs(2));
    result
}

#[cfg(target_os = "macos")]
fn watch_macos_app_takeover(core: Arc<Core>) {
    let home = core.config.home.clone();
    let mut stopping = core.shutdown_requested();
    tokio::spawn(async move {
        let mut check = tokio::time::interval(Duration::from_secs(5));
        loop {
            tokio::select! {
                _ = check.tick() => {
                    let home = home.clone();
                    let loaded = tokio::task::spawn_blocking(move || macos_app_core_loaded(&home))
                        .await
                        .unwrap_or(false);
                    if loaded {
                        core.hub.activity(Level::Info, "The Agent Relay app core is taking over.");
                        core.request_shutdown();
                        break;
                    }
                }
                changed = stopping.changed() => {
                    if changed.is_err() || *stopping.borrow() {
                        break;
                    }
                }
            }
        }
    });
}

#[cfg(target_os = "macos")]
fn macos_app_core_loaded(home: &Path) -> bool {
    use std::ffi::CStr;
    use std::process::Command;

    // launchd's GUI domain uses the account's login HOME, not an overriding
    // HOME used by tests or a shell. It cannot take over another HOME's socket.
    let uid = unsafe { libc::geteuid() };
    let mut record: libc::passwd = unsafe { std::mem::zeroed() };
    let mut found = std::ptr::null_mut();
    let mut buffer = vec![0u8; 16 * 1024];
    let looked_up = unsafe {
        libc::getpwuid_r(
            uid,
            &mut record,
            buffer.as_mut_ptr().cast(),
            buffer.len(),
            &mut found,
        )
    };
    if looked_up != 0 || found.is_null() {
        return false;
    }
    let Some(login_home) = (unsafe { CStr::from_ptr(record.pw_dir) }).to_str().ok() else {
        return false;
    };
    if home != Path::new(login_home) {
        return false;
    }
    let plist = Path::new("Contents/Library/LaunchAgents/com.agentrelay.desktop.core.plist");
    if !Path::new("/Applications/Agent Relay.app")
        .join(plist)
        .is_file()
        && !home
            .join("Applications/Agent Relay.app")
            .join(plist)
            .is_file()
    {
        return false;
    }
    Command::new("/bin/launchctl")
        .arg("print")
        .arg(format!("gui/{uid}/com.agentrelay.desktop.core"))
        .output()
        .is_ok_and(|output| output.status.success())
}

/// Serves on `socket` until shutdown, then stops cleanly. Tests call this
/// with a core built on a temporary home.
pub async fn run(
    core: Arc<Core>,
    socket: BoundSocket,
    signals: mpsc::UnboundedReceiver<PushSignal>,
) -> Result<()> {
    run_with(core, socket, signals, StopSignals::register()).await
}

async fn run_with(
    core: Arc<Core>,
    mut socket: BoundSocket,
    signals: mpsc::UnboundedReceiver<PushSignal>,
    stop_signals: Option<StopSignals>,
) -> Result<()> {
    let waker = core.clone();
    let pump = tokio::spawn(
        core.clone()
            .pump_push_signals(signals, move |agent, frame| waker.wake(agent, frame)),
    );
    let refresher = tokio::spawn(refresh_loop(core.clone()));
    core.sync_agents().await;
    let delivery = tokio::spawn(core.clone().delivery_loop());
    let replies = tokio::spawn(core.clone().reply_loop());
    let signal_watch = tokio::spawn(stop_on_signals(core.clone(), stop_signals));
    let account = core
        .plugins
        .account
        .clone()
        .map(|account| tokio::spawn(account.run()));
    core.hub.activity(Level::Info, "Agent Relay core started.");

    let mut stopping = core.shutdown_requested();
    let listener = socket
        .take_listener()
        .context("the socket is already being served")?;
    let server = tokio::spawn(server::accept_loop(
        listener,
        core.clone(),
        core.shutdown_requested(),
    ));
    let relay_send = serve_relay_send(&core);
    let watcher = tokio::spawn(crate::relay::local_methods::watch(core.clone()));
    let upload_watcher = tokio::spawn(crate::relay::local_methods::watch_uploads(core.clone()));
    let sweep = tokio::spawn(files::store::sweeper(core.config.app_data_dir.clone()));

    tokio::spawn(crate::relay::trusted::keep_members_current(core.clone()));
    let _ = stopping.wait_for(|stop| *stop).await;

    if let Some(relay_send) = relay_send {
        relay_send.stop().await;
    }
    watcher.abort();
    upload_watcher.abort();
    sweep.abort();
    if let Some(account) = account {
        account.abort();
    }
    if let Some(account) = &core.plugins.account {
        account.shutdown().await;
    }
    // Work in progress settles before the core stops: an injection is
    // recorded and acknowledged (or a restart would inject it again), a
    // registration is saved or removed, and an answer claimed is sent.
    let settled = async {
        let _ = delivery.await;
        core.deliveries_stopped().await;
        let _ = replies.await;
    };
    if tokio::time::timeout(Duration::from_secs(10), settled)
        .await
        .is_err()
    {
        core.hub.activity(
            Level::Warning,
            "Stopped before a delivery or automatic answer settled.",
        );
    }
    core.stop().await;
    refresher.abort();
    signal_watch.abort();
    // Connections flush the shutdown event and close; give them a moment.
    let _ = tokio::time::timeout(Duration::from_secs(1), server).await;
    pump.abort();
    drop(socket);
    Ok(())
}

/// Serves the relay-send socket when the core is built with one; a socket
/// another app already serves is left to it, and said so.
fn serve_relay_send(core: &Arc<Core>) -> Option<RelaySocket> {
    let relay_send = core.plugins.relay_send.as_ref()?;
    let outbound = Arc::new(Outbound::new(
        core.clone(),
        relay_send.direct_delivery.clone(),
    ));
    if relay_send.agent_led_defaults_at_start {
        let setup = outbound.clone();
        tokio::spawn(async move { setup.setup().apply_defaults().await });
    }
    match RelaySocket::start(
        outbound,
        &relay_send.socket,
        &relay_send.pointer,
        relay_send.serving.clone(),
    ) {
        Ok(socket) => Some(socket),
        Err(message) => {
            core.hub.activity(Level::Warning, message);
            None
        }
    }
}

async fn refresh_loop(core: Arc<Core>) {
    let mut ticks = tokio::time::interval(core.config.rediscover_every);
    // A slow verification delays the next refresh rather than queueing
    // missed ticks to fire back to back.
    ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        ticks.tick().await;
        // The workspace, then the hosted MCP links that pick reply hints.
        core.refresh_pass().await;
        // A tool installed since the last pass gets its integration default.
        let defaults = core.clone();
        let _ = tokio::task::spawn_blocking(move || defaults.apply_integration_defaults()).await;
    }
}

/// SIGTERM and SIGINT, registered before the socket exists so neither can
/// arrive while the default disposition would kill the daemon uncleanly.
#[cfg(unix)]
pub struct StopSignals {
    terminate: tokio::signal::unix::Signal,
    interrupt: tokio::signal::unix::Signal,
}

#[cfg(unix)]
impl StopSignals {
    /// Must run inside the runtime.
    fn register() -> Option<StopSignals> {
        use tokio::signal::unix::{signal, SignalKind};
        Some(StopSignals {
            terminate: signal(SignalKind::terminate()).ok()?,
            interrupt: signal(SignalKind::interrupt()).ok()?,
        })
    }

    async fn recv(&mut self) {
        tokio::select! {
            _ = self.terminate.recv() => {}
            _ = self.interrupt.recv() => {}
        }
    }
}

/// Windows' console events, registered before the pipe exists: Ctrl-C and
/// Ctrl-Break in a terminal, the console window closing, and the system
/// shutting down. For the last two tokio holds the process open while the
/// core stops, until Windows' own deadline.
#[cfg(windows)]
pub struct StopSignals {
    interrupt: tokio::signal::windows::CtrlC,
    interrupt_break: tokio::signal::windows::CtrlBreak,
    close: tokio::signal::windows::CtrlClose,
    shutdown: tokio::signal::windows::CtrlShutdown,
}

#[cfg(windows)]
impl StopSignals {
    /// Must run inside the runtime.
    fn register() -> Option<StopSignals> {
        use tokio::signal::windows::{ctrl_break, ctrl_c, ctrl_close, ctrl_shutdown};
        Some(StopSignals {
            interrupt: ctrl_c().ok()?,
            interrupt_break: ctrl_break().ok()?,
            close: ctrl_close().ok()?,
            shutdown: ctrl_shutdown().ok()?,
        })
    }

    async fn recv(&mut self) {
        tokio::select! {
            _ = self.interrupt.recv() => {}
            _ = self.interrupt_break.recv() => {}
            _ = self.close.recv() => {}
            _ = self.shutdown.recv() => {}
        }
    }
}

async fn stop_on_signals(core: Arc<Core>, signals: Option<StopSignals>) {
    let Some(mut signals) = signals else { return };
    signals.recv().await;
    core.request_shutdown();
}

/// A hosting app holds the daemon's stdin; its closing (the app quit or
/// crashed) stops the daemon.
fn watch_stdin(core: Arc<Core>) {
    std::thread::Builder::new()
        .name("relay-core-stdin".into())
        .spawn(move || {
            use std::io::Read;
            let mut buffer = [0u8; 256];
            let mut stdin = std::io::stdin();
            while matches!(stdin.read(&mut buffer), Ok(read) if read > 0) {}
            core.request_shutdown();
        })
        .expect("spawn the stdin watcher");
}

/// Only a core explicitly started for Connect may retire itself. A signed-in
/// account or ordinary relay registration permanently adopts the core.
fn watch_connect_idle(core: Arc<Core>) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(5)).await;
            if core.stopping() {
                return;
            }
            let shared = core.plugins.cloud.account().is_some()
                || core.store.read(|store| !store.registrations.is_empty());
            let active = !core.connect.lock().unwrap().sessions.is_empty();
            if core
                .connect_lifetime
                .retire_if_idle(active, shared, std::time::Instant::now())
            {
                core.request_shutdown();
                return;
            }
        }
    });
}

fn cleanup_gui_autostart(
    options: &ServeOptions,
    home: &Path,
    env: &BTreeMap<String, String>,
) -> Option<std::io::Result<bool>> {
    (options.headless && !options.connect_ephemeral)
        .then(|| crate::relay::login_item::remove_gui_autostart(home, env))
}
#[cfg(test)]
mod connect_startup_tests {
    use super::*;
    #[test]
    fn ephemeral_run_preserves_desktop_login_entry() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join(".config/autostart/agent-relay.desktop");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "desktop preference").unwrap();
        let options = ServeOptions {
            socket: None,
            app_data_dir: None,
            exit_on_stdin_eof: false,
            site_url: None,
            headless: true,
            connect_ephemeral: true,
        };
        assert!(cleanup_gui_autostart(&options, home.path(), &BTreeMap::new()).is_none());
        assert_eq!(fs::read_to_string(path).unwrap(), "desktop preference");
    }
}

#[cfg(test)]
mod key_migration_tests {
    use super::*;
    use crate::relay::store::{PendingKeyMigration, SessionKind, Target};

    fn test_core(home: &Path) -> Arc<Core> {
        let config = Config {
            paths: CorePaths::for_socket(home.join("core.sock")).unwrap(),
            home: home.into(),
            app_data_dir: home.join("app-data"),
            env: BTreeMap::new(),
            version: "0.0.0-test".into(),
            host_name: "Test Desk.local".into(),
            rediscover_every: Duration::from_secs(3600),
            push_timing: PushTiming::default(),
            delivery_timing: DeliveryTiming::default(),
        };
        Core::new(config).0
    }

    fn workspace(key: &str) -> Workspace {
        Workspace {
            key: Secret::new(key),
            base_url: "https://cast.test".into(),
            workspace_id: None,
        }
    }

    fn registration(name: &str, key: &str) -> Registration {
        Registration {
            name: name.into(),
            agent_id: format!("agent-{name}"),
            // Distinct session per registration: a merge keeps only one
            // registration per target.
            target: Target::new(SessionKind::Codex, format!("ses_{name}")),
            title: name.into(),
            base_url: "https://cast.test".into(),
            registered_at: "2026-10-01T12:00:00Z".into(),
            workspace_key: Some(Secret::new(key)),
            machine_prefix: None,
            added_by_session: Some(false),
            auto_activated: None,
            missing_since: None,
            archived_at: None,
            webhook: None,
            reply_with_final_answer: None,
            integration_channel_id: None,
            integration_channel_name: None,
            integrations: None,
            route_binding: None,
            spawn: None,
            mcp: None,
            alias: None,
            retired_aliases: None,
            cleared: None,
        }
    }

    // A failed verify used to drop the displaced key and id with the refresh,
    // so the saved copies pinned to the superseded key could never follow the
    // rotation. The record is persisted before the network call and survives
    // the failure — the next successful verify resolves it.
    #[test]
    fn a_failed_verification_keeps_the_pending_key_migration() {
        let temp = tempfile::tempdir().unwrap();
        let core = test_core(temp.path());
        core.store
            .update(|store| {
                store
                    .registrations
                    .push(registration("agent-a", "rk_live_old"))
            })
            .unwrap();

        // The rotated key is attached (the refresh's local half already ran);
        // the displaced one had verified to rw_one.
        *core.workspace.lock().unwrap() = Some(workspace("rk_live_new"));
        core.record_pending_key_migration(Some(&workspace("rk_live_old")), Some("rw_one"));

        let pending = core
            .store
            .read(|store| store.pending_key_migrations.clone())
            .unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].old_key, Secret::new("rk_live_old"));
        assert_eq!(pending[0].workspace_id, "rw_one");

        // The verify this refresh was about to make failed: nothing ran, the
        // record stays. A later refresh verifies the replacement to the same
        // workspace — the saved copy follows it now.
        core.resolve_pending_key_migration(Some("rw_one"));
        assert!(core
            .store
            .read(|store| store.pending_key_migrations.is_none()));
        assert_eq!(
            core.store
                .read(|store| store.registrations[0].workspace_key.clone()),
            Some(Secret::new("rk_live_new"))
        );
    }

    // A new key verifying to a different workspace id is a workspace switch:
    // the saved copies for the old workspace stay as they were — they still
    // owe their own workspace — and the record stays owed until a key
    // verifies to THAT workspace again. Dropping it on the switch would
    // strand the copies permanently.
    #[test]
    fn a_workspace_switch_keeps_the_debt_without_rewriting() {
        let temp = tempfile::tempdir().unwrap();
        let core = test_core(temp.path());
        core.store
            .update(|store| {
                store
                    .registrations
                    .push(registration("agent-a", "rk_live_old"))
            })
            .unwrap();
        *core.workspace.lock().unwrap() = Some(workspace("rk_live_new"));
        core.record_pending_key_migration(Some(&workspace("rk_live_old")), Some("rw_one"));
        assert!(core
            .store
            .read(|store| store.pending_key_migrations.is_some()));

        core.resolve_pending_key_migration(Some("rw_two"));

        assert!(core
            .store
            .read(|store| store.pending_key_migrations.is_some()));
        assert_eq!(
            core.store
                .read(|store| store.registrations[0].workspace_key.clone()),
            Some(Secret::new("rk_live_old"))
        );

        // Back on the debt's workspace: the record still resolves.
        core.resolve_pending_key_migration(Some("rw_one"));
        assert!(core
            .store
            .read(|store| store.pending_key_migrations.is_none()));
        assert_eq!(
            core.store
                .read(|store| store.registrations[0].workspace_key.clone()),
            Some(Secret::new("rk_live_new"))
        );
    }

    // Signed out while the migration was still owed: the record stays until
    // a sign-in produces a verified answer for it.
    #[test]
    fn sign_out_keeps_the_pending_key_migration() {
        let temp = tempfile::tempdir().unwrap();
        let core = test_core(temp.path());
        *core.workspace.lock().unwrap() = Some(workspace("rk_live_new"));
        core.record_pending_key_migration(Some(&workspace("rk_live_old")), Some("rw_one"));
        assert!(core
            .store
            .read(|store| store.pending_key_migrations.is_some()));

        *core.workspace.lock().unwrap() = None;
        core.resolve_pending_key_migration(Some("rw_one"));

        assert!(core
            .store
            .read(|store| store.pending_key_migrations.is_some()));
    }

    // Regression for review finding: the record's save failing must not lose
    // the displaced key's context — `remember` keeps it in the in-memory
    // store, the same verify resolves it once storage recovers, and an
    // unchanged refresh's resolve path is enough.
    // Read-only directories by mode bits, which Windows does not have.
    #[cfg(unix)]
    #[test]
    fn a_failed_record_save_still_resolves_once_storage_recovers() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let core = test_core(temp.path());
        core.store
            .update(|store| {
                store
                    .registrations
                    .push(registration("agent-a", "rk_live_old"))
            })
            .unwrap();
        *core.workspace.lock().unwrap() = Some(workspace("rk_live_new"));

        // The store directory goes read-only: every save fails until it
        // recovers.
        let app_data = temp.path().join("app-data");
        fs::set_permissions(&app_data, fs::Permissions::from_mode(0o555)).unwrap();
        core.record_pending_key_migration(Some(&workspace("rk_live_old")), Some("rw_one"));

        // Nothing reached disk, but the record is still in the live store —
        // the displaced key's context survived the failed save.
        let store_path = app_data.join(app_store::STORE_FILE);
        assert!(
            !store_path.exists() || {
                let on_disk: serde_json::Value =
                    serde_json::from_slice(&fs::read(&store_path).unwrap()).unwrap();
                on_disk["pendingKeyMigrations"].is_null()
            }
        );
        assert!(core
            .store
            .read(|store| store.pending_key_migrations.is_some()));

        // The resolve attempt while storage is still down keeps the debt.
        core.resolve_pending_key_migration(Some("rw_one"));
        assert_eq!(
            core.store
                .read(|store| store.registrations[0].workspace_key.clone()),
            Some(Secret::new("rk_live_old"))
        );

        // Storage recovers: the unchanged-refresh resolve migrates the copy.
        fs::set_permissions(&app_data, fs::Permissions::from_mode(0o755)).unwrap();
        core.resolve_pending_key_migration(Some("rw_one"));
        assert_eq!(
            core.store
                .read(|store| store.registrations[0].workspace_key.clone()),
            Some(Secret::new("rk_live_new"))
        );
        assert!(core
            .store
            .read(|store| store.pending_key_migrations.is_none()));
    }

    // Regression for review finding: A→B that could not save leaves A owed;
    // B→C must ADD B's record, not overwrite A's — both sources' saved
    // copies follow C once it verifies to the workspace.
    #[test]
    fn a_second_rotation_preserves_an_unfinished_earlier_one() {
        let temp = tempfile::tempdir().unwrap();
        let core = test_core(temp.path());
        core.store
            .update(|store| {
                store
                    .registrations
                    .push(registration("agent-a", "rk_live_a"));
                store
                    .registrations
                    .push(registration("agent-b", "rk_live_b"));
            })
            .unwrap();

        // A→B verified but its rewrite never saved: the record is still owed.
        core.store
            .update(|store| {
                store.record_pending_key_migration(PendingKeyMigration {
                    base_url: "https://cast.test".into(),
                    old_key: Secret::new("rk_live_a"),
                    workspace_id: "rw_one".into(),
                });
            })
            .unwrap();

        // B→C: the record for the displaced B lands ALONGSIDE the owed A.
        *core.workspace.lock().unwrap() = Some(workspace("rk_live_c"));
        core.record_pending_key_migration(Some(&workspace("rk_live_b")), Some("rw_one"));

        let pending = core
            .store
            .read(|store| store.pending_key_migrations.clone())
            .unwrap();
        assert_eq!(pending.len(), 2);
        assert!(pending
            .iter()
            .any(|m| m.old_key == Secret::new("rk_live_a")));
        assert!(pending
            .iter()
            .any(|m| m.old_key == Secret::new("rk_live_b")));

        // C verifies to the same workspace: both owed sources migrate.
        core.resolve_pending_key_migration(Some("rw_one"));
        assert!(core
            .store
            .read(|store| store.pending_key_migrations.is_none()));
        let keys = core.store.read(|store| {
            store
                .registrations
                .iter()
                .map(|r| r.workspace_key.clone())
                .collect::<Vec<_>>()
        });
        assert_eq!(
            keys,
            vec![
                Some(Secret::new("rk_live_c")),
                Some(Secret::new("rk_live_c"))
            ]
        );
    }
}

#[cfg(test)]
#[path = "workspace_recovery_tests.rs"]
mod workspace_recovery_tests;
