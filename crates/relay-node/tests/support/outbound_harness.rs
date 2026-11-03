// The relay-send socket harness `relay_outbound` includes.
use agent_relay_node::relay::connect::{
    ConnectAvailability, ConnectHost, ConnectJoinClient, JoinResponse, JoinedParticipant,
    Participant,
};
use agent_relay_node::relay::connect_presence::RosterEntry;
use agent_relay_node::relay::daemon::{self, BoundSocket, Config, Core, Plugins};
use agent_relay_node::relay::delivery::DeliveryTiming;
use agent_relay_node::relay::inject::InjectOutcome;
use agent_relay_node::relay::outbound::{
    self, Outbound, OutboundError, RelaySend, RelaySocket, Request, ServingPath,
};
use agent_relay_node::relay::paths::{self, CorePaths};
use agent_relay_node::relay::push::PushTiming;
use agent_relay_node::relay::sessions::UnreadableSessionFile;
use agent_relay_node::relay::setup::DirectDelivery;
use agent_relay_node::relay::state::Verification;
use agent_relay_node::relay::store::{SessionKind, Target};
use agent_relay_node::relay::workspace::Secret;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use support::bridge::{
    discovery_published, eventually, eventually_for, session, Client, FakeInjector, FakeSessions,
};
use support::fake_relaycast::{Behaviour, FakeRelaycast, WORKSPACE_KEY};

const CODEX: &str = "01a0c221-6806-7210-af25-97e104b15049";
const CLAUDE: &str = "727cce8d-8074-4ea3-94a0-dea144bf8747";
const CLOUD: &str = "session_01ABCDEFGHJKMNPQRSTVWXYZ01";
/// Pids the fake kernel places inside sessions.
const IN_CODEX: i32 = 4100;
const IN_CLAUDE: i32 = 4200;
const IN_CLOUD: i32 = 4300;
const OUTSIDE: i32 = 4900;

/// Claude Code's `crossSessionInbound`, in memory.
#[derive(Default)]
struct FakeDirect {
    user: Mutex<Option<String>>,
    managed: Mutex<Option<String>>,
    fail: Mutex<bool>,
}

impl DirectDelivery for FakeDirect {
    fn delivers_directly(&self) -> bool {
        let managed = self.managed.lock().unwrap().clone();
        managed
            .or_else(|| self.user.lock().unwrap().clone())
            .as_deref()
            == Some("accept")
    }

    fn managed_value(&self) -> Option<String> {
        self.managed.lock().unwrap().clone()
    }

    fn user_choice(&self) -> Option<String> {
        self.user.lock().unwrap().clone()
    }

    fn set_direct_delivery(&self, enabled: bool) -> Result<(), String> {
        if *self.fail.lock().unwrap() {
            return Err(
                "Your Claude settings file is not valid JSON, so it was left unchanged.".into(),
            );
        }
        *self.user.lock().unwrap() = enabled.then(|| "accept".to_string());
        Ok(())
    }
}

/// A controllable clock for the rate limit and the roster cache.
#[derive(Clone)]
struct Clock(Arc<Mutex<Instant>>);

impl Clock {
    fn new() -> Clock {
        Clock(Arc::new(Mutex::new(Instant::now())))
    }

    fn advance(&self, by: Duration) {
        *self.0.lock().unwrap() += by;
    }
}

type JoinCall = (String, Option<String>, Option<String>, String);

struct FakeJoin {
    response: Mutex<Result<JoinResponse, OutboundError>>,
    availability: Mutex<Result<ConnectAvailability, OutboundError>>,
    /// Cloud's participant roster, as each participant token reads it.
    roster: Mutex<Result<Vec<RosterEntry>, OutboundError>>,
    roster_tokens: Mutex<Vec<String>>,
    calls: Mutex<Vec<JoinCall>>,
}

/// One participant of Cloud's roster.
fn roster_entry(name: &str, role: &str, online: bool) -> RosterEntry {
    RosterEntry {
        agent_name: name.into(),
        role: Some(role.into()),
        available: true,
        online,
    }
}

impl FakeJoin {
    fn new(response: JoinResponse) -> FakeJoin {
        let roster = response
            .participants
            .iter()
            .map(|participant| roster_entry(&participant.agent_name, &participant.role, true))
            .collect();
        FakeJoin {
            response: Mutex::new(Ok(response)),
            availability: Mutex::new(Ok(ConnectAvailability::Active)),
            roster: Mutex::new(Ok(roster)),
            roster_tokens: Mutex::default(),
            calls: Mutex::default(),
        }
    }

    fn set_roster(&self, roster: Vec<RosterEntry>) {
        *self.roster.lock().unwrap() = Ok(roster);
    }

    fn set_roster_error(&self, error: OutboundError) {
        *self.roster.lock().unwrap() = Err(error);
    }

    fn set_response(&self, response: JoinResponse) {
        *self.response.lock().unwrap() = Ok(response);
    }

    fn set_error(&self, error: OutboundError) {
        *self.response.lock().unwrap() = Err(error);
    }

    fn calls(&self) -> usize {
        self.calls.lock().unwrap().len()
    }

    fn idempotency_keys(&self) -> Vec<String> {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .map(|call| call.3.clone())
            .collect()
    }

    fn set_availability(&self, availability: ConnectAvailability) {
        *self.availability.lock().unwrap() = Ok(availability);
    }

    fn set_availability_error(&self, error: OutboundError) {
        *self.availability.lock().unwrap() = Err(error);
    }
}

impl ConnectJoinClient for FakeJoin {
    fn join(
        &self,
        link: &str,
        name: Option<&str>,
        host_claim: Option<&str>,
        idempotency_key: &str,
    ) -> Result<JoinResponse, OutboundError> {
        self.calls.lock().unwrap().push((
            link.to_string(),
            name.map(str::to_string),
            host_claim.map(str::to_string),
            idempotency_key.to_string(),
        ));
        self.response.lock().unwrap().clone()
    }

    fn availability(&self, _: &str) -> Result<ConnectAvailability, OutboundError> {
        self.availability.lock().unwrap().clone()
    }

    /// Like Cloud, a roster read of an ended Connect answers its gone code.
    fn roster(&self, _: &str, token: &Secret) -> Result<Vec<RosterEntry>, OutboundError> {
        self.roster_tokens
            .lock()
            .unwrap()
            .push(token.expose().to_string());
        if let Ok(ConnectAvailability::Gone { code, message }) = &*self.availability.lock().unwrap()
        {
            let status = if code == "connect_not_found" {
                404
            } else {
                410
            };
            return Err(OutboundError::new(status, code, message.clone()));
        }
        self.roster.lock().unwrap().clone()
    }
}

struct Harness {
    fake: FakeRelaycast,
    connect_fake: FakeRelaycast,
    _temp: tempfile::TempDir,
    home: PathBuf,
    relay_socket: PathBuf,
    core: Arc<Core>,
    sessions: Arc<FakeSessions>,
    injector: Arc<FakeInjector>,
    direct: Arc<FakeDirect>,
    serving: ServingPath,
    clock: Clock,
    join: Arc<FakeJoin>,
    outbound: Outbound,
    me: u32,
    config: Config,
    serve: bool,
    agent_led_defaults_at_start: bool,
    task: Option<tokio::task::JoinHandle<anyhow::Result<()>>>,
}

impl Harness {
    async fn start() -> Harness {
        Harness::start_with(true).await
    }

    async fn start_with(serve: bool) -> Harness {
        Harness::start_full(serve, false).await
    }

    async fn start_full(serve: bool, agent_led_defaults_at_start: bool) -> Harness {
        Harness::start_inner(serve, agent_led_defaults_at_start, true).await
    }

    /// A core whose person never chose Auto-activate: live sessions join
    /// on their own in the background.
    async fn start_unchosen() -> Harness {
        Harness::start_inner(true, false, false).await
    }

    async fn start_inner(
        serve: bool,
        agent_led_defaults_at_start: bool,
        opt_out: bool,
    ) -> Harness {
        let fake = FakeRelaycast::start(Behaviour::default()).await;
        let connect_fake = FakeRelaycast::start(Behaviour::default()).await;
        let connect_guest = connect_fake.seed_agent("connect-guest", "agent", json!({}));
        let connect_host = connect_fake.seed_agent("connect-host", "agent", json!({}));
        let join = Arc::new(FakeJoin::new(JoinResponse {
            connect_id: "connect-1".into(),
            task: "Review the release".into(),
            expires_at: "2099-10-01T12:00:00Z".into(),
            host: ConnectHost {
                person: "Alice".into(),
                agent_name: connect_host.name.clone(),
            },
            participant: JoinedParticipant {
                agent_name: connect_guest.name.clone(),
                agent_id: connect_guest.id.clone(),
                role: "guest".into(),
                token: Secret::new(connect_guest.token.clone()),
                relay_base_url: connect_fake.base_url.clone(),
            },
            participants: vec![
                Participant {
                    agent_name: connect_host.name.clone(),
                    role: "host".into(),
                },
                Participant {
                    agent_name: connect_guest.name.clone(),
                    role: "guest".into(),
                },
            ],
        }));
        let temp = tempfile::tempdir().unwrap();
        // Short, so the socket path fits sun_path on macOS.
        let home = temp.path().to_path_buf();
        let relay = home.join(".agentworkforce/relay");
        std::fs::create_dir_all(&relay).unwrap();
        support::fake_relaycast::sign_in_store(
            &home.join("app-data"),
            WORKSPACE_KEY,
            &fake.base_url,
        );
        // These fixtures register sessions by hand: an explicit opt-out keeps
        // default automatic activation from registering them first.
        if opt_out && !agent_led_defaults_at_start {
            let path = home.join("app-data/injectable-agents.json");
            let mut store: Value = std::fs::read(&path)
                .ok()
                .and_then(|bytes| serde_json::from_slice(&bytes).ok())
                .unwrap_or_else(|| json!({}));
            store["autoActivate"] = json!(false);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, serde_json::to_vec(&store).unwrap()).unwrap();
        }
        let socket = home.join("run/core.sock");
        let mut env = BTreeMap::new();
        env.insert("RELAYCAST_URL".to_string(), fake.base_url.clone());
        env.insert("AGENT_RELAY_HOME".to_string(), relay.display().to_string());
        let config = Config {
            paths: CorePaths::for_socket(socket.clone()).unwrap(),
            home: home.clone(),
            app_data_dir: home.join("app-data"),
            env,
            version: "0.0.0-test".into(),
            host_name: "Test Desk.local".into(),
            rediscover_every: Duration::from_secs(3600),
            push_timing: PushTiming {
                heartbeat: Duration::from_millis(50),
                backoff_unit: Duration::from_millis(10),
                jitter: || 1.0,
                mint_gap: Duration::ZERO,
            },
            delivery_timing: DeliveryTiming {
                safety_poll: Duration::from_millis(150),
                fast_poll: Duration::from_millis(100),
                heartbeat: Duration::from_secs(3600),
                retry_unit: Duration::from_millis(20),
                replies: Duration::from_millis(50),
                inbox_check: Duration::from_millis(50),
                inbox_stall: Duration::from_millis(300),
                stuck_after: Duration::from_millis(300),
                ..DeliveryTiming::default()
            },
        };
        paths::socket_directory(config.paths.directory()).unwrap();
        let bound = BoundSocket::bind(&config.paths).unwrap();
        let codex = session(
            SessionKind::Codex,
            CODEX,
            "/Users/me/Projects/Relay Desktop",
        );
        let claude = session(
            SessionKind::ClaudeTerminal,
            CLAUDE,
            "/Users/me/Projects/api",
        );
        let cloud = session(SessionKind::ClaudeCloud, CLOUD, "/Users/me/Projects/web");
        let sessions = Arc::new(FakeSessions::with(vec![
            codex.clone(),
            claude.clone(),
            cloud.clone(),
        ]));
        sessions.call_from(IN_CODEX, codex);
        sessions.call_from(IN_CLAUDE, claude);
        sessions.call_from(IN_CLOUD, cloud);
        let direct = Arc::new(FakeDirect::default());
        let serving = ServingPath::default();
        // Exercise shell quoting even when the host's temporary path has no spaces.
        let relay_socket = home.join("r s/relay.sock");
        let injector = Arc::new(FakeInjector::default());
        let plugins = Plugins {
            injector: injector.clone(),
            sessions: sessions.clone(),
            connect_cloud: join.clone(),
            codex_stop_hook: Some(Arc::new(agent_relay_node::relay::codex::stop_hook::StopHookInbox::default())),
            relay_send: serve.then(|| RelaySend {
                socket: relay_socket.clone(),
                pointer: outbound::pointer_path(&home, &home.join("app-data")),
                direct_delivery: direct.clone(),
                serving: serving.clone(),
                agent_led_defaults_at_start,
            }),
            ..Plugins::default()
        };
        let (core, signals) = Core::with_plugins(config.clone(), plugins);
        let task = tokio::spawn(daemon::run(core.clone(), bound, signals));
        let clock = Clock::new();
        let ticking = clock.clone();
        let outbound = Outbound::with_clock(
            core.clone(),
            direct.clone(),
            Arc::new(move || *ticking.0.lock().unwrap()),
        );
        let h = Harness {
            fake,
            connect_fake,
            _temp: temp,
            home,
            relay_socket,
            core,
            sessions,
            injector,
            direct,
            serving,
            clock,
            join,
            outbound,
            me: agent_relay_node::relay::peer::current_uid(),
            config,
            serve,
            agent_led_defaults_at_start,
            task: Some(task),
        };
        if serve {
            eventually("the relay-send socket", || socket_up(&h.relay_socket)).await;
        }
        h
    }

    async fn call(
        &self,
        pid: i32,
        method: &str,
        path: &str,
        body: Value,
    ) -> Result<Value, OutboundError> {
        self.call_as(pid, self.me, method, path, body).await
    }

    async fn call_as(
        &self,
        pid: i32,
        uid: u32,
        method: &str,
        path: &str,
        body: Value,
    ) -> Result<Value, OutboundError> {
        let (path, query) = match path.split_once('?') {
            Some((path, query)) => (path, query),
            None => (path, ""),
        };
        let request = Request {
            method: method.into(),
            path: path.into(),
            query: url::form_urlencoded::parse(query.as_bytes())
                .into_owned()
                .collect(),
            headers: Default::default(),
            body: if body.is_null() {
                Vec::new()
            } else {
                body.to_string().into_bytes()
            },
        };
        self.outbound.handle(pid, uid, &request).await
    }

    async fn register(&self, pid: i32, body: Value) -> Value {
        self.call(pid, "POST", "/register", body).await.unwrap()
    }

    async fn call_text(
        &self,
        pid: i32,
        method: &str,
        path: &str,
        body: &str,
    ) -> Result<Value, OutboundError> {
        let (path, query) = match path.split_once('?') {
            Some((path, query)) => (path, query),
            None => (path, ""),
        };
        self.outbound
            .handle(
                pid,
                self.me,
                &Request {
                    method: method.into(),
                    path: path.into(),
                    query: url::form_urlencoded::parse(query.as_bytes())
                        .into_owned()
                        .collect(),
                    headers: Default::default(),
                    body: body.as_bytes().to_vec(),
                },
            )
            .await
    }

    async fn restart_after(&mut self, edit_stopped_state: impl FnOnce(&Path)) {
        self.core.request_shutdown();
        if let Some(task) = self.task.take() {
            let _ = tokio::time::timeout(Duration::from_secs(5), task).await;
        }
        edit_stopped_state(&self.config.app_data_dir);
        paths::socket_directory(self.config.paths.directory()).unwrap();
        let bound = BoundSocket::bind(&self.config.paths).unwrap();
        let plugins = Plugins {
            injector: self.injector.clone(),
            sessions: self.sessions.clone(),
            connect_cloud: self.join.clone(),
            codex_stop_hook: Some(Arc::new(agent_relay_node::relay::codex::stop_hook::StopHookInbox::default())),
            relay_send: self.serve.then(|| RelaySend {
                socket: self.relay_socket.clone(),
                pointer: outbound::pointer_path(&self.home, &self.home.join("app-data")),
                direct_delivery: self.direct.clone(),
                serving: self.serving.clone(),
                agent_led_defaults_at_start: self.agent_led_defaults_at_start,
            }),
            ..Plugins::default()
        };
        let (core, signals) = Core::with_plugins(self.config.clone(), plugins);
        self.task = Some(tokio::spawn(daemon::run(core.clone(), bound, signals)));
        self.core = core.clone();
        let ticking = self.clock.clone();
        self.outbound = Outbound::with_clock(
            core,
            self.direct.clone(),
            Arc::new(move || *ticking.0.lock().unwrap()),
        );
        if self.serve {
            eventually("the restarted relay-send socket", || {
                socket_up(&self.relay_socket)
            })
            .await;
        }
    }

    async fn stop(mut self) {
        self.core.request_shutdown();
        if let Some(task) = self.task.take() {
            let _ = tokio::time::timeout(Duration::from_secs(5), task).await;
        }
    }
}

/// Whether the relay-send socket is up: its file on Unix; on Windows, where
/// no file stands for the pipe, whether it answers.
fn socket_up(path: &Path) -> bool {
    if cfg!(windows) {
        agent_relay_node::relay::transport::is_served(path)
    } else {
        path.exists()
    }
}

fn code(result: Result<Value, OutboundError>) -> (u16, String) {
    let error = result.expect_err("a refusal");
    (error.status, error.code)
}

/// One raw HTTP exchange over the socket, as `curl --unix-socket` makes it.
async fn http(socket: &Path, raw: &[u8]) -> (u16, Value) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut stream = agent_relay_node::relay::transport::CoreStream::connect(socket)
        .await
        .unwrap();
    stream.write_all(raw).await.unwrap();
    let mut response = Vec::new();
    tokio::time::timeout(Duration::from_secs(10), stream.read_to_end(&mut response))
        .await
        .expect("an answer")
        .unwrap();
    let text = String::from_utf8(response).unwrap();
    let status: u16 = text.split_whitespace().nth(1).unwrap().parse().unwrap();
    let body = text.split("\r\n\r\n").nth(1).unwrap();
    (status, serde_json::from_str(body).unwrap())
}

fn get(path: &str) -> Vec<u8> {
    format!("GET {path} HTTP/1.1\r\nHost: relay\r\n\r\n").into_bytes()
}

fn post(path: &str, body: &str) -> Vec<u8> {
    format!(
        "POST {path} HTTP/1.1\r\nHost: relay\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    )
    .into_bytes()
}

/// Requests made with `token` to `method path` on the Connect's Relaycast.
fn connect_calls(h: &Harness, method: &str, path: &str, token: &str) -> usize {
    let bearer = format!("Bearer {token}");
    h.connect_fake
        .calls(method, path)
        .iter()
        .filter(|call| call.authorization.as_deref() == Some(bearer.as_str()))
        .count()
}

// Issue #238: Connect messages that arrive while the guest's terminal Codex
// runs a long turn enter its queue at once and in order, report that they
// wait for the turn, and settle as visible once the session records them.

// OutboundTests.testSendsAddressWithIdempotencyKey,
// test_sends_with_the_calling_sessions_own_token and test_sends_by_name_too.

// OutboundTests.testRejectsNamedSenderRecipientAndTextErrors,
// test_never_takes_a_sender_from_the_request,
// test_needs_exactly_one_recipient_and_some_text and
// test_rejects_malformed_explicit_addresses_before_transport.

// test_refuses_a_session_that_is_not_on_the_relay, test_refuses_another_user,
// OutboundTests.testRejectsProcessOutsideSession and testRejectsWrongUID.

// test_passes_relaycast_refusals_through.

/// A temporary folder an agent may send from: `tempfile::tempdir()` names
/// its folders `.tmp…`, which are hidden.
fn sendable_dir() -> tempfile::TempDir {
    tempfile::Builder::new()
        .prefix("relay-files-")
        .tempdir()
        .unwrap()
}

// OutboundTests.testOnlyRepliesToAParentDeliveredToTheCallingSession and
// test_replies_only_under_a_parent_delivered_to_the_session.

// OutboundTests.testRateLimitsPerSendingAgentAndExpiresWindow,
// testRateLimitFollowsTheSessionAcrossUnregisterAndRename,
// test_rate_limits_each_agent and
// test_rate_limit_follows_the_session_across_unregister_and_rename.

// A hung volume once froze every core worker inside a session folder's
// project lookup: the session socket stopped answering and SIGTERM could not
// stop the core. Here the folder's `.git/commondir` is a FIFO with no
// writer, so the real project lookup blocks in `open` forever, as a read on
// a dead drive does. The test runtime has one thread, so a lookup on it
// would stall every assertion below.
// A FIFO, which only Unix has.

// OutboundTests.testWhoami, testWhoamiAndRegisterWorkBeforeTheSessionIsRegistered,
// test_whoami and test_whoami_identifies_a_supported_session_before_it_is_registered.

// OutboundTests.testRegisterIsIdempotentAndSettingCanRefuseIt,
// test_registers_only_the_calling_session_through_the_switch_path and
// test_register_respects_the_user_setting_and_validates_the_body.

// OutboundTests.testUnregisterIsIdempotent and
// test_unregisters_only_the_calling_session_and_is_idempotent.

// test_register_waits_for_an_in_flight_switch_instead_of_failing and
// test_unregister_waits_for_an_in_flight_registration_and_removes_it.

// OutboundTests.testAgentsFiltersCachesAndMarksSelf,
// test_agents_filters_redacts_and_caches_the_active_roster,
// test_active_and_all_rosters_have_separate_cache_entries and
// test_live_local_names_are_scoped_to_the_callers_workspace.

// Issue #333: on a computer whose session discovery waits on the Codex app,
// and with Relaycast slow to list the workspace,
// `GET /agents` and `GET /setup/status` still answer within a bound. The
// roster answers from the last read, marked stale, while the read finishes
// in the background; with no roster read yet, the route says Relaycast is
// slow instead of hanging.

// OutboundTests.testAgentsAddsTheLiveCallerWhenRelaycastSnapshotOmitsIt and
// test_missing_relaycast_caller_is_synthesized_as_live_and_local.

// The headless service (`serve --headless`) applies the agent-led
// defaults when its socket starts, as the Linux headless service did; a core
// hosted by an app waits for a setup route for direct delivery. Automatic
// activation is on by default for either host.

// OutboundTests.testSetupAdmitsAnIdentifiedSessionBeforeRegistration,
// testDefaultsAreNewUploadsAutoActivationAndDirectDelivery and
// test_setup_routes_bootstrap_before_registration_and_cover_the_contract.

/// `GET /setup/status`, which must answer within `QUICK`.
async fn status_promptly(h: &Harness) -> Value {
    tokio::time::timeout(
        QUICK,
        h.call(IN_CLAUDE, "GET", "/setup/status", Value::Null),
    )
    .await
    .expect("status answers without waiting on the stalled work")
    .unwrap()
}

/// Far below any network timeout: an answer this fast waited on nothing
/// remote.
const QUICK: Duration = Duration::from_secs(2);

// A setup route activating sessions waits on Relaycast registration; status
// and the other setup routes do not wait behind it.

// A workspace key found by a setup request is verified in the background;
// status reports the verification pending meanwhile, then its answer.

// The direct-delivery default never overrides the user's own explicit
// `crossSessionInbound` (here `hold`); an explicit setup request still can.

// OutboundTests.testDirectDeliveryReportsManagedPolicyRefusal and
// test_setup's managed policy cases.

// test_setup_routes_keep_same_user_session_admission and the webhook rows
// of test_setup_routes_bootstrap_before_registration_and_cover_the_contract.

// The subscribe route reads a pull request's github.com address like the
// `owner/repo#123` shorthand, and refuses an address it cannot read before
// anything leaves this computer.

// OutboundTests.testSocketRoundTripUsesKernelPeerPID,
// testWhoamiAndBadRequestDoNotTakeSocketDown, testBodyLimit,
// test_only_this_user_can_reach_the_socket, test_sends_json, test_bad_requests
// and test_whoami.

// OutboundTests.testAgentsAndPrivatePointerFile,
// testPrivateModesAndLiveSocketRefusal, test_agents_and_pointer_file and
// test_a_second_app_does_not_take_over_a_live_socket.

// OutboundTests.testStaleSocketIsReplaced, testNonSocketEntryIsNotDeleted,
// testOlderSocketDoesNotRemoveReplacementPointer,
// testStopDoesNotDeleteReplacementPath, testPointerFailureKeepsTheRuntimeSocketServing,
// test_a_stale_socket_file_is_replaced,
// test_an_older_socket_does_not_remove_a_replacement_pointer and
// test_pointer_failure_keeps_the_runtime_socket_serving.
// Socket files; a named pipe leaves none behind to replace.

// Review: an activation failure clears from /setup/status once the delivery
// loop has put the sessions on the relay.

// A delivery the session's route refuses for good is failed once, not
// retryable, never acknowledged and never injected again.

/// Queues posts while the agent's queue read is parked, so one pass reads
/// them all; returns `(delivery id, message id)` for each.
async fn queue_in_one_pass(
    h: &Harness,
    agent: &str,
    items: &[(&str, &str, Option<&str>, &str)],
) -> Vec<(String, String)> {
    // Park a read first: reads of one agent's queue are serial, so none
    // already under way can see only some of the items.
    let release = h.fake.hold("GET /v1/deliveries");
    let parked = h.fake.held("GET /v1/deliveries");
    h.core.request_drain(agent);
    eventually("a queue read parked", || {
        h.fake.held("GET /v1/deliveries") > parked
    })
    .await;
    let queued = items
        .iter()
        .map(|(reason, sender, channel, text)| h.fake.queue(agent, reason, *channel, sender, text))
        .collect();
    release.send(true).unwrap();
    queued
}

fn channel_injections(h: &Harness) -> Vec<String> {
    h.injector
        .injected()
        .into_iter()
        .map(|i| i.text)
        .filter(|text| text.contains("a channel you subscribed to"))
        .collect()
}

// Bots on #572: a subscribed channel's posts that keep waiting are
// reported like a DM, once, so a session that takes nothing cannot hide
// behind channel posts either.

fn acked(h: &Harness, delivery: &str) -> bool {
    h.fake.delivery_state(delivery).map(|d| d.state).as_deref() == Some("acked")
}

// Terminal Claude Code inbox watch (`claude::inbox`). The fake transcript
// has no dequeue, so a message handed to the session stays unread.

fn claude_transcript(lines: &[Value]) -> Vec<u8> {
    lines
        .iter()
        .map(|line| format!("{line}\n"))
        .collect::<String>()
        .into_bytes()
}

/// A session last active an hour ago, nothing read since.
fn idle_transcript() -> Vec<u8> {
    claude_transcript(&[json!({
        "type": "assistant",
        "timestamp": iso_minutes_ago(60),
        "message": {"role": "assistant", "content": "working"},
    })])
}

fn iso_minutes_ago(minutes: i64) -> String {
    let at = chrono::Utc::now() - chrono::Duration::minutes(minutes);
    at.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

fn inbox_stall(h: &Harness, name: &str) -> Option<u32> {
    h.core
        .agents_list()
        .agents
        .into_iter()
        .find(|a| a.name == name)
        .and_then(|a| a.inbox_stall)
        .map(|s| s.undrained_count)
}

