//! What the core is built with beyond its configuration.

use crate::relay::admission::Admission;
use crate::relay::agents::SettingsExtension;
use crate::relay::client::WorkspaceInfo;
use crate::relay::cloud_session::{CloudAccess, SignedOut};
use crate::relay::connect::{CloudJoinClient, ConnectJoinClient};
use crate::relay::contract::spawn_control::{
    SpawnCallerAuthenticateParams, SpawnCallerAuthenticated, SpawnCallerChallenge,
    SpawnControlInvocation, SpawnInvocationParams, SpawnInvokeParams, SpawnReleaseParams,
};
use crate::relay::contract::{self, MethodSpec};
use crate::relay::daemon::Core;
use crate::relay::inject::{Injector, NoInjector};
use crate::relay::outbound::{Outbound, OutboundError, RelaySend, Request};
use crate::relay::protocol::RpcError;
use crate::relay::sessions::{NoSessions, SessionDirectory};
use crate::relay::store::Target as SessionTarget;
use crate::relay::usage::UsageEvent;
use crate::relay::workspace::{Secret, Workspace};
use futures_util::future::BoxFuture;
use serde_json::Value;
use std::collections::{BTreeSet, HashSet};
use std::path::PathBuf;
use std::sync::Arc;

/// The signed-in account a build of the core may carry: sign-in and Cloud
/// maintenance. An unsupported internal seam, like
/// [`MethodExtension`]. A core without one works from its workspace key.
pub trait AccountPlugin: Send + Sync + 'static {
    /// Connects the account to its core, once.
    fn attach(&self, core: &Arc<Core>);
    /// Supervises the account until the daemon stops.
    fn run(&self) -> BoxFuture<'static, ()>;
    /// Stops what the account runs when the daemon stops.
    fn shutdown(&self) -> BoxFuture<'_, ()>;
    /// `account.status`'s answer.
    fn report(&self) -> Value;
    /// The periodic pass after the workspace refresh.
    fn maintain(&self) -> BoxFuture<'_, ()>;
    /// A replacement for a workspace key Relaycast refused.
    fn recover_workspace_key<'a>(
        &'a self,
        refused: &'a Workspace,
        workspace_id: &'a str,
    ) -> BoxFuture<'a, Option<(Workspace, WorkspaceInfo)>>;
    /// The agents or the sign-in changed.
    fn agents_changed(&self, core: &Arc<Core>);
    /// When a hosted MCP session linked itself to this agent, as Cloud last
    /// reported it.
    fn mcp_linked_at(&self, agent_id: &str) -> Option<String>;
    /// The identity sync state `/setup/status` reports.
    fn cloud_identity_sync(&self, core: &Core) -> Value;
    /// Refreshes what the account set up for this computer's tools, and
    /// says what went wrong. Runs off the async threads.
    fn refresh_tools(&self, core: &Core) -> Vec<String>;
    /// Answers a session-socket hook route this account owns.
    fn session_route<'a>(
        &'a self,
        outbound: &'a Outbound,
        pid: i32,
        uid: u32,
        request: &'a Request,
    ) -> Option<BoxFuture<'a, Result<Value, OutboundError>>>;
    /// The site this account signs in to: the one the build is made for
    /// (`links::built_in_site_url`), which nothing at run time changes.
    fn site_url(&self) -> String;
    /// Takes a usage report of the core's own operations.
    fn record_usage(&self, event: UsageEvent);
    /// The person changed these settings through `settings.set`; agents'
    /// changes do not reach here.
    fn person_changed_settings(&self, changes: &serde_json::Map<String, Value>);
    /// Whether sessions join the relay by themselves until the person turns
    /// it off: the desktop app's default. A core without such an account
    /// (the CLI's) leaves `auto_activate` unset, so only the kinds that join
    /// by default do. An explicit Off is always kept.
    fn auto_activate_by_default(&self) -> bool {
        false
    }
    /// The concrete account, for the build that made it.
    fn as_any(self: Arc<Self>) -> Arc<dyn std::any::Any + Send + Sync>;
}

/// Which sessions may do what on their own: join the relay, be asked to
/// join, say what they are doing. A build of the core may carry one; without
/// it every discovered session may join by itself, none is asked to join,
/// and none publishes its activity. An unsupported internal seam, like
/// [`AccountPlugin`].
pub trait SessionPolicy: Send + Sync + 'static {
    /// Which of `targets` may join the relay by themselves.
    fn admitted<'a>(
        &'a self,
        core: &'a Core,
        targets: Vec<SessionTarget>,
    ) -> BoxFuture<'a, Admission>;
    /// Whether the SessionStart hook may ask a chat that is not on the relay
    /// to join, or `None` when the policy cannot say yet.
    fn may_ask_to_join(&self) -> Option<bool>;
    /// Which of `targets` may publish what they are doing to the workspace.
    fn publishes_activity(&self, targets: &[SessionTarget]) -> HashSet<SessionTarget>;
    /// The activity line for agents that joined by themselves and leave
    /// because `/clear` moved them to a conversation this policy does not
    /// admit, or `None` to say nothing. `agents` is never empty.
    fn leaving_after_clear(&self, agents: &[String]) -> Option<String>;
}

/// Callers of the native spawn controls (`spawn.invoke`, `spawn.status`,
/// `spawn.release`) that are not session registrations. They authenticate
/// once per bridge connection through a one-use challenge; their reusable
/// secret never enters the bridge wire. An unsupported internal seam, like
/// [`SessionPolicy`].
///
/// The core never stores, lists or provisions such callers; the plugin owns
/// their records, limits and audit.
pub trait SpawnCallers: Send + Sync + 'static {
    /// Starts a fresh, short-lived proof for `name`, bound internally to this
    /// exact server-issued `connection_id`, caller and workspace.
    fn challenge(
        &self,
        workspace: &Workspace,
        connection_id: u64,
        name: &str,
    ) -> Result<SpawnCallerChallenge, RpcError>;
    /// Atomically consumes and verifies a challenge on the same connection.
    /// Reuse, expiry, substitution and concurrent double-submit are refused.
    fn authenticate(
        &self,
        workspace: &Workspace,
        connection_id: u64,
        params: &SpawnCallerAuthenticateParams,
    ) -> Result<SpawnCallerAuthenticated, RpcError>;
    /// Resolves the caller on every operation. A known external name that is
    /// unbound, stale, disabled, expired or revoked must return `Refused` and
    /// never fall through to a same-named session registration.
    fn resolve(
        &self,
        workspace: &Workspace,
        connection_id: Option<u64>,
        name: &str,
    ) -> SpawnCallerResolution;
    /// Admits `call` before its Relaycast request (rate, live-agent cap,
    /// ledger), or refuses it, in which case nothing is sent. The permit
    /// comes back to [`SpawnCallers::record`]; a call that is dropped before
    /// it finishes drops the permit instead. Implementations must recheck
    /// `caller.authority_generation` immediately before returning a permit so
    /// rotation, disable or revocation wins before any downstream side effect.
    fn admit(&self, caller: &ExternalCaller, call: &SpawnCall<'_>) -> Result<Permit, RpcError>;
    /// What became of an admitted call, success or refusal (audit, ledger).
    fn record(&self, permit: Permit, outcome: &Result<SpawnControlInvocation, RpcError>);
    /// Invalidates the binding and every outstanding challenge for this
    /// connection. Implementations coordinate this with their inbox/lease
    /// ownership before returning.
    fn connection_closed(&self, connection_id: u64);
}

/// The required tri-state lookup for a spawn-control name. `Refused` is
/// deliberately a value instead of an optional miss so a registered external
/// name cannot fall through to a same-named legacy session caller.
#[derive(Debug)]
pub enum SpawnCallerResolution {
    NotExternal,
    BoundExternal(ExternalCaller),
    Refused(RpcError),
}

/// A caller [`SpawnCallers::resolve`] vouches for: a Relaycast agent whose
/// token stays in the core, and the bounds it acts within.
#[derive(Clone, Debug)]
pub struct ExternalCaller {
    /// Its immutable Relaycast agent id; release claims are keyed by it.
    pub agent_id: String,
    pub name: String,
    /// The authority version this binding proved. `resolve` and `admit`
    /// recheck it on every operation so rotation, disable or revocation takes
    /// effect before the next side effect.
    pub authority_generation: u64,
    /// Its Relaycast agent token, sent to Relaycast and nowhere else.
    pub token: Secret,
    /// The harnesses it may spawn; `None` leaves only the node's own check.
    pub harnesses: Option<Vec<String>>,
    /// The folders it may spawn in (after canonicalisation); `None` leaves
    /// only the node's own check.
    pub directory_roots: Option<Vec<PathBuf>>,
    /// Whether it may release only agents whose recorded requester is it.
    pub owns_only: bool,
}

/// One native spawn control call by an [`ExternalCaller`], as
/// [`SpawnCallers::admit`] sees it. The parameters never carry the caller's
/// secret.
#[derive(Clone, Copy, Debug)]
pub struct SpawnCall<'a> {
    /// The bridge client's process, when the platform reports it.
    pub peer_pid: Option<i32>,
    /// The exact server-issued connection identity. It is internal provenance,
    /// never accepted from client params or forwarded to Relaycast.
    pub connection_id: Option<u64>,
    pub workspace: &'a Workspace,
    pub request: SpawnRequest<'a>,
}

/// Which spawn control is called, with its parameters.
#[derive(Clone, Copy, Debug)]
pub enum SpawnRequest<'a> {
    Invoke(&'a SpawnInvokeParams),
    Status(&'a SpawnInvocationParams),
    Release(&'a SpawnReleaseParams),
}

/// What [`SpawnCallers::admit`] hands back to [`SpawnCallers::record`]:
/// whatever the plugin needs, opaque to the core.
pub struct Permit(Box<dyn std::any::Any + Send + Sync>);

impl Permit {
    pub fn new<T: std::any::Any + Send + Sync>(value: T) -> Permit {
        Permit(Box::new(value))
    }

    /// The plugin's own value, or the permit back when it is another type.
    pub fn downcast<T: std::any::Any>(self) -> Result<Box<T>, Permit> {
        if self.0.is::<T>() {
            Ok(self.0.downcast::<T>().unwrap_or_else(|_| unreachable!()))
        } else {
            Err(self)
        }
    }
}

impl std::fmt::Debug for Permit {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Permit(..)")
    }
}

/// What the bridge knows about the client a method call came from. The
/// core's own calls (`server::call`) carry the default: no peer.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CallContext {
    /// The connected client's process, as the kernel reported it at
    /// connect; `None` where the platform does not report it or the call
    /// did not come over the bridge.
    pub peer_pid: Option<i32>,
    /// This bridge connection's core-lifetime identity. Calls made inside the
    /// core have none. Extensions use it only to retire connection-scoped
    /// resources when [`MethodExtension::connection_closed`] follows.
    pub connection_id: Option<u64>,
}

/// Extra bridge methods a build of the core adds. An unsupported internal
/// seam, not a public API: clients use the contract, and this can change
/// between commits. The server consults extensions last, after its handshake
/// and shutdown checks, so they get the same treatment as core methods.
pub trait MethodExtension: Send + Sync + 'static {
    /// The methods this extension answers, as `hello` and the generator read them.
    fn specs(&self) -> Vec<MethodSpec>;

    /// Answers `method`, or `None` when it is not this extension's.
    /// `context` says which client asked.
    fn call<'a>(
        &'a self,
        core: &'a Arc<Core>,
        context: &'a CallContext,
        method: &'a str,
        raw: Value,
    ) -> BoxFuture<'a, Option<Result<Value, RpcError>>>;

    /// The bridge connection described by `context` ended. Implementations
    /// must return promptly and must not assume the client sent a final RPC.
    fn connection_closed(&self, _context: &CallContext) {}
}

/// What the core is built with beyond its configuration: the session side
/// of delivery, discovery, Cloud access, extra settings, the account and the
/// session policy. Each defaults to an implementation that does nothing.
pub struct Plugins {
    pub injector: Arc<dyn Injector>,
    pub sessions: Arc<dyn SessionDirectory>,
    pub cloud: Arc<dyn CloudAccess>,
    /// Public Relay Connect join and invite-status access. It carries no
    /// account credential and is fakeable for socket-route tests.
    pub connect_cloud: Arc<dyn ConnectJoinClient>,
    pub settings: Vec<Arc<dyn SettingsExtension>>,
    /// Extra bridge methods. Their names may not repeat a core method's.
    pub extensions: Vec<Arc<dyn MethodExtension>>,
    /// The relay-send socket sessions reach the core through; not served
    /// when `None`.
    pub relay_send: Option<RelaySend>,
    /// Sign-in and telemetry; usually also `cloud` (`account::plugins`).
    pub account: Option<Arc<dyn AccountPlugin>>,
    /// Which sessions may join the relay, be asked to, and publish activity.
    pub session_policy: Option<Arc<dyn SessionPolicy>>,
    /// Native spawn control callers that are not session registrations.
    pub spawn_callers: Option<Arc<dyn SpawnCallers>>,
    /// Messages for Conductor's Codex chats that Agent Relay's Codex Stop
    /// hook collects (`POST /codex/stop-hook`); none without the hook.
    pub codex_stop_hook: Option<Arc<crate::relay::codex::stop_hook::StopHookInbox>>,
    /// Starts the agents Agent Relay spawns here (`relay::spawn`).
    pub spawner: Arc<dyn crate::relay::spawn::launch::Spawner>,
    /// The trusted senders for OpenClaw and Hermes, whose workspace people
    /// are read from Cloud; none where neither can be set up.
    pub trusted: Option<Arc<crate::relay::trusted::TrustedSettings>>,
    /// This computer's processes as the core's scans share them: discovery,
    /// liveness and Connect reply checks read one time-bounded snapshot
    /// (`process::ProcessSnapshot`) instead of each walking the table.
    pub processes: Arc<dyn crate::relay::process::ProcessTable>,
    /// The session-history library release this build carries, which
    /// `status.get` reports as `history_version`; none without one.
    pub history_version: Option<&'static str>,
}

impl Default for Plugins {
    fn default() -> Plugins {
        Plugins {
            injector: Arc::new(NoInjector),
            sessions: Arc::new(NoSessions),
            cloud: Arc::new(SignedOut),
            connect_cloud: Arc::new(CloudJoinClient),
            settings: Vec::new(),
            extensions: Vec::new(),
            relay_send: None,
            account: None,
            session_policy: None,
            spawn_callers: None,
            codex_stop_hook: None,
            spawner: Arc::new(crate::relay::spawn::launch::NoSpawner),
            trusted: None,
            processes: crate::relay::process::ProcessSnapshot::system(),
            history_version: None,
        }
    }
}

impl Plugins {
    /// Every method name this build adds. Panics when one repeats a core
    /// method or another extension's: an extension may never replace a method.
    pub(crate) fn extension_method_names(&self, with_account: bool) -> Vec<&'static str> {
        let mut seen: BTreeSet<&str> = contract::METHODS.iter().map(|spec| spec.name).collect();
        seen.extend(contract::CONNECTION_METHODS.iter().copied());
        let mut names = Vec::new();
        for spec in self
            .extensions
            .iter()
            .flat_map(|extension| extension.specs())
        {
            assert!(
                seen.insert(spec.name),
                "extension method {} repeats another method",
                spec.name
            );
            if with_account || spec.availability == contract::Availability::Always {
                names.push(spec.name);
            }
        }
        names
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::relay::contract::{answer, Availability, Done, Method, NoParams};
    use crate::relay::daemon::{Config, DeliveryTiming, PushTiming};
    use crate::relay::paths::CorePaths;
    use crate::relay::protocol::ErrorKind;
    use crate::relay::server;
    use serde_json::json;

    struct Ping;

    impl Method for Ping {
        const NAME: &'static str = "extension.ping";
        type Params = NoParams;
        type Result = Done;
    }

    struct Extension(&'static str, Availability);

    impl MethodExtension for Extension {
        fn specs(&self) -> Vec<MethodSpec> {
            let mut spec = MethodSpec::of::<Ping>(self.1);
            spec.name = self.0;
            vec![spec]
        }

        fn call<'a>(
            &'a self,
            _core: &'a Arc<Core>,
            _context: &'a CallContext,
            method: &'a str,
            raw: Value,
        ) -> BoxFuture<'a, Option<Result<Value, RpcError>>> {
            Box::pin(async move {
                if method != self.0 {
                    return None;
                }
                Some(answer::<Ping, _>(raw, |_| async { Ok(Done {}) }).await)
            })
        }
    }

    fn with(name: &'static str) -> Plugins {
        Plugins {
            extensions: vec![Arc::new(Extension(name, Availability::Always))],
            ..Plugins::default()
        }
    }

    fn test_core_with_plugins(plugins: Plugins) -> (tempfile::TempDir, Arc<Core>) {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let config = Config {
            paths: CorePaths::for_socket(home.join("core.sock")).unwrap(),
            home: home.into(),
            app_data_dir: home.join("app-data"),
            env: Default::default(),
            version: "test".into(),
            host_name: "Test Desk.local".into(),
            rediscover_every: std::time::Duration::from_secs(3600),
            push_timing: PushTiming::default(),
            delivery_timing: DeliveryTiming::default(),
        };
        (temp, Core::with_plugins(config, plugins).0)
    }

    #[tokio::test]
    async fn an_extension_answers_its_method_and_hello_lists_it() {
        let (_home, core) = test_core_with_plugins(with("extension.ping"));
        assert!(server::all_method_names(&core).contains(&"extension.ping"));
        let answer = server::call(&core, "extension.ping", json!({})).await;
        assert_eq!(answer.unwrap(), json!({}));
    }

    #[tokio::test]
    async fn an_account_extension_method_is_not_answered_without_an_account() {
        let (_home, core) = test_core_with_plugins(Plugins {
            extensions: vec![Arc::new(Extension("extension.ping", Availability::Account))],
            ..Plugins::default()
        });
        assert!(!server::all_method_names(&core).contains(&"extension.ping"));
        let answer = server::call(&core, "extension.ping", json!({})).await;
        assert_eq!(answer.unwrap_err().data.kind, ErrorKind::MethodNotFound);
    }

    #[tokio::test]
    async fn a_core_without_the_extension_says_it_has_no_such_method() {
        let (_home, core) = test_core_with_plugins(Plugins::default());
        let answer = server::call(&core, "extension.ping", json!({})).await;
        assert_eq!(answer.unwrap_err().data.kind, ErrorKind::MethodNotFound);
    }

    /// Answers `extension.ping` and keeps the context each call carried.
    struct Witness {
        calls: Arc<std::sync::Mutex<Vec<CallContext>>>,
        closed: Arc<std::sync::Mutex<Vec<CallContext>>>,
    }

    impl MethodExtension for Witness {
        fn specs(&self) -> Vec<MethodSpec> {
            vec![MethodSpec::of::<Ping>(Availability::Always)]
        }

        fn call<'a>(
            &'a self,
            _core: &'a Arc<Core>,
            context: &'a CallContext,
            method: &'a str,
            raw: Value,
        ) -> BoxFuture<'a, Option<Result<Value, RpcError>>> {
            Box::pin(async move {
                if method != Ping::NAME {
                    return None;
                }
                self.calls.lock().unwrap().push(*context);
                Some(answer::<Ping, _>(raw, |_| async { Ok(Done {}) }).await)
            })
        }

        fn connection_closed(&self, context: &CallContext) {
            self.closed.lock().unwrap().push(*context);
        }
    }

    /// Records the connection teardown hook that owns caller bindings.
    struct CallerWitness {
        closed: Arc<std::sync::Mutex<Vec<u64>>>,
    }

    impl SpawnCallers for CallerWitness {
        fn challenge(
            &self,
            _workspace: &Workspace,
            _connection_id: u64,
            _name: &str,
        ) -> Result<SpawnCallerChallenge, RpcError> {
            Err(RpcError::new(ErrorKind::Internal, "unused in this test"))
        }

        fn authenticate(
            &self,
            _workspace: &Workspace,
            _connection_id: u64,
            _params: &SpawnCallerAuthenticateParams,
        ) -> Result<SpawnCallerAuthenticated, RpcError> {
            Err(RpcError::new(ErrorKind::Internal, "unused in this test"))
        }

        fn resolve(
            &self,
            _workspace: &Workspace,
            _connection_id: Option<u64>,
            _name: &str,
        ) -> SpawnCallerResolution {
            SpawnCallerResolution::NotExternal
        }

        fn admit(
            &self,
            _caller: &ExternalCaller,
            _call: &SpawnCall<'_>,
        ) -> Result<Permit, RpcError> {
            Err(RpcError::new(ErrorKind::Internal, "unused in this test"))
        }

        fn record(&self, _permit: Permit, _outcome: &Result<SpawnControlInvocation, RpcError>) {}

        fn connection_closed(&self, connection_id: u64) {
            self.closed.lock().unwrap().push(connection_id);
        }
    }

    #[tokio::test]
    async fn peer_pid_reaches_extensions() {
        use crate::relay::protocol::BRIDGE_VERSION;
        use crate::relay::transport::{CoreListener, CoreStream};
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

        async fn wait_for_closed(
            closed: &Arc<std::sync::Mutex<Vec<CallContext>>>,
            expected: usize,
        ) {
            tokio::time::timeout(std::time::Duration::from_secs(2), async {
                loop {
                    if closed.lock().unwrap().len() == expected {
                        return;
                    }
                    tokio::task::yield_now().await;
                }
            })
            .await
            .expect("ordinary disconnects notify extensions before server shutdown");
        }

        async fn wait_for_caller_closed(closed: &Arc<std::sync::Mutex<Vec<u64>>>, expected: usize) {
            tokio::time::timeout(std::time::Duration::from_secs(2), async {
                loop {
                    if closed.lock().unwrap().len() == expected {
                        return;
                    }
                    tokio::task::yield_now().await;
                }
            })
            .await
            .expect("ordinary disconnects invalidate caller bindings before server shutdown");
        }

        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let closed = Arc::new(std::sync::Mutex::new(Vec::new()));
        let caller_closed = Arc::new(std::sync::Mutex::new(Vec::new()));
        let (home, core) = test_core_with_plugins(Plugins {
            extensions: vec![Arc::new(Witness {
                calls: seen.clone(),
                closed: closed.clone(),
            })],
            spawn_callers: Some(Arc::new(CallerWitness {
                closed: caller_closed.clone(),
            })),
            ..Plugins::default()
        });
        let socket = home.path().join("peer.sock");
        let listener = CoreListener::bind(&socket).unwrap();
        let (stop, stopped) = tokio::sync::watch::channel(false);
        let server = tokio::spawn(server::accept_loop(listener, core.clone(), stopped));
        let (read_one, mut write_one) = CoreStream::connect(&socket).await.unwrap().into_split();
        let mut lines_one = BufReader::new(read_one).lines();
        let (read_two, mut write_two) = CoreStream::connect(&socket).await.unwrap().into_split();
        let mut lines_two = BufReader::new(read_two).lines();
        for (write, lines) in [
            (&mut write_one, &mut lines_one),
            (&mut write_two, &mut lines_two),
        ] {
            for request in [
                json!({"jsonrpc":"2.0","id":1,"method":"hello","params":{"bridge_version": BRIDGE_VERSION}}),
                json!({"jsonrpc":"2.0","id":2,"method":"extension.ping","params":{}}),
            ] {
                write
                    .write_all(format!("{request}\n").as_bytes())
                    .await
                    .unwrap();
                let line = lines.next_line().await.unwrap().unwrap();
                let response: Value = serde_json::from_str(&line).unwrap();
                assert!(response.get("error").is_none(), "{response}");
            }
        }
        assert_eq!(
            *seen.lock().unwrap(),
            [
                CallContext {
                    peer_pid: Some(std::process::id() as i32),
                    connection_id: Some(1),
                },
                CallContext {
                    peer_pid: Some(std::process::id() as i32),
                    connection_id: Some(2),
                },
            ]
        );
        // The core's own calls come from no peer.
        server::call(&core, "extension.ping", json!({}))
            .await
            .unwrap();
        assert_eq!(seen.lock().unwrap()[2], CallContext::default());

        drop(lines_one);
        drop(write_one);
        wait_for_closed(&closed, 1).await;
        wait_for_caller_closed(&caller_closed, 1).await;
        assert_eq!(
            *closed.lock().unwrap(),
            [CallContext {
                peer_pid: Some(std::process::id() as i32),
                connection_id: Some(1),
            }]
        );
        assert_eq!(*caller_closed.lock().unwrap(), [1]);

        drop(lines_two);
        drop(write_two);
        wait_for_closed(&closed, 2).await;
        wait_for_caller_closed(&caller_closed, 2).await;
        assert_eq!(
            *closed.lock().unwrap(),
            [
                CallContext {
                    peer_pid: Some(std::process::id() as i32),
                    connection_id: Some(1),
                },
                CallContext {
                    peer_pid: Some(std::process::id() as i32),
                    connection_id: Some(2),
                },
            ]
        );
        assert_eq!(*caller_closed.lock().unwrap(), [1, 2]);

        stop.send(true).unwrap();
        server.await.unwrap();
    }

    #[test]
    #[should_panic(expected = "repeats another method")]
    fn an_extension_cannot_replace_a_core_method() {
        with("status.get").extension_method_names(true);
    }

    #[test]
    #[should_panic(expected = "repeats another method")]
    fn two_extensions_cannot_share_a_method() {
        let mut plugins = with("extension.ping");
        plugins
            .extensions
            .push(Arc::new(Extension("extension.ping", Availability::Always)));
        plugins.extension_method_names(true);
    }
}
