//! What the core is built with beyond its configuration.

use crate::relay::admission::Admission;
use crate::relay::agents::SettingsExtension;
use crate::relay::client::WorkspaceInfo;
use crate::relay::cloud_session::{CloudAccess, SignedOut};
use crate::relay::connect::{CloudJoinClient, ConnectJoinClient};
use crate::relay::contract::spawn_control::{
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
/// `spawn.release`) that are not session registrations. A service caller is
/// whoever its bridge connection authenticated as: the plugin owns the
/// challenge, the binding and its teardown (usually through a
/// [`MethodExtension`] whose `connection_closed` retires the connection's
/// slot and binding), and the core only asks it how a connection resolves.
/// A connection the plugin does not know takes the session path exactly as
/// without the plugin. No caller credential ever reaches the core: a
/// `spawn.*` params object carrying `caller_secret` is refused
/// `legacy_credential_refused` before it is read, with or without the
/// plugin. An unsupported internal seam, like [`SessionPolicy`].
///
/// The core never stores, lists or provisions such callers; the plugin owns
/// their records, limits and audit.
pub trait SpawnCallers: Send + Sync + 'static {
    /// How the bridge connection `context` describes resolves: not a
    /// service caller (the session path), bound to one, or refused with the
    /// class the plugin's state gives (`caller_unbound` after a challenge,
    /// `auth_locked`, `binding_stale`, `connection_closed`). Called once,
    /// before a `spawn.*` call's params are read, and never for a call
    /// without a `connection_id` (the core's own calls, always the session
    /// path). A session call is resolved again just before its side effect:
    /// a connection that turned external meanwhile is refused
    /// `caller_unbound`. Must return promptly and not block on I/O.
    fn connection(&self, context: &CallContext) -> ConnectionCaller;
    /// Admits `call` before its Relaycast request (rate, live-agent cap,
    /// ledger), or refuses it, in which case nothing is sent. The permit
    /// comes back to [`SpawnCallers::record`]; a call that is dropped before
    /// it finishes drops the permit instead.
    fn admit(&self, caller: &ExternalCaller, call: &SpawnCall<'_>) -> Result<Permit, RpcError>;
    /// What became of an admitted call, success or refusal (audit, ledger).
    /// `outcome` is the exact answer the caller gets: a success is the
    /// authoritative receipt, the same value the core writes back, so the
    /// plugin persists that and nothing it derives.
    ///
    /// The receipt is gated on it: when this fails after a successful call,
    /// the caller gets this error instead of the receipt. The Relaycast side
    /// effect has happened, so return a retryable error (`store_failed`,
    /// say): the same request again, with the same `idempotency_key` for
    /// invoke and release, replays the invocation and recovers its receipt.
    /// A failure after a refused call changes nothing; the refusal stands.
    fn record(
        &self,
        permit: Permit,
        outcome: &Result<SpawnControlInvocation, RpcError>,
    ) -> Result<(), RpcError>;
}

/// How [`SpawnCallers::connection`] resolves a bridge connection.
#[derive(Clone, Debug)]
pub enum ConnectionCaller {
    /// Not a service caller connection: the session path, unchanged.
    NotExternal,
    /// Bound to this service caller, with its generation and scope current.
    Bound(ExternalCaller),
    /// Known to the plugin but not usable for a call; answered as is.
    Refused(RpcError),
}

/// A caller [`SpawnCallers::connection`] found bound: a Relaycast agent whose
/// token stays in the core, and the bounds it acts within.
#[derive(Clone, Debug)]
pub struct ExternalCaller {
    /// Its immutable Relaycast agent id; release claims are keyed by it.
    pub agent_id: String,
    pub name: String,
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
/// [`SpawnCallers::admit`] sees it. The parameters never carry a caller
/// credential.
#[derive(Clone, Copy, Debug)]
pub struct SpawnCall<'a> {
    /// The bridge client's process, when the platform reports it.
    pub peer_pid: Option<i32>,
    /// The bridge connection the caller is bound on.
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
    ///
    /// No handler is ever cancelled, this one or a built-in one: a call
    /// admitted before [`MethodExtension::connection_closed`] fired quiesces
    /// and records normally, possibly after that hook ran. Its answer is
    /// still written while the client's write side is open, and discarded
    /// once a write to the client failed. A call of the connection queued
    /// behind it is never made after the hook: it fails before entering the
    /// extension.
    fn call<'a>(
        &'a self,
        core: &'a Arc<Core>,
        context: &'a CallContext,
        method: &'a str,
        raw: Value,
    ) -> BoxFuture<'a, Option<Result<Value, RpcError>>>;

    /// The bridge connection described by `context` ended. Implementations
    /// must return promptly and must not assume the client sent a final RPC.
    ///
    /// This is the transport's request-side teardown barrier. A read EOF or
    /// half-close means no new requests will be accepted; the write side may
    /// stay open long enough to return the in-flight answer and the
    /// permitted queued answers. An admitted extension handler quiesces and
    /// records normally; queued extension calls see the closed marker and
    /// fail before entering the extension; built-in calls drain; a writer
    /// failure discards answers. The callback fires exactly once per
    /// connection, promptly from the transport, even while one of its calls
    /// (a long poll, say) is in flight: implementations should use it to
    /// wake such waiting calls. It also fires when the client sends more
    /// than the connection reads ahead during a call (32 lines or 1 MiB),
    /// sends a line over the frame limit, or the core stops. Memory is
    /// bounded (32 lines / the byte limit), responses stay ordered, and no
    /// handler is ever cancelled.
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
    /// Native spawn control callers that are not session registrations;
    /// without it every bridge connection takes the session path.
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

        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let closed = Arc::new(std::sync::Mutex::new(Vec::new()));
        let (home, core) = test_core_with_plugins(Plugins {
            extensions: vec![Arc::new(Witness {
                calls: seen.clone(),
                closed: closed.clone(),
            })],
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
        assert_eq!(
            *closed.lock().unwrap(),
            [CallContext {
                peer_pid: Some(std::process::id() as i32),
                connection_id: Some(1),
            }]
        );

        drop(lines_two);
        drop(write_two);
        wait_for_closed(&closed, 2).await;
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
