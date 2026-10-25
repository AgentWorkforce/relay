//! Signing in, the kept Cloud session, the account workspace, sign-out and
//! the uploader, end to end over the bridge socket, against an in-process
//! fake Cloud and a fake probe. No broker, PTY runtime or agent harness is
//! started, and nothing reaches a real Cloud, Relaycast or PostHog.

mod support {
    pub mod bridge;
    pub mod fake_cloud;
}

use agent_relay_probe::relay::account::{Account, Flow};
use agent_relay_probe::relay::cloud_session::CloudAccess;
use agent_relay_probe::relay::daemon::{self, BoundSocket, Config, Core, Plugins};
use agent_relay_probe::relay::delivery::DeliveryTiming;
use agent_relay_probe::relay::incoming::{Incoming, IncomingParts, IncomingState};
use agent_relay_probe::relay::mailbox::{
    self, CredentialFiles, MailboxError, MailboxNetwork, MailboxSocket,
};
use agent_relay_probe::relay::outbox::{
    CodexAppServerError, CodexBridgeError, CodexDeliveryEffects, CodexQueueError,
    CodexWindowDelivering, RolloutSummary, WindowSessionError,
};
use agent_relay_probe::relay::paths::{self, CorePaths};
use agent_relay_probe::relay::push::PushTiming;
use agent_relay_probe::relay::sessions::DiscoveredSession;
use agent_relay_probe::relay::setup::{DirectDelivery, Setup};
use agent_relay_probe::relay::store::{SessionKind, Target};
use agent_relay_probe::relay::telemetry::{
    PostHogProject, Telemetry, TelemetryConfig, TelemetrySender,
};
use agent_relay_probe::relay::uploader::{InstallRun, ProbeRunner, Uploader, UploaderError};
use agent_relay_probe::relay::workspace::Secret;
use futures_util::future::BoxFuture;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use support::bridge::{eventually, Client};
use support::fake_cloud::{FakeCloud, ACCOUNT_KEY, USER, WORKSPACE};
use tokio::sync::mpsc;

// Setup preferences stay in this test's temporary core; no user settings change.
struct SetupDirect;
impl DirectDelivery for SetupDirect {
    fn delivers_directly(&self) -> bool {
        true
    }
    fn managed_value(&self) -> Option<String> {
        None
    }
    fn user_choice(&self) -> Option<String> {
        Some("accept".into())
    }
    fn set_direct_delivery(&self, _: bool) -> Result<(), String> {
        Ok(())
    }
}

/// The probe's commands, answered from memory.
#[derive(Default)]
struct FakeProbe {
    state: Mutex<ProbeState>,
}

#[derive(Default)]
struct ProbeState {
    installs: Vec<Value>,
    status: Value,
    /// Every command: its arguments and the bearer it was given.
    calls: Vec<(Vec<String>, Option<String>)>,
    /// `cloud install` fails with this sentence.
    install_error: Option<String>,
    /// `disconnect` fails while set.
    disconnect_fails: bool,
    cancelled: u32,
    /// `cloud install` connects this computer, then runs until cancelled.
    hold_install: bool,
    hold_before_connection: bool,
    held_events: Vec<mpsc::UnboundedSender<Value>>,
    /// `cloud install` connects this computer, then fails with this.
    fail_after_connected: Option<String>,
    /// `status` fails, as on an install whose setup did not finish.
    status_fails: bool,
    /// Held installs' completions, never sent.
    held: Vec<tokio::sync::oneshot::Sender<Result<(), UploaderError>>>,
}

impl FakeProbe {
    fn calls(&self, command: &str) -> Vec<(Vec<String>, Option<String>)> {
        let state = self.state.lock().unwrap();
        state
            .calls
            .iter()
            .filter(|(args, _)| args.first().map(String::as_str) == Some(command))
            .cloned()
            .collect()
    }

    fn connected(site: &str) -> Value {
        json!({"directory": "/tmp/x", "site_url": site, "account_id": USER, "workspace_id": WORKSPACE, "org_id": ORG,
               "account_email": "ada@example.com", "account_name": "Ada", "sharing_mode": "new",
               "running": true, "paused": false, "upgrade_required": false})
    }
}

impl ProbeRunner for FakeProbe {
    fn run(
        &self,
        args: Vec<String>,
        _: Option<Duration>,
    ) -> BoxFuture<'_, Result<Value, UploaderError>> {
        let mut state = self.state.lock().unwrap();
        state.calls.push((args.clone(), None));
        let answer = match args[0].as_str() {
            "installs" => Ok(json!({ "installs": state.installs })),
            "status" if state.status_fails => Err(UploaderError::new("No status yet.")),
            "status" => Ok(state.status.clone()),
            "start" => Ok(json!({"running": true, "started": true})),
            "disconnect" if state.disconnect_fails => {
                Err(UploaderError::new("This workspace’s uploader is busy."))
            }
            "disconnect" => {
                state.installs.clear();
                Ok(json!({"disconnected": true}))
            }
            "sharing" => Ok(
                json!({"sharing_mode": args[args.iter().position(|a| a == "--mode").unwrap() + 1], "regenerated": false}),
            ),
            "sessions" if args[1] == "list" => Ok(
                json!({"sharing_mode": "new", "sessions": [{"source": "codex", "session_id": "a", "title": "a",
                    "cwd": null, "git_branch": null, "first_activity_ms": null, "last_activity_ms": null,
                    "is_agent": false, "included": false, "status": "not_shared"}]}),
            ),
            "sessions" if args[1] == "preview" => {
                Ok(json!({"sharing_mode": "selected", "sessions": []}))
            }
            "sessions" => Ok(json!({"included": [], "regenerated": false})),
            "reclaim" => Ok(json!({})),
            _ => Err(UploaderError::new("unknown command")),
        };
        Box::pin(async move { answer })
    }

    fn install(
        &self,
        args: Vec<String>,
        bearer: Option<Secret>,
    ) -> Result<InstallRun, UploaderError> {
        let mut state = self.state.lock().unwrap();
        state.calls.push((
            args.clone(),
            bearer.as_ref().map(|b| b.expose().to_string()),
        ));
        let (events, receiver) = mpsc::unbounded_channel();
        let (done, finished) = tokio::sync::oneshot::channel();
        let site = args[args.iter().position(|a| a == "--site-url").unwrap() + 1].clone();
        match state.install_error.clone() {
            Some(message) => {
                let _ = done.send(Err(UploaderError::new(message)));
            }
            None if state.fail_after_connected.is_some() => {
                for event in [
                    json!({"event": "authenticated", "account_id": USER, "workspace_id": WORKSPACE}),
                    json!({"event": "connected", "account_id": USER, "workspace_id": WORKSPACE}),
                ] {
                    events.send(event).unwrap();
                }
                state.installs.push(FakeProbe::connected(&site));
                let message = state.fail_after_connected.clone().unwrap();
                let _ = done.send(Err(UploaderError::new(message)));
            }
            None if state.hold_before_connection => {
                events.send(json!({"event":"authenticated", "account_id":USER, "workspace_id":WORKSPACE})).unwrap();
                state.held_events.push(events);
                state.held.push(done);
            }
            None if state.hold_install => {
                for event in [
                    json!({"event": "authenticated", "account_id": USER, "workspace_id": WORKSPACE}),
                    json!({"event": "connected", "account_id": USER, "workspace_id": WORKSPACE}),
                ] {
                    events.send(event).unwrap();
                }
                state.installs.push(FakeProbe::connected(&site));
                state.held.push(done);
            }
            None => {
                for event in [
                    json!({"event": "authenticated", "account_id": USER, "workspace_id": WORKSPACE, "account_email": "ada@example.com"}),
                    json!({"event": "connected", "account_id": USER, "workspace_id": WORKSPACE}),
                    json!({"event": "progress", "progress": {"phase": "scanning", "source": "codex", "processedFiles": 1, "totalFiles": 2, "sessionsCaptured": 1}}),
                    json!({"event": "ready"}),
                ] {
                    events.send(event).unwrap();
                }
                state.installs.push(FakeProbe::connected(&site));
                let _ = done.send(Ok(()));
            }
        }
        Ok(InstallRun {
            events: receiver,
            finished,
            cancel: Box::new(|| {}),
        })
    }

    fn cancel_all(&self) -> BoxFuture<'_, Result<(), UploaderError>> {
        self.state.lock().unwrap().cancelled += 1;
        Box::pin(async { Ok(()) })
    }
}

const ORG: &str = "org-1";

/// PostHog in memory: every event, accepted.
#[derive(Default)]
struct FakeAnalytics {
    events: Mutex<Vec<Value>>,
}

impl TelemetrySender for FakeAnalytics {
    fn send(&self, batch: Vec<Value>) -> Result<(), String> {
        self.events.lock().unwrap().extend(batch);
        Ok(())
    }
}

struct Harness {
    cloud: FakeCloud,
    analytics: Arc<FakeAnalytics>,
    telemetry: Arc<Telemetry>,
    probe: Arc<FakeProbe>,
    account: Arc<Account>,
    core: Arc<Core>,
    _temp: tempfile::TempDir,
    home: PathBuf,
    socket: PathBuf,
    task: tokio::task::JoinHandle<anyhow::Result<()>>,
}

impl Harness {
    async fn start() -> Harness {
        Harness::start_with(|_, _| {}).await
    }

    async fn start_with(prepare: impl FnOnce(&FakeCloud, &Harnessing)) -> Harness {
        let cloud = FakeCloud::start().await;
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().to_path_buf();
        let probe = Arc::new(FakeProbe::default());
        let setup = Harnessing {
            home: home.clone(),
            probe: probe.clone(),
            supervise_every: Mutex::new(None),
            mailbox: Mutex::new(None),
        };
        prepare(&cloud, &setup);
        let socket = home.join("run/core.sock");
        let mut env = BTreeMap::new();
        // Any Relaycast verification fails fast on a closed local port.
        env.insert(
            "RELAYCAST_URL".to_string(),
            "http://127.0.0.1:9".to_string(),
        );
        let app_data_dir = home.join("app-data");
        let config = Config {
            paths: CorePaths::for_socket(socket.clone()).unwrap(),
            home: home.clone(),
            app_data_dir: app_data_dir.clone(),
            env: env.clone(),
            version: "0.0.0-test".into(),
            host_name: "Test Desk.local".into(),
            rediscover_every: Duration::from_secs(3600),
            push_timing: PushTiming::default(),
            delivery_timing: DeliveryTiming::default(),
        };
        paths::socket_directory(config.paths.directory()).unwrap();
        let bound = BoundSocket::bind(&config.paths).unwrap();
        let mut account = Account::new(
            Some(&cloud.site_url),
            &home,
            &env,
            &app_data_dir,
            Arc::new(Uploader::new(probe.clone())),
        );
        if let Some(every) = *setup.supervise_every.lock().unwrap() {
            account.supervise_every = every;
        }
        if let Some(network) = setup.mailbox.lock().unwrap().clone() {
            account.incoming = Some(incoming_with(network, &app_data_dir));
        }
        let analytics = Arc::new(FakeAnalytics::default());
        let telemetry = Telemetry::new(
            TelemetryConfig {
                app_data_dir: app_data_dir.clone(),
                home: home.clone(),
                env: env.clone(),
                version: "0.0.0-test".into(),
                project: PostHogProject::new("phc_test", "https://analytics.example.com"),
                clock: Arc::new(std::time::SystemTime::now),
                ticks: Arc::new(std::time::Instant::now),
            },
            analytics.clone(),
        );
        account.telemetry = Some(telemetry.clone());
        let account = Arc::new(account);
        let plugins = Plugins {
            cloud: account.clone() as Arc<dyn CloudAccess>,
            account: Some(account.clone()),
            ..Plugins::default()
        };
        let (core, signals) = Core::with_plugins(config, plugins);
        let task = tokio::spawn(daemon::run(core.clone(), bound, signals));
        Harness {
            cloud,
            analytics,
            telemetry,
            probe,
            account,
            core,
            _temp: temp,
            home,
            socket,
            task,
        }
    }

    async fn client(&self) -> Client {
        Client::connect(&self.socket).await
    }

    async fn setup_sign_in(
        &self,
        params: Value,
    ) -> Result<Value, agent_relay_probe::relay::outbound::OutboundError> {
        self.setup_request("POST /setup/sign-in", params).await
    }

    async fn setup_request(
        &self,
        method: &str,
        params: Value,
    ) -> Result<Value, agent_relay_probe::relay::outbound::OutboundError> {
        Arc::new(Setup::new(self.core.clone(), Arc::new(SetupDirect)))
            .handle(
                &DiscoveredSession {
                    target: Target {
                        kind: SessionKind::ClaudeTerminal,
                        id: "setup-test".into(),
                    },
                    title: "Setup test".into(),
                    directory: None,
                    updated_at_ms: None,
                    host: None,
                    live: true,
                    holder: None,
                },
                method,
                params.as_object().unwrap().clone(),
            )
            .await
    }

    /// What reached PostHog, once everything queued is sent.
    fn analytics(&self) -> Vec<Value> {
        assert!(self.telemetry.flush(Duration::from_secs(5)));
        self.analytics.events.lock().unwrap().clone()
    }

    fn account_state(&self) -> String {
        self.core.status().account.state_name()
    }

    fn store(&self) -> Value {
        serde_json::from_slice(
            &std::fs::read(self.home.join("app-data/injectable-agents.json")).unwrap_or_default(),
        )
        .unwrap_or(Value::Null)
    }

    async fn stop(self) {
        self.core.request_shutdown();
        let _ = self.task.await;
    }
}

/// What a test can arrange before the daemon starts.
struct Harnessing {
    home: PathBuf,
    probe: Arc<FakeProbe>,
    supervise_every: Mutex<Option<Duration>>,
    /// Incoming messages over this mailbox network.
    mailbox: Mutex<Option<Arc<FakeMailbox>>>,
}

/// The mailbox at the fake Cloud's loopback origin: room and mailbox
/// activation answer, polls return nothing, and the socket never opens.
#[derive(Default)]
struct FakeMailbox {
    /// Every request: method, URL and bearer.
    requests: Mutex<Vec<(String, String, String)>>,
}

const MAILBOX_ORIGIN: &str = "http://127.0.0.1:1";

impl MailboxNetwork for FakeMailbox {
    fn request(
        &self,
        method: &'static str,
        url: String,
        bearer: Secret,
        _: Option<Vec<u8>>,
        _: Option<String>,
    ) -> BoxFuture<'_, Result<Vec<u8>, MailboxError>> {
        self.requests.lock().unwrap().push((
            method.into(),
            url.clone(),
            bearer.expose().to_string(),
        ));
        let answer = if url.ends_with("/room/session") {
            json!({"role": "participant", "relaycastBaseUrl": MAILBOX_ORIGIN, "agentToken": "at_live_device"})
        } else if url.ends_with("/desktop/session") {
            json!({"site": MAILBOX_ORIGIN, "account_id": "membership", "workspace_id": WORKSPACE,
                   "expires_at": "2099-01-01T00:00:00Z", "messages_path": mailbox::MESSAGES_PATH,
                   "acks_path": mailbox::ACKS_PATH, "threads_path": mailbox::THREADS_PATH})
        } else {
            json!([])
        };
        Box::pin(async move { Ok(answer.to_string().into_bytes()) })
    }

    fn connect(
        &self,
        _: String,
        _: Secret,
    ) -> BoxFuture<'_, Result<Box<dyn MailboxSocket>, MailboxError>> {
        Box::pin(std::future::pending())
    }
}

/// A Codex that takes nothing: messages wait in the outbox.
struct NoCodex;

impl CodexDeliveryEffects for NoCodex {
    fn queue_available(&self) -> bool {
        false
    }
    fn queue_send(&self, _: &str, _: &str) -> Result<(), CodexQueueError> {
        unreachable!("nothing is delivered in these tests")
    }
    fn queue_waiting(&self, _: &str, _: &str) -> Option<bool> {
        None
    }
    fn queue_cleanup(&self, _: &str, _: &str) {}
    fn app_server_loaded(&self) -> std::collections::HashSet<String> {
        Default::default()
    }
    fn app_server_send(&self, _: &str, _: &str, _: &str) -> Result<bool, CodexAppServerError> {
        Ok(false)
    }
    fn terminal_live(&self, _: &str) -> bool {
        false
    }
    fn rollout(&self, _: &str) -> Option<RolloutSummary> {
        None
    }
    fn idle(&self, _: &str) -> bool {
        false
    }
    fn rollout_readable(&self, _: &str) -> bool {
        false
    }
    fn with_window_session(
        &self,
        _: &mut dyn FnMut(&mut dyn CodexWindowDelivering) -> Result<(), WindowSessionError>,
    ) -> Result<(), WindowSessionError> {
        Err(WindowSessionError::Bridge(
            CodexBridgeError::CodexNotRunning,
        ))
    }
}

fn incoming_with(network: Arc<FakeMailbox>, app_data_dir: &std::path::Path) -> Arc<Incoming> {
    Incoming::new(IncomingParts {
        app_data_dir: app_data_dir.to_path_buf(),
        network,
        credentials: Arc::new(CredentialFiles {
            root: app_data_dir.join("credentials"),
        }),
        effects: Arc::new(NoCodex),
        threads: Arc::new(Vec::new),
    })
}

trait StateName {
    fn state_name(&self) -> String;
}

impl StateName for agent_relay_probe::relay::state::AccountStatus {
    fn state_name(&self) -> String {
        serde_json::to_value(self.state)
            .unwrap()
            .as_str()
            .unwrap()
            .to_string()
    }
}

#[tokio::test]
async fn a_device_sign_in_connects_the_workspace_and_the_uploader_with_one_approval() {
    let harness = Harness::start().await;
    let mut client = harness.client().await;
    client
        .ok("subscribe", json!({"topics": ["sign_in", "status"]}))
        .await;
    let started = client
        .ok(
            "account.sign_in",
            json!({"sharing": "new", "flow": "device"}),
        )
        .await;
    assert_eq!(started["state"], "pending_approval");
    assert_eq!(started["phase"], "waiting_for_device_approval");
    assert_eq!(started["user_code"], "ABCD-EFGH");
    assert_eq!(
        started["verification_url_complete"],
        format!("{}/device?code=ABCD-EFGH", harness.cloud.site_url)
    );
    assert!(started.get("device_code").is_none());
    assert!(!started.to_string().contains("secret-device-code"));

    eventually("signed in", || harness.account_state() == "signed_in").await;

    // The probe connected with the approved session: no second approval.
    let installs = harness.probe.calls("cloud");
    assert_eq!(installs.len(), 1);
    let (args, bearer) = &installs[0];
    assert!(args.contains(&"--new-sessions-only".to_string()));
    // A reconnect keeps the install's saved sharing choice.
    assert!(args.contains(&"--keep-saved-sharing".to_string()));
    assert!(args.windows(2).any(|w| w == ["--workspace", WORKSPACE]));
    assert_eq!(bearer.as_deref(), Some("access-1"));

    // The session is kept, renewable, in the store; the account's Relaycast
    // workspace is resolved into it and discovered.
    let store = harness.store();
    assert_eq!(store["cloudSession"]["accessToken"], "access-1");
    assert_eq!(store["cloudSession"]["refreshToken"], "refresh-1");
    assert_eq!(store["cloud"]["key"], ACCOUNT_KEY);
    assert_eq!(store["cloud"]["accountWorkspaceID"], WORKSPACE);
    let status = client.ok("status.get", json!({})).await;
    assert_eq!(status["workspace"]["state"], "found");
    assert_eq!(status["account"]["workspace_id"], WORKSPACE);
    assert_eq!(status["account"]["workspace_name"], "Acme");
    assert_eq!(status["account"]["person"]["id"], USER);
    assert_eq!(status["account"]["person"]["email"], "ada@example.com");
    assert!(!status.to_string().contains("access-1"));

    // The CloudAccess the rest of the core uses is this account.
    let account = harness.account.account().unwrap();
    assert_eq!(account.workspace_id, WORKSPACE);
    assert_eq!(account.user_id.as_deref(), Some(USER));

    // Progress and the approval link were published on `sign_in`.
    client.ok("status.get", json!({})).await;
    let sign_in: Vec<&Value> = client
        .events
        .iter()
        .filter(|e| e["params"]["topic"] == "sign_in")
        .map(|e| &e["params"]["data"])
        .collect();
    assert!(sign_in.iter().any(|d| d["user_code"] == "ABCD-EFGH"));
    assert!(sign_in
        .iter()
        .any(|d| d["progress"]["sessions_captured"] == 1));
    assert!(sign_in.iter().any(|d| d["state"] == "signed_in"));
    harness.stop().await;
}

#[tokio::test]
async fn browser_continuation_preserves_the_requested_workspace() {
    for entry in ["default", "browser", "rejected_cli"] {
        let harness = Harness::start_with(move |cloud, setup| {
            if entry == "rejected_cli" {
                write_cli_session(cloud, &setup.home);
                cloud.expire_access();
            }
        })
        .await;
        let mut client = harness.client().await;
        let mut params = json!({"sharing": "selected", "workspace": WORKSPACE});
        if entry == "browser" {
            params["flow"] = json!("browser");
        }
        client.ok("account.sign_in", params).await;
        eventually("workspace browser link", || {
            harness.account_state() == "pending_approval"
        })
        .await;
        let report = client.ok("account.status", json!({})).await;
        let url = url::Url::parse(report["verification_url_complete"].as_str().unwrap()).unwrap();
        let login = if entry == "browser" {
            let next = url
                .query_pairs()
                .find(|(key, _)| key == "next")
                .unwrap()
                .1
                .into_owned();
            url.join(&next).unwrap()
        } else {
            url
        };
        assert_eq!(
            login
                .query_pairs()
                .find(|(key, _)| key == "workspace")
                .map(|(_, value)| value.into_owned()),
            Some(WORKSPACE.to_owned()),
            "{entry} must preserve the requested workspace through the browser handoff"
        );
        client.ok("account.sign_in.cancel", json!({})).await;
        harness.stop().await;
    }
}

#[tokio::test]
async fn a_browser_sign_in_returns_to_the_loopback_receiver_and_exchanges_with_pkce() {
    for entry in ["browser", "default", "setup"] {
        let harness = Harness::start().await;
        let mut client = harness.client().await;
        let started =
            if entry == "setup" {
                let response = harness
                    .setup_sign_in(json!({"flow":"browser"}))
                    .await
                    .unwrap();
                assert!(["preparing", "pending_approval"]
                    .contains(&response["status"].as_str().unwrap()));
                eventually("browser link", || {
                    harness.account_state() == "pending_approval"
                })
                .await;
                harness
                    .setup_request("GET /setup/status", json!({}))
                    .await
                    .unwrap()
            } else {
                let params = if entry == "browser" {
                    json!({"sharing": "all", "flow": "browser"})
                } else {
                    json!({"sharing": "all"})
                };
                let response = client.ok("account.sign_in", params).await;
                assert!(["preparing", "pending_approval"]
                    .contains(&response["state"].as_str().unwrap()));
                eventually("browser link", || {
                    harness.account_state() == "pending_approval"
                })
                .await;
                let pending = client.ok("account.status", json!({})).await;
                assert_eq!(pending["phase"], "waiting_for_browser");
                pending
            };
        assert!(
            started["user_code"].is_null(),
            "{entry} must not request a device code"
        );
        assert!(harness
            .cloud
            .requests("/cloud/api/v1/auth/device/start")
            .is_empty());
        let link = started["verification_url_complete"]
            .as_str()
            .unwrap()
            .to_string();
        let path = if entry == "browser" {
            "/cloud/api/auth/google/start?next="
        } else {
            "/cloud/api/v1/cli/login?"
        };
        assert!(link.starts_with(&format!("{}{path}", harness.cloud.site_url)));

        // What the browser does after Google: Cloud redirects to the receiver.
        let decoded = link.replace("%3D", "=").replace("%26", "&");
        let redirect = decoded
            .split("redirect_uri=")
            .nth(1)
            .unwrap()
            .split('&')
            .next()
            .unwrap()
            .to_string();
        let challenge = decoded
            .split("code_challenge=")
            .nth(1)
            .unwrap()
            .split('&')
            .next()
            .unwrap()
            .to_string();
        let (handoff, _) = harness.cloud.issue();
        let forged = reqwest_get(&format!(
            "{}?access_token=x&api_url=https://evil.example/cloud",
            redirect
        ))
        .await;
        assert!(forged.starts_with("HTTP/1.1 400"));
        let accepted = reqwest_get(&format!(
            "{redirect}?access_token={handoff}&api_url={}/cloud",
            harness.cloud.site_url
        ))
        .await;
        assert!(accepted.starts_with("HTTP/1.1 200"), "{accepted}");

        eventually("signed in", || harness.account_state() == "signed_in").await;
        let exchange = harness.cloud.requests("/cloud/api/v1/auth/desktop/session");
        assert_eq!(exchange.len(), 1);
        assert_eq!(exchange[0].bearer.as_deref(), Some(handoff.as_str()));
        let verifier = exchange[0].body["codeVerifier"].as_str().unwrap();
        let digest = base64_url(&Sha256::digest(verifier.as_bytes()));
        assert_eq!(digest, challenge);
        // The renewable session from the exchange is the one kept and used.
        let store = harness.store();
        assert_eq!(store["cloudSession"]["accessToken"], "access-2");
        assert_eq!(store["cloudSession"]["refreshToken"], "refresh-2");
        let (args, bearer) = &harness.probe.calls("cloud")[0];
        assert_eq!(
            args.contains(&"--include-existing".to_string()),
            entry != "setup"
        );
        assert_eq!(bearer.as_deref(), Some("access-2"));
        harness.stop().await;
    }
}

fn base64_url(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// One GET over a raw socket, the way a browser reaches the receiver.
async fn reqwest_get(url: &str) -> String {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let rest = url.strip_prefix("http://").unwrap();
    let (authority, path) = rest.split_at(rest.find('/').unwrap());
    let mut stream = tokio::net::TcpStream::connect(authority).await.unwrap();
    stream
        .write_all(format!("GET {path} HTTP/1.1\r\nHost: {authority}\r\n\r\n").as_bytes())
        .await
        .unwrap();
    let mut answer = String::new();
    let _ = stream.read_to_string(&mut answer).await;
    answer
}

#[tokio::test]
async fn choosing_another_account_bypasses_a_valid_saved_login() {
    let harness = Harness::start_with(|cloud, setup| {
        let (access, refresh) = cloud.issue();
        std::fs::create_dir_all(setup.home.join("app-data")).unwrap();
        std::fs::write(
            setup.home.join("app-data/cloud-session.json"),
            json!({"apiUrl": format!("{}/cloud", cloud.site_url), "accessToken": access,
                   "accessTokenExpiresAt": "2099-01-01T00:00:00Z", "refreshToken": refresh})
            .to_string(),
        )
        .unwrap();
    })
    .await;
    let mut client = harness.client().await;
    let started = client
        .ok(
            "account.sign_in",
            json!({"flow":"browser", "sharing":"selected"}),
        )
        .await;
    assert_eq!(started["state"], "pending_approval");
    assert!(started["verification_url_complete"]
        .as_str()
        .unwrap()
        .starts_with(&format!(
            "{}/cloud/api/auth/google/start?next=",
            harness.cloud.site_url
        )));
    assert!(harness.probe.calls("cloud").is_empty());
    client.ok("account.sign_in.cancel", json!({})).await;
    harness.stop().await;
}

#[tokio::test]
async fn a_revoked_cli_login_falls_through_to_browser_without_changing_the_cli_file() {
    let harness = Harness::start_with(|cloud, setup| {
        write_cli_session(cloud, &setup.home);
        cloud.expire_access();
    })
    .await;
    let path = harness.home.join(".agentworkforce/relay/cloud-auth.json");
    let before = std::fs::read(&path).unwrap();
    let mut client = harness.client().await;
    client
        .ok("account.sign_in", json!({"sharing":"selected"}))
        .await;
    eventually("browser continuation", || {
        harness.account_state() == "pending_approval"
    })
    .await;
    let started = client.ok("account.status", json!({})).await;
    assert_eq!(started["phase"], "waiting_for_browser");
    assert!(started["verification_url_complete"]
        .as_str()
        .unwrap()
        .starts_with(&format!(
            "{}/cloud/api/v1/cli/login?",
            harness.cloud.site_url
        )));
    assert_eq!(std::fs::read(&path).unwrap(), before);
    assert!(harness.probe.calls("cloud").is_empty());
    let link = started["verification_url_complete"].as_str().unwrap();
    let redirect = link
        .split("redirect_uri=")
        .nth(1)
        .unwrap()
        .split('&')
        .next()
        .unwrap();
    let (handoff, _) = harness.cloud.issue();
    let accepted = reqwest_get(&format!(
        "{redirect}?access_token={handoff}&api_url={}/cloud",
        harness.cloud.site_url
    ))
    .await;
    assert!(accepted.starts_with("HTTP/1.1 200"));
    eventually("signed in", || harness.account_state() == "signed_in").await;
    assert_eq!(harness.store()["cloudSession"]["refreshToken"], "refresh-3");
    assert_eq!(std::fs::read(&path).unwrap(), before);
    harness.stop().await;
}

#[tokio::test]
async fn revoked_saved_credentials_continue_to_browser_in_the_same_attempt() {
    let harness = Harness::start_with(|cloud, setup| {
        let (access, refresh) = cloud.issue();
        std::fs::create_dir_all(setup.home.join("app-data")).unwrap();
        std::fs::write(
            setup.home.join("app-data/cloud-session.json"),
            json!({"apiUrl":format!("{}/cloud",cloud.site_url),"accessToken":access,
                "accessTokenExpiresAt":"2099-01-01T00:00:00Z","refreshToken":refresh})
            .to_string(),
        )
        .unwrap();
        cloud.expire_access();
        cloud.state.lock().unwrap().refresh_tokens.clear();
    })
    .await;
    let mut client = harness.client().await;
    client
        .ok("account.sign_in", json!({"sharing":"selected"}))
        .await;
    eventually("browser after saved rejection", || {
        harness.account_state() == "pending_approval"
    })
    .await;
    let report = client.ok("account.status", json!({})).await;
    let link = report["verification_url_complete"].as_str().unwrap();
    assert!(link.starts_with(&format!(
        "{}/cloud/api/v1/cli/login?",
        harness.cloud.site_url
    )));
    let redirect = link
        .split("redirect_uri=")
        .nth(1)
        .unwrap()
        .split('&')
        .next()
        .unwrap();
    let (handoff, _) = harness.cloud.issue();
    assert!(reqwest_get(&format!(
        "{redirect}?access_token={handoff}&api_url={}/cloud",
        harness.cloud.site_url
    ))
    .await
    .starts_with("HTTP/1.1 200"));
    eventually("signed in", || harness.account_state() == "signed_in").await;
    assert_eq!(harness.store()["cloudSession"]["refreshToken"], "refresh-3");
    assert_eq!(
        harness
            .cloud
            .requests("/cloud/api/v1/auth/token/refresh")
            .len(),
        1
    );
    harness.stop().await;
}

#[tokio::test]
async fn setup_status_exposes_a_browser_link_that_arrives_after_cli_rejection() {
    let gate = Arc::new(tokio::sync::Notify::new());
    let response_gate = gate.clone();
    let harness = Harness::start_with(move |cloud, setup| {
        write_cli_session(cloud, &setup.home);
        cloud.expire_access();
        cloud.state.lock().unwrap().whoami_gate = Some(response_gate);
    })
    .await;
    let started = tokio::time::timeout(
        Duration::from_secs(1),
        harness.setup_sign_in(json!({"flow":"browser"})),
    )
    .await
    .expect("setup must return before Cloud answers")
    .unwrap();
    assert_eq!(started["status"], "preparing");
    gate.notify_one();
    eventually("browser continuation", || {
        harness.account_state() == "pending_approval"
    })
    .await;
    let status = harness
        .setup_request("GET /setup/status", json!({}))
        .await
        .unwrap();
    assert_eq!(status["sign_in"], "pending_approval");
    assert_eq!(status["sign_in_phase"], "waiting_for_browser");
    assert!(status["verification_url_complete"]
        .as_str()
        .unwrap()
        .starts_with(&format!(
            "{}/cloud/api/v1/cli/login?",
            harness.cloud.site_url
        )));
    assert!(status["user_code"].is_null());
    let mut client = harness.client().await;
    client.ok("account.sign_in.cancel", json!({})).await;
    harness.stop().await;
}

#[tokio::test]
async fn saved_session_refresh_does_not_block_sign_in_or_cancellation() {
    for (cancel, fresh) in [(false, false), (true, false), (true, true)] {
        let gate = Arc::new(tokio::sync::Notify::new());
        let response_gate = gate.clone();
        let harness = Harness::start_with(move |cloud, setup| {
            let (access, refresh) = cloud.issue();
            cloud.state.lock().unwrap().refresh_gate = Some(response_gate);
            if fresh { cloud.expire_access(); }
            std::fs::create_dir_all(setup.home.join("app-data")).unwrap();
            std::fs::write(
                setup.home.join("app-data/cloud-session.json"),
                json!({"apiUrl":format!("{}/cloud",cloud.site_url),"accessToken":access,
                    "accessTokenExpiresAt": if fresh { "2099-01-01T00:00:00Z" } else { "2000-01-01T00:00:00Z" },"refreshToken":refresh})
                .to_string(),
            )
            .unwrap();
        })
        .await;
        let mut client = harness.client().await;
        let started = tokio::time::timeout(
            Duration::from_secs(1),
            client.ok("account.sign_in", json!({"sharing":"selected"})),
        )
        .await
        .expect("sign-in must not wait for saved-session refresh");
        assert_eq!(started["state"], "preparing");
        eventually("refresh request", || {
            !harness
                .cloud
                .requests("/cloud/api/v1/auth/token/refresh")
                .is_empty()
        })
        .await;
        if cancel {
            client.ok("account.sign_in.cancel", json!({})).await;
            assert_eq!(harness.account_state(), "signed_out");
            assert_eq!(harness.store()["cloudSession"]["refreshToken"], "refresh-1");
        }
        gate.notify_one();
        eventually("rotated token retained", || {
            harness.store()["cloudSession"]["refreshToken"] == "refresh-2"
        })
        .await;
        if !cancel {
            eventually("signed in", || harness.account_state() == "signed_in").await;
        } else {
            assert_eq!(harness.account_state(), "signed_out");
            assert!(harness.probe.calls("cloud").is_empty());
        }
        harness.stop().await;
    }
}

#[tokio::test]
async fn cancelling_account_switch_restores_the_rotated_saved_session() {
    let gate = Arc::new(tokio::sync::Notify::new());
    let response_gate = gate.clone();
    let harness = Harness::start_with(move |cloud, setup| {
        let (access, refresh) = cloud.issue();
        cloud.state.lock().unwrap().refresh_gate = Some(response_gate);
        setup.probe.state.lock().unwrap().hold_install = true;
        std::fs::create_dir_all(setup.home.join("app-data")).unwrap();
        std::fs::write(
            setup.home.join("app-data/cloud-session.json"),
            json!({"apiUrl":format!("{}/cloud",cloud.site_url),"accessToken":access,
                "accessTokenExpiresAt":"2000-01-01T00:00:00Z","refreshToken":refresh})
            .to_string(),
        )
        .unwrap();
    })
    .await;
    let mut client = harness.client().await;
    client
        .ok("account.sign_in", json!({"sharing":"selected"}))
        .await;
    eventually("refresh rotated remotely", || {
        !harness
            .cloud
            .requests("/cloud/api/v1/auth/token/refresh")
            .is_empty()
    })
    .await;
    client.ok("account.sign_in.cancel", json!({})).await;
    let report = client
        .ok(
            "account.sign_in",
            json!({"sharing":"selected","flow":"browser"}),
        )
        .await;
    let link = report["verification_url_complete"]
        .as_str()
        .unwrap()
        .replace("%3D", "=")
        .replace("%26", "&");
    let redirect = link
        .split("redirect_uri=")
        .nth(1)
        .unwrap()
        .split('&')
        .next()
        .unwrap();
    let (handoff, _) = harness.cloud.issue();
    assert!(reqwest_get(&format!(
        "{redirect}?access_token={handoff}&api_url={}/cloud",
        harness.cloud.site_url
    ))
    .await
    .starts_with("HTTP/1.1 200"));
    eventually("new account validated", || {
        !harness
            .cloud
            .requests("/cloud/api/v1/auth/whoami")
            .is_empty()
    })
    .await;
    // The new attempt must not capture an undo snapshot until the old refresh
    // returns. Without synchronization this observation completes immediately.
    let replaced_early = tokio::time::timeout(Duration::from_millis(200), async {
        while harness.store()["cloudSession"]["refreshToken"] != "refresh-4" {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await;
    assert!(
        replaced_early.is_err(),
        "account switch raced the rotating saved credentials"
    );
    gate.notify_one();
    eventually("new account install", || {
        !harness.probe.calls("cloud").is_empty()
    })
    .await;
    assert_eq!(harness.store()["cloudSession"]["refreshToken"], "refresh-4");
    client.ok("account.sign_in.cancel", json!({})).await;
    assert_eq!(harness.store()["cloudSession"]["refreshToken"], "refresh-2");
    assert!(harness
        .cloud
        .state
        .lock()
        .unwrap()
        .refresh_tokens
        .contains_key("refresh-2"));
    harness.stop().await;
}

#[tokio::test]
async fn cli_identity_validation_is_background_work_and_is_not_duplicated() {
    for status in [None, Some(503)] {
        let gate = Arc::new(tokio::sync::Notify::new());
        let response_gate = gate.clone();
        let harness = Harness::start_with(move |cloud, setup| {
            write_cli_session(cloud, &setup.home);
            let mut state = cloud.state.lock().unwrap();
            state.whoami_gate = Some(response_gate);
            state.whoami_status = status;
        })
        .await;
        let mut client = harness.client().await;
        // Cloud cannot answer until we release the gate. The RPC must already
        // have returned, including when the eventual answer is a server error.
        let started = tokio::time::timeout(
            Duration::from_secs(1),
            client.ok("account.sign_in", json!({"sharing":"selected"})),
        )
        .await
        .expect("sign-in must not wait for Cloud's identity response");
        assert_eq!(started["state"], "preparing");
        eventually("identity request", || {
            !harness
                .cloud
                .requests("/cloud/api/v1/auth/whoami")
                .is_empty()
        })
        .await;
        gate.notify_one();
        let expected = if status.is_none() {
            "signed_in"
        } else {
            "error"
        };
        eventually(expected, || harness.account_state() == expected).await;
        assert_eq!(harness.cloud.requests("/cloud/api/v1/auth/whoami").len(), 1);
        if status.is_some() {
            assert!(
                client.ok("account.status", json!({})).await["verification_url_complete"].is_null()
            );
        }
        harness.stop().await;
    }
}

#[tokio::test]
async fn a_kept_session_is_reused_without_asking_the_person() {
    // The Linux app's former session file is imported into the store once.
    let issued = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    let seen = issued.clone();
    let harness = Harness::start_with(move |cloud, setup| {
        let (access, refresh) = cloud.issue();
        *seen.lock().unwrap() = access.clone();
        std::fs::create_dir_all(setup.home.join("app-data")).unwrap();
        std::fs::write(
            setup.home.join("app-data/cloud-session.json"),
            json!({"apiUrl": format!("{}/cloud", cloud.site_url), "accessToken": access,
                       "accessTokenExpiresAt": "2099-01-01T00:00:00Z", "refreshToken": refresh})
            .to_string(),
        )
        .unwrap();
    })
    .await;
    let access = issued.lock().unwrap().clone();
    assert!(!harness.home.join("app-data/cloud-session.json").exists());
    assert_eq!(harness.store()["cloudSession"]["accessToken"], access);
    let mut client = harness.client().await;
    let started = client
        .ok("account.sign_in", json!({"sharing": "selected"}))
        .await;
    assert_eq!(started["state"], "preparing");
    eventually("signed in", || harness.account_state() == "signed_in").await;
    assert_eq!(
        client.ok("account.status", json!({})).await["reused_login"],
        true
    );
    assert!(harness
        .cloud
        .requests("/cloud/api/v1/auth/device/start")
        .is_empty());
    assert_eq!(
        harness.probe.calls("cloud")[0].1.as_deref(),
        Some(access.as_str())
    );
    harness.stop().await;
}

#[tokio::test]
async fn cloud_calls_refresh_a_refused_session_once_and_keep_the_rotated_one() {
    let harness = Harness::start_with(|_, setup| {
        setup.probe.state.lock().unwrap().installs = vec![];
    })
    .await;
    let mut client = harness.client().await;
    client
        .ok(
            "account.sign_in",
            json!({"sharing": "new", "flow": "device"}),
        )
        .await;
    eventually("signed in", || harness.account_state() == "signed_in").await;
    // Cloud revokes every access token server-side; the session still
    // looks fresh here.
    harness.cloud.expire_access();
    let people = client.ok("people.list", json!({})).await;
    assert_eq!(people["people"], json!([]));
    let refreshes = harness.cloud.requests("/cloud/api/v1/auth/token/refresh");
    assert_eq!(refreshes.len(), 1);
    assert_eq!(refreshes[0].body["refreshToken"], "refresh-1");
    let members = harness.cloud.requests("/cloud/api/v1/members");
    assert_eq!(members.len(), 2);
    assert_eq!(members[1].bearer.as_deref(), Some("access-2"));
    let store = harness.store();
    assert_eq!(store["cloudSession"]["refreshToken"], "refresh-2");

    // A session Cloud refuses outright is dropped, and the person asked to
    // sign in again.
    harness.cloud.expire_access();
    harness.cloud.state.lock().unwrap().refresh_tokens.clear();
    let (kind, message) = client.error("people.list", json!({})).await;
    assert_eq!(kind, "not_signed_in");
    assert!(message.contains("sign in again"), "{message}");
    assert!(harness.store()["cloudSession"].is_null());
    harness.stop().await;
}

#[tokio::test]
async fn sign_out_revokes_the_session_and_disconnects_the_uploader() {
    let harness = Harness::start().await;
    let mut client = harness.client().await;
    client
        .ok(
            "account.sign_in",
            json!({"sharing": "new", "flow": "device"}),
        )
        .await;
    eventually("signed in", || harness.account_state() == "signed_in").await;
    client.ok("account.sign_out", json!({})).await;
    assert_eq!(harness.account_state(), "signed_out");
    assert!(harness.store()["cloudSession"].is_null());
    assert!(harness.probe.state.lock().unwrap().cancelled >= 1);
    let disconnect = harness.probe.calls("disconnect");
    assert_eq!(disconnect.len(), 1);
    assert!(disconnect[0].0.windows(2).any(|w| w == ["--account", USER]));
    eventually("revoked", || {
        harness
            .cloud
            .requests("/cloud/api/v1/auth/token/revoke")
            .iter()
            .any(|r| r.body["token"] == "refresh-1")
    })
    .await;
    assert!(!harness
        .cloud
        .requests(&format!(
            "/cloud/api/v1/workspaces/{WORKSPACE}/messaging/desktop-identities"
        ))
        .is_empty());
    eventually("desktop identity clear committed", || {
        harness.store()["desktopIdentityClearsPending"].is_null()
    })
    .await;
    let (kind, _) = client.error("uploader.status", json!({})).await;
    assert_eq!(kind, "not_signed_in");
    assert!(harness.account.account().is_none());
    harness.stop().await;
}

#[tokio::test]
async fn a_setup_the_probe_refuses_reports_what_the_person_can_do() {
    let harness = Harness::start_with(|_, setup| {
        setup.probe.state.lock().unwrap().install_error = Some(
            "Could not inspect older upload schedules. Check them, then retry with --acknowledge-uninspected-schedules."
                .into(),
        );
    })
    .await;
    let mut client = harness.client().await;
    client
        .ok(
            "account.sign_in",
            json!({"sharing": "new", "flow": "device"}),
        )
        .await;
    eventually("failed", || harness.account_state() == "error").await;
    let account = client.ok("account.status", json!({})).await;
    assert_eq!(account["action"], "acknowledge_uninspected_schedules");
    assert!(account["error"]
        .as_str()
        .unwrap()
        .contains("older upload schedules"));

    harness.probe.state.lock().unwrap().install_error = None;
    client
        .ok(
            "account.sign_in",
            json!({"sharing": "new", "flow": "device", "acknowledge_uninspected_schedules": true}),
        )
        .await;
    eventually("signed in", || harness.account_state() == "signed_in").await;
    let calls = harness.probe.calls("cloud");
    assert!(calls[1]
        .0
        .contains(&"--acknowledge-uninspected-schedules".to_string()));
    harness.stop().await;
}

#[tokio::test]
async fn a_declined_or_cancelled_device_sign_in_stops() {
    let harness = Harness::start_with(|cloud, _| {
        let mut state = cloud.state.lock().unwrap();
        state.pending_polls = 0;
        state.device_error = Some("access_denied");
    })
    .await;
    let mut client = harness.client().await;
    client
        .ok(
            "account.sign_in",
            json!({"sharing": "new", "flow": "device"}),
        )
        .await;
    eventually("declined", || harness.account_state() == "denied").await;
    assert!(harness.probe.calls("cloud").is_empty());

    harness.cloud.state.lock().unwrap().pending_polls = 100;
    let started = client
        .ok(
            "account.sign_in",
            json!({"sharing": "new", "flow": "device"}),
        )
        .await;
    assert_eq!(started["state"], "pending_approval");
    client.ok("account.sign_in.cancel", json!({})).await;
    assert_eq!(harness.account_state(), "signed_out");
    let after = client.ok("account.status", json!({})).await;
    assert!(after["verification_url"].is_null());
    harness.stop().await;
}

fn arrange_legacy_workspace(cloud: &FakeCloud, setup: &Harnessing) {
    let (access, refresh) = cloud.issue();
    std::fs::create_dir_all(setup.home.join("app-data")).unwrap();
    std::fs::write(
        setup.home.join("app-data/cloud-session.json"),
        json!({"apiUrl": format!("{}/cloud", cloud.site_url), "accessToken": access,
            "accessTokenExpiresAt": "2099-01-01T00:00:00Z", "refreshToken": refresh})
        .to_string(),
    )
    .unwrap();
    setup.probe.state.lock().unwrap().installs = vec![FakeProbe::connected(&cloud.site_url)];
    *setup.supervise_every.lock().unwrap() = Some(Duration::from_millis(20));
    cloud.state.lock().unwrap().resolve_status = 503;
}

#[tokio::test]
async fn legacy_workspace_name_loads_without_relaycast_and_is_not_refetched() {
    let harness = Harness::start_with(arrange_legacy_workspace).await;
    eventually("Cloud workspace name", || {
        harness.account.status().workspace_name.as_deref() == Some("Acme")
    })
    .await;
    assert_eq!(
        harness.account.status().workspace_id.as_deref(),
        Some(WORKSPACE)
    );
    assert!(harness.store()["cloud"].is_null());
    assert_eq!(harness.account.status().workspace_count, Some(1));
    assert_eq!(
        harness.account.status().workspace_avatar_url.as_deref(),
        Some("https://example.com/workspace.png")
    );
    let requests = harness.cloud.requests("/cloud/api/v1/auth/whoami").len();
    assert_eq!(requests, 1);
    // Let supervision run again: loading a label must not continually fetch it.
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(
        harness.cloud.requests("/cloud/api/v1/auth/whoami").len(),
        requests
    );
    assert!(harness.probe.calls("cloud").is_empty());
    harness.stop().await;
}

#[tokio::test]
async fn existing_install_requests_cloud_profile_repair_without_client_pii() {
    let harness = Harness::start_with(arrange_legacy_workspace).await;
    eventually("authenticated profile bootstrap", || {
        harness.account.status().workspace_count == Some(1)
    })
    .await;
    let requests = harness.cloud.requests("/cloud/api/v1/auth/whoami");
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].analytics.as_deref(), Some("enabled"));
    assert!(requests[0].bearer.is_some());
    assert_eq!(requests[0].body, Value::Null);
    for event in harness.analytics() {
        let properties = &event["properties"];
        assert!(properties.get("email").is_none());
        assert!(properties.get("name").is_none());
        assert!(properties.get("$set").is_none());
    }
    harness.stop().await;
}

#[tokio::test]
async fn opted_out_install_loads_account_without_profile_repair_or_events() {
    let harness = Harness::start_with(|cloud, setup| {
        arrange_legacy_workspace(cloud, setup);
        for directory in [
            setup.home.join("app-data"),
            setup.home.join(".config/com.agentrelay.desktop"),
        ] {
            std::fs::create_dir_all(&directory).unwrap();
            std::fs::write(
                directory.join("preferences.json"),
                r#"{"analytics_enabled":false}"#,
            )
            .unwrap();
        }
    })
    .await;
    eventually("ordinary account bootstrap", || {
        harness.account.status().workspace_count == Some(1)
    })
    .await;
    assert!(!harness.telemetry.enabled());
    assert!(harness
        .cloud
        .requests("/cloud/api/v1/auth/whoami")
        .iter()
        .all(|r| r.analytics.is_none()));
    assert!(harness.analytics().is_empty());
    harness.stop().await;
}

#[tokio::test]
async fn whoami_preserves_canonical_id_and_retries_eligible_profile_request() {
    use agent_relay_probe::relay::cloud_session::{whoami, whoami_with_analytics};
    let cloud = FakeCloud::start().await;
    let (access, _) = cloud.issue();
    let bearer = Secret::new(access);
    cloud.state.lock().unwrap().whoami_user = "usr_cloud_canonical".into();
    cloud.state.lock().unwrap().whoami_status = Some(503);
    assert!(whoami_with_analytics(&cloud.site_url, &bearer, true)
        .await
        .is_err());
    cloud.state.lock().unwrap().whoami_status = None;
    let identity = whoami_with_analytics(&cloud.site_url, &bearer, true)
        .await
        .unwrap();
    assert_eq!(identity.user_id, "usr_cloud_canonical");
    whoami(&cloud.site_url, &bearer).await.unwrap();
    let requests = cloud.requests("/cloud/api/v1/auth/whoami");
    assert_eq!(
        requests
            .iter()
            .map(|r| r.analytics.as_deref())
            .collect::<Vec<_>>(),
        [Some("enabled"), Some("enabled"), None]
    );
    assert!(requests
        .iter()
        .all(|r| r.bearer.as_deref() == Some(bearer.expose())));
}

#[tokio::test]
async fn workspace_avatar_metadata_reports_multiple_memberships() {
    let harness = Harness::start_with(|cloud, setup| {
        arrange_legacy_workspace(cloud, setup);
        cloud.state.lock().unwrap().whoami_workspace_count = 2;
    })
    .await;
    eventually("workspace membership metadata", || {
        harness.account.status().workspace_count == Some(2)
    })
    .await;
    assert_eq!(
        harness.account.status().workspace_avatar_url.as_deref(),
        Some("https://example.com/workspace.png")
    );
    harness.stop().await;
}

#[tokio::test]
async fn legacy_workspace_name_rejects_another_workspace_or_person() {
    for wrong_person in [false, true] {
        let harness = Harness::start_with(move |cloud, setup| {
            arrange_legacy_workspace(cloud, setup);
            let mut state = cloud.state.lock().unwrap();
            if wrong_person {
                state.whoami_user = "another-person".into();
            } else {
                state.whoami_workspace = "another-workspace".into();
            }
        })
        .await;
        eventually("name lookup", || {
            !harness
                .cloud
                .requests("/cloud/api/v1/auth/whoami")
                .is_empty()
        })
        .await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(harness.account.status().workspace_name, None);
        assert_eq!(harness.account.status().workspace_count, None);
        assert_eq!(harness.account.status().workspace_avatar_url, None);
        assert_eq!(
            harness.account.status().workspace_id.as_deref(),
            Some(WORKSPACE)
        );
        harness.stop().await;
    }
}

#[tokio::test]
async fn an_existing_connection_is_found_at_start_and_the_uploader_answers() {
    let harness = Harness::start_with(|cloud, setup| {
        let mut state = setup.probe.state.lock().unwrap();
        state.installs = vec![FakeProbe::connected(&cloud.site_url)];
        state.status = json!({"running": false, "paused": false, "sharing_mode": "new",
            "delivery": {"bootstrap_complete": true, "pending_records": 0}, "sessions": {"shared": 0, "total": 0}});
    })
    .await;
    eventually("discovered", || harness.account_state() == "signed_in").await;
    let mut client = harness.client().await;
    let status = client.ok("uploader.status", json!({})).await;
    assert_eq!(status["stage"], "not_running");
    assert_eq!(status["needs_start"], true);
    // Where the install keeps its collector log.
    assert_eq!(status["directory"], "/tmp/x");
    // Supervision starts a stopped collector at launch, as the app did.
    eventually("supervised start", || {
        harness.probe.calls("start").len() == 1
    })
    .await;
    client.ok("uploader.start", json!({})).await;
    assert_eq!(harness.probe.calls("start").len(), 2);
    let sharing = client
        .ok("uploader.sharing.set", json!({"mode": "selected"}))
        .await;
    assert_eq!(sharing, json!({"sharing_mode": "selected"}));
    let sessions = client.ok("uploader.sessions.list", json!({})).await;
    assert_eq!(sessions["sessions"].as_array().unwrap().len(), 1);
    let updated = client
        .ok(
            "uploader.sessions.include",
            json!({"session_keys": ["codex:a"]}),
        )
        .await;
    assert_eq!(updated, json!({"updated": 1}));
    let (kind, _) = client
        .error(
            "uploader.sessions.exclude",
            json!({"session_keys": ["no-colon"]}),
        )
        .await;
    assert_eq!(kind, "invalid_params");
    let (kind, _) = client
        .error("uploader.sharing.set", json!({"mode": "everything"}))
        .await;
    assert_eq!(kind, "invalid_params");
    harness.stop().await;
}

#[tokio::test]
async fn connect_workspace_resolves_with_the_kept_session() {
    let harness = Harness::start_with(|cloud, setup| {
        let (access, refresh) = cloud.issue();
        std::fs::create_dir_all(setup.home.join("app-data")).unwrap();
        std::fs::write(
            setup.home.join("app-data/injectable-agents.json"),
            json!({"registrations": [], "tokens": {}, "cloudSession": {
                    "accessToken": access, "refreshToken": refresh, "siteURL": cloud.site_url}})
            .to_string(),
        )
        .unwrap();
    })
    .await;
    let mut client = harness.client().await;
    let (kind, _) = client
        .error("account.connect_workspace", json!({"workspace_id": "acme"}))
        .await;
    assert_eq!(kind, "invalid_params");
    let workspace = client
        .ok(
            "account.connect_workspace",
            json!({"workspace_id": WORKSPACE}),
        )
        .await;
    assert_eq!(workspace["state"], "found");
    assert_eq!(harness.store()["cloud"]["key"], ACCOUNT_KEY);
    harness.stop().await;
}

#[tokio::test]
async fn the_bridge_lists_every_account_method_and_the_sign_in_topic() {
    let harness = Harness::start().await;
    let mut client = harness.client().await;
    let hello = client.ok("hello", json!({"bridge_version": 2})).await;
    let methods: Vec<&str> = hello["methods"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m.as_str().unwrap())
        .collect();
    for method in [
        "account.sign_in",
        "account.sign_in.cancel",
        "account.sign_out",
        "account.connect_workspace",
        "account.status",
        "uploader.status",
        "uploader.sessions.preview",
        "telemetry.record",
        "login_item.set",
        "login_item.status",
        "chat.send",
        "contractors.status",
    ] {
        assert!(methods.contains(&method), "{method}");
    }
    assert!(hello["topics"]
        .as_array()
        .unwrap()
        .contains(&json!("sign_in")));
    assert!(!methods.contains(&"credential_proxy.status"));
    let preview = client.ok("uploader.sessions.preview", json!({})).await;
    assert_eq!(preview, json!({"sessions": []}));
    harness.stop().await;
}

#[tokio::test]
async fn a_sign_out_whose_disconnect_fails_stays_signed_out_and_the_next_sign_in_retries_it() {
    let harness = Harness::start().await;
    let mut client = harness.client().await;
    client
        .ok(
            "account.sign_in",
            json!({"sharing": "new", "flow": "device"}),
        )
        .await;
    eventually("signed in", || harness.account_state() == "signed_in").await;
    harness.probe.state.lock().unwrap().disconnect_fails = true;
    let (kind, message) = client.error("account.sign_out", json!({})).await;
    assert_eq!(kind, "uploader_failed");
    assert!(
        message.contains("Could not finish disconnecting"),
        "{message}"
    );
    assert!(message.contains("busy"), "{message}");
    assert_eq!(harness.account_state(), "signed_out");
    assert!(harness.store()["cloudSession"].is_null());

    // Still failing: the next sign-in does not start over a live connection.
    let (kind, _) = client
        .error(
            "account.sign_in",
            json!({"sharing": "new", "flow": "device"}),
        )
        .await;
    assert_eq!(kind, "uploader_failed");
    assert_eq!(harness.probe.calls("cloud").len(), 1);

    harness.probe.state.lock().unwrap().disconnect_fails = false;
    client
        .ok(
            "account.sign_in",
            json!({"sharing": "new", "flow": "device"}),
        )
        .await;
    eventually("signed in again", || harness.account_state() == "signed_in").await;
    assert_eq!(harness.probe.calls("disconnect").len(), 3);
    assert_eq!(harness.probe.calls("cloud").len(), 2);
    harness.stop().await;
}

#[tokio::test]
async fn an_install_for_another_site_is_not_this_app_s_connection() {
    let harness = Harness::start_with(|_, setup| {
        setup.probe.state.lock().unwrap().installs =
            vec![FakeProbe::connected("https://agentrelay.com")];
    })
    .await;
    eventually("discovery ran", || {
        !harness.probe.calls("installs").is_empty()
    })
    .await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(harness.account_state(), "signed_out");
    assert!(harness.account.account().is_none());
    harness.stop().await;
}

#[tokio::test]
async fn a_browser_sign_in_whose_exchange_fails_keeps_the_handoff_session() {
    let harness = Harness::start().await;
    let mut client = harness.client().await;
    let started = client
        .ok(
            "account.sign_in",
            json!({"sharing": "new", "flow": "browser"}),
        )
        .await;
    let link = started["verification_url_complete"]
        .as_str()
        .unwrap()
        .replace("%3D", "=")
        .replace("%26", "&");
    let redirect = link
        .split("redirect_uri=")
        .nth(1)
        .unwrap()
        .split('&')
        .next()
        .unwrap()
        .to_string();
    harness.cloud.state.lock().unwrap().exchange_fails = true;
    let (handoff, _) = harness.cloud.issue();
    let answer = reqwest_get(&format!(
        "{redirect}?access_token={handoff}&api_url={}/cloud&access_token_expires_at=2099-01-01T00:00:00Z",
        harness.cloud.site_url
    ))
    .await;
    assert!(answer.starts_with("HTTP/1.1 200"));
    eventually("signed in", || harness.account_state() == "signed_in").await;
    let store = harness.store();
    assert_eq!(store["cloudSession"]["accessToken"], handoff_of(&harness));
    assert!(store["cloudSession"]["refreshToken"].is_null());
    assert_eq!(
        harness.probe.calls("cloud")[0].1.as_deref(),
        Some(handoff_of(&harness).as_str())
    );
    harness.stop().await;
}

/// The last access token the fake Cloud issued.
fn handoff_of(harness: &Harness) -> String {
    format!("access-{}", harness.cloud.state.lock().unwrap().minted)
}

#[tokio::test]
async fn messaging_uses_the_account_workspace_over_this_computers_relay() {
    let harness = Harness::start_with(|_, setup| {
        let relay = setup.home.join(".agentworkforce/relay");
        std::fs::create_dir_all(&relay).unwrap();
        std::fs::write(
            relay.join("workspace-key.json"),
            json!({"workspaceKey": "rk_live_node_key_0001", "workspaceId": "rw_node"}).to_string(),
        )
        .unwrap();
    })
    .await;
    let mut client = harness.client().await;
    client
        .ok(
            "account.sign_in",
            json!({"sharing": "new", "flow": "device"}),
        )
        .await;
    eventually("signed in", || harness.account_state() == "signed_in").await;
    eventually("the account workspace", || {
        harness.core.workspace().map(|w| w.key.expose().to_string()) == Some(ACCOUNT_KEY.into())
    })
    .await;
    let status = client.ok("status.get", json!({})).await;
    assert_eq!(status["workspace"]["workspace_id"], "rw_acme");
    assert!(status["workspace"].get("source").is_none());
    assert!(status["account"].get("workspace_mismatch").is_none());
    harness.stop().await;
}

#[tokio::test]
async fn a_rate_limited_refresh_keeps_the_session_for_a_later_try() {
    let harness = Harness::start().await;
    let mut client = harness.client().await;
    client
        .ok(
            "account.sign_in",
            json!({"sharing": "new", "flow": "device"}),
        )
        .await;
    eventually("signed in", || harness.account_state() == "signed_in").await;
    harness.cloud.expire_access();
    for status in [429, 408] {
        harness.cloud.state.lock().unwrap().refresh_status = Some(status);
        let (kind, _) = client.error("people.list", json!({})).await;
        assert_ne!(kind, "not_signed_in", "HTTP {status}");
        assert_eq!(
            harness.store()["cloudSession"]["refreshToken"],
            "refresh-1",
            "HTTP {status}"
        );
    }
    harness.cloud.state.lock().unwrap().refresh_status = None;
    client.ok("people.list", json!({})).await;
    assert_eq!(harness.store()["cloudSession"]["refreshToken"], "refresh-2");
    harness.stop().await;
}

/// The official CLI's live session for `cloud`, as `cloud-auth.json`.
fn write_cli_session(cloud: &FakeCloud, home: &std::path::Path) -> String {
    let (access, _) = cloud.issue();
    let relay = home.join(".agentworkforce/relay");
    std::fs::create_dir_all(&relay).unwrap();
    std::fs::write(
        relay.join("cloud-auth.json"),
        json!({"apiUrl": format!("{}/cloud", cloud.site_url), "accessToken": access,
               "accessTokenExpiresAt": "2099-01-01T00:00:00Z"})
        .to_string(),
    )
    .unwrap();
    access
}

#[tokio::test]
async fn a_sign_in_while_connected_with_no_usable_session_keeps_one_and_leaves_the_uploader() {
    // Connected by the uploader, borrowing the official CLI's login, whose
    // access token has since expired: Cloud calls as the person fail.
    let harness = Harness::start_with(|cloud, setup| {
        setup.probe.state.lock().unwrap().installs = vec![FakeProbe::connected(&cloud.site_url)];
        let (access, _) = cloud.issue();
        let relay = setup.home.join(".agentworkforce/relay");
        std::fs::create_dir_all(&relay).unwrap();
        std::fs::write(
            relay.join("cloud-auth.json"),
            json!({"apiUrl": format!("{}/cloud", cloud.site_url), "accessToken": access,
                   "accessTokenExpiresAt": "2000-01-01T00:00:00Z"})
            .to_string(),
        )
        .unwrap();
    })
    .await;
    eventually("discovered", || harness.account_state() == "signed_in").await;
    let mut client = harness.client().await;
    let (kind, _) = client.error("people.list", json!({})).await;
    assert_eq!(kind, "not_signed_in");

    // Signing in again asks the person, keeping who is connected meanwhile.
    let started = client
        .ok(
            "account.sign_in",
            json!({"sharing": "new", "flow": "device"}),
        )
        .await;
    assert_eq!(started["state"], "pending_approval");
    assert_eq!(started["phase"], "waiting_for_device_approval");
    assert_eq!(started["user_code"], "ABCD-EFGH");
    assert_eq!(started["person"]["id"], USER);

    eventually("kept", || {
        harness.store()["cloudSession"]["accessToken"].is_string()
    })
    .await;
    eventually("signed in", || harness.account_state() == "signed_in").await;
    // The uploader's connection was left alone: no second install.
    assert!(harness.probe.calls("cloud").is_empty());
    let kept = harness.store()["cloudSession"]["accessToken"]
        .as_str()
        .unwrap()
        .to_string();
    client.ok("people.list", json!({})).await;
    let members = harness.cloud.requests("/cloud/api/v1/members");
    assert_eq!(
        members.last().unwrap().bearer.as_deref(),
        Some(kept.as_str())
    );

    // With a usable session, a sign-in while connected asks nothing.
    let again = client
        .ok(
            "account.sign_in",
            json!({"sharing": "new", "flow": "device"}),
        )
        .await;
    assert_eq!(again["state"], "signed_in");
    harness.stop().await;
}

#[tokio::test]
async fn the_cli_s_session_is_used_only_when_no_session_is_kept_for_the_site() {
    // Nothing kept: Cloud calls go as the official CLI's signed-in person.
    let cli = Arc::new(Mutex::new(String::new()));
    let seen = cli.clone();
    let harness = Harness::start_with(move |cloud, setup| {
        setup.probe.state.lock().unwrap().installs = vec![FakeProbe::connected(&cloud.site_url)];
        *seen.lock().unwrap() = write_cli_session(cloud, &setup.home);
    })
    .await;
    eventually("discovered", || harness.account_state() == "signed_in").await;
    let mut client = harness.client().await;
    client.ok("people.list", json!({})).await;
    let members = harness.cloud.requests("/cloud/api/v1/members");
    assert_eq!(members.len(), 1);
    assert_eq!(
        members[0].bearer.as_deref(),
        Some(cli.lock().unwrap().as_str())
    );
    harness.stop().await;

    // A kept session that cannot be renewed never falls back to the CLI's,
    // which may be someone else.
    let harness = Harness::start_with(|cloud, setup| {
        setup.probe.state.lock().unwrap().installs = vec![FakeProbe::connected(&cloud.site_url)];
        write_cli_session(cloud, &setup.home);
        std::fs::create_dir_all(setup.home.join("app-data")).unwrap();
        std::fs::write(
            setup.home.join("app-data/cloud-session.json"),
            json!({"apiUrl": format!("{}/cloud", cloud.site_url), "accessToken": "access-old",
                   "accessTokenExpiresAt": "2000-01-01T00:00:00Z", "refreshToken": "refresh-unknown"})
            .to_string(),
        )
        .unwrap();
    })
    .await;
    eventually("discovered", || harness.account_state() == "signed_in").await;
    let mut client = harness.client().await;
    let (kind, _) = client.error("people.list", json!({})).await;
    assert_eq!(kind, "not_signed_in");
    assert!(harness.cloud.requests("/cloud/api/v1/members").is_empty());
    harness.stop().await;
}

fn operation<'a>(events: &'a [Value], operation: &str, outcome: &str) -> Option<&'a Value> {
    events.iter().rev().find(|event| {
        event["event"] == "desktop_operation"
            && event["properties"]["operation"] == operation
            && event["properties"]["outcome"] == outcome
    })
}

#[tokio::test]
async fn analytics_belong_to_the_user_once_the_install_attaches_until_sign_out() {
    let harness = Harness::start().await;
    let mut client = harness.client().await;
    client
        .ok(
            "telemetry.record",
            json!({"operation": "app_launch", "outcome": "started"}),
        )
        .await;
    let launch = harness.analytics()[0].clone();
    let anonymous = launch["distinct_id"].as_str().unwrap().to_string();
    assert!(anonymous.starts_with("desktop:"));
    assert_eq!(launch["properties"]["$process_person_profile"], false);

    client
        .ok(
            "account.sign_in",
            json!({"sharing": "new", "flow": "device"}),
        )
        .await;
    eventually("signed in", || harness.account_state() == "signed_in").await;
    let events = harness.analytics();
    let identifies: Vec<&Value> = events
        .iter()
        .filter(|e| e["event"] == "$identify")
        .collect();
    assert_eq!(identifies.len(), 1, "{events:?}");
    assert_eq!(identifies[0]["distinct_id"], USER);
    assert_eq!(identifies[0]["properties"]["$anon_distinct_id"], anonymous);
    let groups = json!({"organization": ORG, "workspace": WORKSPACE});
    assert_eq!(identifies[0]["properties"]["$groups"], groups);
    let ready = operation(&events, "history_setup", "succeeded").unwrap();
    assert_eq!(ready["distinct_id"], USER);
    assert_eq!(ready["properties"]["$groups"], groups);
    assert!(ready["properties"].get("$process_person_profile").is_none());

    client.ok("account.sign_out", json!({})).await;
    client
        .ok(
            "telemetry.record",
            json!({"operation": "sign_in", "outcome": "started"}),
        )
        .await;
    let events = harness.analytics();
    let after = operation(&events, "sign_in", "started").unwrap();
    let rotated = after["distinct_id"].as_str().unwrap();
    assert!(
        rotated.starts_with("desktop:") && rotated != anonymous,
        "{rotated}"
    );
    assert_eq!(after["properties"]["$process_person_profile"], false);
    harness.stop().await;
}

#[tokio::test]
async fn a_cancelled_setup_never_links_analytics() {
    let harness = Harness::start_with(|_, setup| {
        setup.probe.state.lock().unwrap().hold_install = true;
    })
    .await;
    let mut client = harness.client().await;
    client
        .ok(
            "account.sign_in",
            json!({"sharing": "new", "flow": "device"}),
        )
        .await;
    eventually("connected", || {
        harness.core.status().account.phase.as_deref() == Some("preparing_local_sessions")
    })
    .await;
    client.ok("account.sign_in.cancel", json!({})).await;
    let events = harness.analytics();
    assert!(!events.is_empty());
    assert!(
        events.iter().all(|e| e["event"] != "$identify"),
        "{events:?}"
    );
    assert!(events
        .iter()
        .all(|e| e["distinct_id"].as_str().unwrap().starts_with("desktop:")));
    harness.stop().await;
}

#[tokio::test]
async fn a_setup_cancelled_after_it_connected_disconnects_what_it_made() {
    let harness = Harness::start_with(|_, setup| {
        setup.probe.state.lock().unwrap().hold_install = true;
    })
    .await;
    let mut client = harness.client().await;
    client
        .ok(
            "account.sign_in",
            json!({"sharing": "new", "flow": "device"}),
        )
        .await;
    eventually("connected", || {
        harness.core.status().account.phase.as_deref() == Some("preparing_local_sessions")
    })
    .await;
    client.ok("account.sign_in.cancel", json!({})).await;
    assert_eq!(harness.account_state(), "signed_out");
    eventually("disconnected", || {
        harness
            .probe
            .calls("disconnect")
            .iter()
            .any(|(args, _)| args.windows(2).any(|w| w == ["--account", USER]))
    })
    .await;
    assert!(harness.probe.state.lock().unwrap().installs.is_empty());
    assert!(harness.account.uploader.install().is_none());
    assert_eq!(harness.account_state(), "signed_out");
    // Started signed out, so it ends signed out: the session and workspace
    // key this attempt kept are gone.
    assert!(harness.account.account().is_none());
    let store = harness.store();
    assert!(store["cloudSession"].is_null(), "{store}");
    assert!(store["cloud"].is_null(), "{store}");

    // Sign-out does the same for a setup still running.
    client
        .ok(
            "account.sign_in",
            json!({"sharing": "new", "flow": "device"}),
        )
        .await;
    eventually("connected again", || {
        harness.core.status().account.phase.as_deref() == Some("preparing_local_sessions")
    })
    .await;
    client.ok("account.sign_out", json!({})).await;
    assert_eq!(harness.probe.calls("disconnect").len(), 2);
    assert!(harness.probe.state.lock().unwrap().installs.is_empty());
    assert_eq!(harness.account_state(), "signed_out");
    harness.stop().await;
}

#[tokio::test]
async fn a_cancelled_setup_that_reused_a_kept_session_leaves_it_kept() {
    let harness = Harness::start().await;
    let mut client = harness.client().await;
    client
        .ok(
            "account.sign_in",
            json!({"sharing": "new", "flow": "device"}),
        )
        .await;
    eventually("signed in", || harness.account_state() == "signed_in").await;
    client.ok("uploader.disconnect", json!({})).await;
    let account = harness.account.account();
    assert!(account.is_some());
    let kept = harness.store();

    harness.probe.state.lock().unwrap().hold_install = true;
    let started = client
        .ok(
            "account.sign_in",
            json!({"sharing": "new", "flow": "device"}),
        )
        .await;
    assert_eq!(started["reused_login"], true);
    eventually("connected", || {
        harness.core.status().account.phase.as_deref() == Some("preparing_local_sessions")
    })
    .await;
    client.ok("account.sign_in.cancel", json!({})).await;
    eventually("disconnected", || {
        harness.probe.state.lock().unwrap().installs.is_empty()
    })
    .await;
    assert_eq!(harness.account.account(), account);
    let store = harness.store();
    assert_eq!(store["cloudSession"], kept["cloudSession"]);
    assert_eq!(store["cloud"], kept["cloud"]);
    harness.stop().await;
}

#[tokio::test]
async fn a_sign_in_that_fails_after_connecting_is_attached_and_its_mailbox_activated() {
    let network = Arc::new(FakeMailbox::default());
    let mailbox = network.clone();
    let harness = Harness::start_with(move |_, setup| {
        let mut probe = setup.probe.state.lock().unwrap();
        probe.fail_after_connected = Some("RelayHistory is unavailable.".into());
        probe.status_fails = true;
        drop(probe);
        *setup.supervise_every.lock().unwrap() = Some(Duration::from_millis(100));
        *setup.mailbox.lock().unwrap() = Some(mailbox);
    })
    .await;
    let mut client = harness.client().await;
    client
        .ok(
            "account.sign_in",
            json!({"sharing": "new", "flow": "device"}),
        )
        .await;
    // The sign-in never reaches its end, so it activates nothing itself.
    eventually("the setup failed", || {
        harness.account_state() == "error" || harness.account_state() == "signed_in"
    })
    .await;
    eventually("attached", || harness.account_state() == "signed_in").await;
    let incoming = harness.account.incoming.clone().unwrap();
    let mut connected = false;
    for _ in 0..100 {
        if incoming.scope().await.is_some() {
            connected = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(connected, "the mailbox was activated and connected");
    // No uploader status names a pause, so incoming delivers at once.
    assert_ne!(incoming.status().await.state, IncomingState::Paused);
    // With the kept session, the connection's own person.
    let kept = harness.store()["cloudSession"]["accessToken"]
        .as_str()
        .unwrap()
        .to_string();
    let requests = network.requests.lock().unwrap().clone();
    let room: Vec<_> = requests
        .iter()
        .filter(|(_, url, _)| url.ends_with("/room/session"))
        .collect();
    assert_eq!(room.len(), 1, "{requests:?}");
    assert_eq!(room[0].2, kept);
    harness.stop().await;
}

/// A daemon attached to this computer's connection, with incoming messages
/// over `network` and supervision that ticks only at start.
async fn attached_with_mailbox(
    network: Arc<FakeMailbox>,
    keep: impl FnOnce(&FakeCloud, &Harnessing) + Send + 'static,
) -> Harness {
    let harness = Harness::start_with(move |cloud, setup| {
        setup.probe.state.lock().unwrap().installs = vec![FakeProbe::connected(&cloud.site_url)];
        *setup.supervise_every.lock().unwrap() = Some(Duration::from_secs(3600));
        *setup.mailbox.lock().unwrap() = Some(network);
        keep(cloud, setup);
    })
    .await;
    eventually("attached", || harness.account_state() == "signed_in").await;
    harness
}

fn keep_session(setup: &Harnessing, site: &str, access: &str, refresh: &str) {
    std::fs::create_dir_all(setup.home.join("app-data")).unwrap();
    std::fs::write(
        setup.home.join("app-data/injectable-agents.json"),
        json!({"registrations": [], "tokens": {}, "cloudSession": {
                "accessToken": access, "refreshToken": refresh, "siteURL": site}})
        .to_string(),
    )
    .unwrap();
}

/// An uploader whose job is blocked on `authentication_required`, as the
/// probe's `status --json` reports it.
fn blocked_on_sign_in() -> Value {
    json!({"running": true, "paused": false, "sharing_mode": "new",
        "delivery": {"bootstrap_complete": true, "pending_records": 3,
            "failure": "Uploads need you to sign in to Agent Relay again.",
            "failure_code": "authentication_required"},
        "sessions": {"shared": 1, "total": 1}})
}

/// A kept session whose access token expired long ago, as the legacy file
/// the store imports at start.
fn keep_expired_session(cloud: &FakeCloud, setup: &Harnessing) {
    let (access, refresh) = cloud.issue();
    std::fs::create_dir_all(setup.home.join("app-data")).unwrap();
    std::fs::write(
        setup.home.join("app-data/cloud-session.json"),
        json!({"apiUrl": format!("{}/cloud", cloud.site_url), "accessToken": access,
               "accessTokenExpiresAt": "2000-01-01T00:00:00Z", "refreshToken": refresh})
        .to_string(),
    )
    .unwrap();
}

/// The bearers of the room sessions the mailbox minted.
fn room_sessions(network: &FakeMailbox) -> Vec<String> {
    network
        .requests
        .lock()
        .unwrap()
        .iter()
        .filter(|(_, url, _)| url.ends_with("/room/session"))
        .map(|(_, _, bearer)| bearer.clone())
        .collect()
}

async fn mailbox_connected(harness: &Harness) -> bool {
    let incoming = harness.account.incoming.clone().unwrap();
    for _ in 0..100 {
        if incoming.scope().await.is_some() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    false
}

#[tokio::test]
async fn a_kept_session_cloud_refuses_is_renewed_once_before_the_mailbox_activates() {
    let network = Arc::new(FakeMailbox::default());
    let harness = attached_with_mailbox(network.clone(), |cloud, setup| {
        let (access, refresh) = cloud.issue();
        keep_session(setup, &cloud.site_url, &access, &refresh);
        // Revoked server-side while it still looks fresh here.
        cloud.expire_access();
    })
    .await;
    assert!(mailbox_connected(&harness).await, "the mailbox activated");
    let refreshes = harness.cloud.requests("/cloud/api/v1/auth/token/refresh");
    assert_eq!(refreshes.len(), 1);
    assert_eq!(refreshes[0].body["refreshToken"], "refresh-1");
    assert_eq!(room_sessions(&network), vec!["access-2".to_string()]);
    assert_eq!(harness.store()["cloudSession"]["accessToken"], "access-2");
    harness.stop().await;
}

#[tokio::test]
async fn a_session_kept_by_connect_workspace_activates_the_mailbox_at_once() {
    let network = Arc::new(FakeMailbox::default());
    let harness = attached_with_mailbox(network.clone(), |_, _| {}).await;
    // Supervision's start tick finds no kept session and backs off well
    // past the next tick.
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(room_sessions(&network).is_empty());

    keep_by_connect_workspace(&harness).await;

    assert!(mailbox_connected(&harness).await, "the mailbox activated");
    let kept = harness.store()["cloudSession"]["accessToken"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(room_sessions(&network), vec![kept]);
    harness.stop().await;
}

/// `account.connect_workspace` with no kept session: the browser sign-in
/// it opens is approved, and its session kept.
async fn keep_by_connect_workspace(harness: &Harness) {
    let connecting = {
        let account = harness.account.clone();
        tokio::spawn(async move { account.connect_workspace(WORKSPACE).await })
    };
    let mut link = String::new();
    for _ in 0..100 {
        if let Some(url) = harness.account.report().link.verification_url_complete {
            link = url;
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let decoded = link.replace("%3D", "=").replace("%26", "&");
    let redirect = decoded
        .split("redirect_uri=")
        .nth(1)
        .expect("a browser link")
        .split('&')
        .next()
        .unwrap()
        .to_string();
    let (handoff, _) = harness.cloud.issue();
    let accepted = reqwest_get(&format!(
        "{redirect}?access_token={handoff}&api_url={}/cloud",
        harness.cloud.site_url
    ))
    .await;
    assert!(accepted.starts_with("HTTP/1.1 200"), "{accepted}");
    connecting.await.unwrap().unwrap();
}

#[tokio::test]
async fn a_status_that_cannot_be_read_keeps_the_last_pause_for_incoming() {
    let network = Arc::new(FakeMailbox::default());
    let harness = attached_with_mailbox(network.clone(), |_, setup| {
        setup.probe.state.lock().unwrap().status = json!({"running": true, "paused": true});
    })
    .await;
    // The start tick reads the person's pause; no session is kept yet.
    eventually("the pause read", || {
        !harness.probe.calls("status").is_empty()
    })
    .await;
    harness.probe.state.lock().unwrap().status_fails = true;
    // The kept session wakes supervision, whose status read fails.
    keep_by_connect_workspace(&harness).await;
    assert!(mailbox_connected(&harness).await, "the mailbox activated");
    let incoming = harness.account.incoming.clone().unwrap();
    assert_eq!(incoming.status().await.state, IncomingState::Paused);
    harness.stop().await;
}

#[tokio::test]
async fn a_person_cloud_keeps_refusing_backs_the_mailbox_off_across_renewals() {
    let network = Arc::new(FakeMailbox::default());
    let harness = attached_with_mailbox(network.clone(), |cloud, setup| {
        let (access, refresh) = cloud.issue();
        keep_session(setup, &cloud.site_url, &access, &refresh);
        cloud.state.lock().unwrap().whoami_refused = true;
        *setup.supervise_every.lock().unwrap() = Some(Duration::from_millis(100));
    })
    .await;
    // Each attempt renews once; attempts double apart (2, 4, 8 periods),
    // so 2 s holds about four, not one every two periods.
    tokio::time::sleep(Duration::from_secs(2)).await;
    let refreshes = harness
        .cloud
        .requests("/cloud/api/v1/auth/token/refresh")
        .len();
    assert!((2..=5).contains(&refreshes), "{refreshes} refreshes");
    assert!(room_sessions(&network).is_empty());
    harness.stop().await;
}

#[tokio::test]
async fn a_pause_read_for_an_earlier_install_never_reaches_the_next() {
    let network = Arc::new(FakeMailbox::default());
    let harness = attached_with_mailbox(network.clone(), |_, setup| {
        setup.probe.state.lock().unwrap().status = json!({"running": true, "paused": true});
    })
    .await;
    eventually("the pause read", || {
        !harness.probe.calls("status").is_empty()
    })
    .await;
    let mut client = harness.client().await;
    client.ok("account.sign_out", json!({})).await;
    // The same person's connection again, made in a terminal; its status
    // cannot be read yet.
    {
        let mut probe = harness.probe.state.lock().unwrap();
        probe.installs = vec![FakeProbe::connected(&harness.cloud.site_url)];
        probe.status_fails = true;
    }
    keep_by_connect_workspace(&harness).await;
    eventually("attached again", || harness.account_state() == "signed_in").await;
    assert!(mailbox_connected(&harness).await, "the mailbox activated");
    let incoming = harness.account.incoming.clone().unwrap();
    assert_ne!(incoming.status().await.state, IncomingState::Paused);
    harness.stop().await;
}

/// The collector renews its upload session from the app's kept Cloud
/// session, which it accepts only while live. Uploads blocked on sign-in
/// refresh that session themselves, with no desktop identity sync (there is
/// no workspace binding here) or other Cloud call to do it.
#[tokio::test]
async fn uploads_blocked_on_sign_in_refresh_an_expired_kept_session() {
    let harness = Harness::start_with(|cloud, setup| {
        keep_expired_session(cloud, setup);
        let mut state = setup.probe.state.lock().unwrap();
        let mut install = FakeProbe::connected(&cloud.site_url);
        // Already named: isolate upload-driven renewal from the legacy name lookup.
        install["workspace_name"] = json!("Acme");
        state.installs = vec![install];
        let mut healthy = blocked_on_sign_in();
        healthy["delivery"]["failure"] = Value::Null;
        healthy["delivery"]["failure_code"] = Value::Null;
        state.status = healthy;
        *setup.supervise_every.lock().unwrap() = Some(Duration::from_millis(100));
    })
    .await;
    let refreshes = || harness.cloud.requests("/cloud/api/v1/auth/token/refresh");
    // With no workspace binding, linking the agents renews the kept session
    // once (this app's own session may be renewed; the CLI's never is).
    eventually("renewed to bind the workspace", || {
        harness.store()["cloudSession"]["refreshToken"] == "refresh-2"
            && harness.store()["cloud"]["accountWorkspaceID"] == WORKSPACE
    })
    .await;
    assert_eq!(refreshes().len(), 1);
    assert_eq!(
        harness.store()["cloudSession"]["accessTokenExpiresAt"],
        "2099-01-01T00:00:00Z"
    );

    // Uploads blocked on sign-in find the session already fresh.
    harness.probe.state.lock().unwrap().status = blocked_on_sign_in();
    // A fresh session is left alone while the collector renews from it.
    let calls = harness.probe.calls("status").len();
    eventually("supervised again", || {
        harness.probe.calls("status").len() >= calls + 3
    })
    .await;
    assert_eq!(refreshes().len(), 1);
    harness.stop().await;
}

/// A refresh Cloud keeps failing backs off from one supervision period,
/// doubling, rather than asking on every tick while uploads stay blocked.
#[tokio::test]
async fn a_refresh_for_blocked_uploads_backs_off_while_cloud_fails_it() {
    let harness = Harness::start_with(|cloud, setup| {
        keep_expired_session(cloud, setup);
        cloud.state.lock().unwrap().refresh_status = Some(503);
        let mut state = setup.probe.state.lock().unwrap();
        state.installs = vec![FakeProbe::connected(&cloud.site_url)];
        state.status = blocked_on_sign_in();
        *setup.supervise_every.lock().unwrap() = Some(Duration::from_millis(100));
    })
    .await;
    let refreshes = || harness.cloud.requests("/cloud/api/v1/auth/token/refresh");
    eventually("first refresh", || !refreshes().is_empty()).await;
    tokio::time::sleep(Duration::from_secs(2)).await;
    let ticks = harness.probe.calls("status").len();
    let asked = refreshes().len();
    // About 20 ticks; 0.2 + 0.4 + 0.8 s of backoff allows four asks.
    assert!(ticks >= 10, "{ticks} ticks");
    assert!(
        (2..=5).contains(&asked),
        "{asked} refreshes in {ticks} ticks"
    );
    // The kept session is kept for a later try.
    assert_eq!(harness.store()["cloudSession"]["refreshToken"], "refresh-1");
    harness.stop().await;
}

#[test]
fn desktop_default_is_google_browser_on_every_platform() {
    assert_eq!(Flow::platform(), Flow::Browser);
}

#[tokio::test]
async fn desktop_setup_preserves_device_approval_for_existing_clients() {
    let harness = Harness::start().await;
    for flow in [json!("unknown"), json!(true), Value::Null] {
        let error = harness
            .setup_sign_in(json!({"flow": flow}))
            .await
            .unwrap_err();
        assert_eq!(error.code, "invalid_request");
    }
    let started = harness.setup_sign_in(json!({})).await.unwrap();
    assert_eq!(started["status"], "pending_approval");
    assert_eq!(started["user_code"], "ABCD-EFGH");
    let mut client = harness.client().await;
    client.ok("account.sign_in.cancel", json!({})).await;
    harness.stop().await;
}

#[tokio::test]
async fn native_workspace_choice_waits_before_setup_and_can_be_cancelled() {
    let harness = Harness::start_with(|cloud, setup| {
        let (access, refresh) = cloud.issue();
        keep_session(setup, &cloud.site_url, &access, &refresh);
        cloud.state.lock().unwrap().desktop_workspaces = Some(json!([
            {"id": WORKSPACE, "name":"Acme", "organization_name":"Company"},
            {"id":"11111111-1111-4111-8111-111111111111", "name":"Other", "organization_name":null}
        ]));
    })
    .await;
    let mut client = harness.client().await;
    client
        .ok("account.sign_in", json!({"sharing":"selected"}))
        .await;
    eventually("native picker", || {
        harness.account.status().phase.as_deref() == Some("selecting_workspace")
    })
    .await;
    assert!(harness.probe.calls("cloud").is_empty());
    assert!(harness
        .cloud
        .requests(&format!("/cloud/api/v1/workspaces/{WORKSPACE}/resolve"))
        .is_empty());
    client
        .error(
            "account.select_workspace",
            json!({"workspace_id":"not-a-member"}),
        )
        .await;
    assert!(harness.probe.calls("cloud").is_empty());
    client.ok("account.sign_in.cancel", json!({})).await;
    eventually("cancelled picker", || {
        harness.account_state() == "signed_out"
    })
    .await;
    client
        .error(
            "account.select_workspace",
            json!({"workspace_id":WORKSPACE}),
        )
        .await;
    assert!(harness.probe.calls("cloud").is_empty());
    harness.stop().await;
}

#[tokio::test]
async fn native_workspace_choice_rebinds_the_session_before_setup() {
    let harness = Harness::start_with(|cloud, setup| {
        let (access, refresh) = cloud.issue();
        keep_session(setup, &cloud.site_url, &access, &refresh);
        let mut state = cloud.state.lock().unwrap();
        state.whoami_workspace = "11111111-1111-4111-8111-111111111111".into();
        state.desktop_workspaces = Some(json!([
            {"id": state.whoami_workspace, "name":"Other", "organization_name":null},
            {"id": WORKSPACE, "name":"Acme", "organization_name":"Company"}
        ]));
    })
    .await;
    let mut client = harness.client().await;
    client
        .ok("account.sign_in", json!({"sharing":"selected"}))
        .await;
    eventually("native picker", || {
        harness.account.status().phase.as_deref() == Some("selecting_workspace")
    })
    .await;
    client
        .ok(
            "account.select_workspace",
            json!({"workspace_id":WORKSPACE}),
        )
        .await;
    eventually("selected workspace connected", || {
        harness.account_state() == "signed_in"
    })
    .await;
    let selected = harness
        .cloud
        .requests("/cloud/api/v1/auth/desktop/workspaces");
    assert_eq!(
        selected.iter().find(|r| r.method == "POST").unwrap().body["workspaceId"],
        WORKSPACE
    );
    assert_eq!(
        harness.probe.calls("cloud")[0].1.as_deref(),
        Some("access-2")
    );
    assert_eq!(
        harness.account.status().workspace_id.as_deref(),
        Some(WORKSPACE)
    );
    harness.stop().await;
}

#[tokio::test]
async fn setup_uses_the_rotated_token_after_workspace_adoption() {
    let gate = Arc::new(tokio::sync::Notify::new());
    let harness = Harness::start_with(|cloud, setup| {
        let (access, refresh) = cloud.issue();
        keep_session(setup, &cloud.site_url, &access, &refresh);
        let path = setup.home.join("app-data/injectable-agents.json");
        let mut stored: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        stored["cloud"] = json!({"key":ACCOUNT_KEY,"baseURL":"http://127.0.0.1:9","accountWorkspaceID":WORKSPACE});
        std::fs::write(path, stored.to_string()).unwrap();
        cloud.state.lock().unwrap().resolve_gate = Some(gate.clone());
    }).await;
    let mut client = harness.client().await;
    client
        .ok("account.sign_in", json!({"sharing":"selected"}))
        .await;
    eventually("workspace resolution waiting", || {
        !harness
            .cloud
            .requests(&format!("/cloud/api/v1/workspaces/{WORKSPACE}/resolve"))
            .is_empty()
    })
    .await;
    // Force exactly the rotation that a background 401 triggers while the
    // sign-in task still holds its original local copy of the credential.
    harness.cloud.expire_access();
    harness
        .account
        .request("GET", "/members".into(), None)
        .await
        .unwrap();
    let renewed = harness.store()["cloudSession"]["accessToken"]
        .as_str()
        .unwrap()
        .to_string();
    gate.notify_one();
    eventually("signed in with latest token", || {
        harness.account_state() == "signed_in"
    })
    .await;
    assert_eq!(
        harness.probe.calls("cloud")[0].1.as_deref(),
        Some(renewed.as_str())
    );
    harness.stop().await;
}

#[tokio::test]
async fn logout_then_browser_login_uses_a_new_session_and_the_native_picker() {
    let harness = Harness::start().await;
    let mut client = harness.client().await;
    client
        .ok(
            "account.sign_in",
            json!({"sharing":"selected","flow":"device"}),
        )
        .await;
    eventually("first sign-in", || harness.account_state() == "signed_in").await;
    let old_token = harness.store()["cloudSession"]["accessToken"].clone();
    client.ok("account.sign_out", json!({})).await;
    assert_eq!(harness.account_state(), "signed_out");
    harness.cloud.state.lock().unwrap().desktop_workspaces = Some(json!([
        {"id":WORKSPACE,"name":"Acme","organization_name":null},
        {"id":"11111111-1111-4111-8111-111111111111","name":"Other","organization_name":null}
    ]));
    client
        .ok("account.sign_in", json!({"sharing":"selected"}))
        .await;
    eventually("browser return", || {
        harness.account_state() == "pending_approval"
    })
    .await;
    let report = client.ok("account.status", json!({})).await;
    let link = url::Url::parse(report["verification_url_complete"].as_str().unwrap()).unwrap();
    assert!(link
        .query_pairs()
        .any(|(key, value)| key == "workspace_selection" && value == "desktop"));
    let redirect = link
        .query_pairs()
        .find(|(key, _)| key == "redirect_uri")
        .unwrap()
        .1
        .to_string();
    let (handoff, _) = harness.cloud.issue();
    assert!(reqwest_get(&format!(
        "{redirect}?access_token={handoff}&api_url={}/cloud",
        harness.cloud.site_url
    ))
    .await
    .starts_with("HTTP/1.1 200"));
    eventually("picker after re-login", || {
        harness.account.status().phase.as_deref() == Some("selecting_workspace")
    })
    .await;
    assert_eq!(harness.probe.calls("cloud").len(), 1);
    // The newly exchanged browser session is not saved yet. It must also
    // renew if the picker remains open past its access-token lifetime.
    harness.cloud.expire_access();
    client
        .ok(
            "account.select_workspace",
            json!({"workspace_id":WORKSPACE}),
        )
        .await;
    eventually("reconnected", || harness.account_state() == "signed_in").await;
    assert_ne!(harness.store()["cloudSession"]["accessToken"], old_token);
    assert_eq!(harness.probe.calls("cloud").len(), 2);
    harness.stop().await;
}

#[tokio::test]
async fn one_workspace_continues_automatically_and_no_workspaces_starts_no_setup() {
    for count in [0, 1] {
        let harness = Harness::start_with(|cloud, setup| {
            let (access, refresh) = cloud.issue();
            keep_session(setup, &cloud.site_url, &access, &refresh);
            cloud.state.lock().unwrap().desktop_workspaces = Some(if count == 0 {
                json!([])
            } else {
                json!([{"id":WORKSPACE,"name":"Acme","organization_name":null}])
            });
        })
        .await;
        let mut client = harness.client().await;
        client
            .ok("account.sign_in", json!({"sharing":"selected"}))
            .await;
        eventually("single workspace outcome", || {
            if count == 0 {
                harness.account_state() == "error"
            } else {
                harness.account_state() == "signed_in"
            }
        })
        .await;
        assert_eq!(harness.probe.calls("cloud").len(), count);
        assert!(harness.account.status().workspace_choices.is_none());
        if count == 0 {
            assert!(harness
                .account
                .status()
                .error
                .unwrap()
                .contains("Create a workspace"));
        }
        harness.stop().await;
    }
}

#[tokio::test]
async fn setup_holds_rotation_until_history_connects_but_signout_can_cancel_it() {
    let harness = Harness::start_with(|cloud, setup| {
        let (access, refresh) = cloud.issue();
        keep_session(setup, &cloud.site_url, &access, &refresh);
        setup.probe.state.lock().unwrap().hold_before_connection = true;
    })
    .await;
    let mut client = harness.client().await;
    client
        .ok("account.sign_in", json!({"sharing":"selected"}))
        .await;
    eventually("history exchange waiting", || {
        harness.account.status().phase.as_deref() == Some("preparing_local_sessions")
    })
    .await;
    harness.cloud.expire_access();
    let account = harness.account.clone();
    let read = tokio::spawn(async move { account.request("GET", "/members".into(), None).await });
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        !read.is_finished(),
        "a Cloud read must wait for the setup credential lease"
    );
    assert!(harness
        .cloud
        .requests("/cloud/api/v1/auth/token/refresh")
        .is_empty());
    tokio::time::timeout(Duration::from_secs(2), harness.account.sign_out())
        .await
        .expect("sign-out cancels setup before waiting for its lease")
        .unwrap();
    assert_eq!(harness.account_state(), "signed_out");
    assert!(harness.store()["cloudSession"].is_null());
    let _ = read.await;
    harness.stop().await;
}

#[tokio::test]
async fn headless_device_setup_with_multiple_workspaces_uses_current_workspace() {
    let harness = Harness::start_with(|cloud, _| {
        cloud.state.lock().unwrap().desktop_workspaces = Some(json!([
            {"id":WORKSPACE,"name":"Acme","organization_name":null},
            {"id":"11111111-1111-4111-8111-111111111111","name":"Other","organization_name":null}
        ]));
    })
    .await;
    harness.setup_sign_in(json!({})).await.unwrap();
    eventually(
        "headless device setup connects without native picker",
        || harness.account_state() == "signed_in",
    )
    .await;
    assert_eq!(
        harness.account.status().workspace_id.as_deref(),
        Some(WORKSPACE)
    );
    assert!(harness.account.status().workspace_choices.is_none());
    harness.stop().await;
}

#[tokio::test]
async fn picker_uses_renewed_credentials_after_a_long_wait() {
    for rotate_in_background in [false, true] {
        let harness = Harness::start_with(|cloud, setup| {
            let (access, refresh) = cloud.issue();
            keep_session(setup, &cloud.site_url, &access, &refresh);
            let path = setup.home.join("app-data/injectable-agents.json");
            let mut stored: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            stored["cloud"] = json!({"key":ACCOUNT_KEY,"baseURL":"http://127.0.0.1:9","accountWorkspaceID":WORKSPACE});
            std::fs::write(path, stored.to_string()).unwrap();
            let mut state = cloud.state.lock().unwrap();
            state.whoami_workspace = "11111111-1111-4111-8111-111111111111".into();
            state.desktop_workspaces = Some(json!([
                {"id":state.whoami_workspace,"name":"Other","organization_name":null},
                {"id":WORKSPACE,"name":"Acme","organization_name":null}
            ]));
        })
        .await;
        let mut client = harness.client().await;
        client
            .ok("account.sign_in", json!({"sharing":"selected"}))
            .await;
        eventually("native picker", || {
            harness.account.status().phase.as_deref() == Some("selecting_workspace")
        })
        .await;
        harness.cloud.expire_access();
        if rotate_in_background {
            harness
                .account
                .request("GET", "/members".into(), None)
                .await
                .unwrap();
        }
        client
            .ok(
                "account.select_workspace",
                json!({"workspace_id":WORKSPACE}),
            )
            .await;
        eventually("picker refreshes before binding", || {
            harness.account_state() == "signed_in"
        })
        .await;
        let requests = harness
            .cloud
            .requests("/cloud/api/v1/auth/desktop/workspaces");
        let binding = requests.iter().rev().find(|r| r.method == "POST").unwrap();
        assert_eq!(binding.bearer.as_deref(), Some("access-2"));
        assert_eq!(
            harness.probe.calls("cloud")[0].1.as_deref(),
            Some("access-3")
        );
        harness.stop().await;
    }
}

#[tokio::test]
async fn an_attached_install_with_only_the_cli_s_session_adopts_the_workspace_binding() {
    // A headless core attached by setup never ran an interactive sign-in:
    // it binds the account workspace itself, so its agents reach Cloud.
    let harness = Harness::start_with(|cloud, setup| {
        setup.probe.state.lock().unwrap().installs = vec![FakeProbe::connected(&cloud.site_url)];
        write_cli_session(cloud, &setup.home);
    })
    .await;
    eventually("workspace binding adopted", || {
        harness.store()["cloud"]["accountWorkspaceID"] == WORKSPACE
    })
    .await;
    eventually("identity sync sent", || {
        harness
            .cloud
            .state
            .lock()
            .unwrap()
            .requests
            .iter()
            .any(|r| r.method == "PUT" && r.path.ends_with("/messaging/desktop-identities"))
    })
    .await;
    let status = harness
        .setup_request("GET /setup/status", json!({}))
        .await
        .unwrap();
    assert_eq!(status["cloud_identity_sync"], "ready");
    harness.stop().await;
}

#[tokio::test]
async fn an_expired_cli_sign_in_is_reported_and_never_renewed() {
    let auth = Arc::new(Mutex::new(String::new()));
    let written = auth.clone();
    let harness = Harness::start_with(move |cloud, setup| {
        setup.probe.state.lock().unwrap().installs = vec![FakeProbe::connected(&cloud.site_url)];
        let relay = setup.home.join(".agentworkforce/relay");
        std::fs::create_dir_all(&relay).unwrap();
        let file = json!({"apiUrl": format!("{}/cloud", cloud.site_url), "accessToken": "access-expired",
                          "accessTokenExpiresAt": "2000-01-01T00:00:00Z", "refreshToken": "refresh-cli"})
        .to_string();
        std::fs::write(relay.join("cloud-auth.json"), &file).unwrap();
        *written.lock().unwrap() = file;
    })
    .await;
    eventually("discovered", || harness.account_state() == "signed_in").await;
    let mut reported = Value::Null;
    for _ in 0..200 {
        reported = harness
            .setup_request("GET /setup/status", json!({}))
            .await
            .unwrap()["cloud_identity_sync"]
            .clone();
        if !reported.is_null() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(reported, "cli_session_expired");
    assert!(harness.store()["cloud"].is_null());
    // The CLI's sign-in is only read: not renewed, not rewritten.
    assert!(harness
        .cloud
        .requests("/cloud/api/v1/auth/token/refresh")
        .is_empty());
    let after = std::fs::read_to_string(harness.home.join(".agentworkforce/relay/cloud-auth.json"))
        .unwrap();
    assert_eq!(after, *auth.lock().unwrap());
    harness.stop().await;
}

#[tokio::test]
async fn an_attached_install_with_no_session_reports_it() {
    let harness = Harness::start_with(|cloud, setup| {
        setup.probe.state.lock().unwrap().installs = vec![FakeProbe::connected(&cloud.site_url)];
    })
    .await;
    eventually("discovered", || harness.account_state() == "signed_in").await;
    let mut reported = Value::Null;
    for _ in 0..200 {
        reported = harness
            .setup_request("GET /setup/status", json!({}))
            .await
            .unwrap()["cloud_identity_sync"]
            .clone();
        if !reported.is_null() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(reported, "no_session");
    harness.stop().await;
}

/// Polls `GET /setup/status` until `cloud_identity_sync` reads `want`.
async fn identity_sync_reads(harness: &Harness, want: &str) {
    let mut reported = Value::Null;
    for _ in 0..300 {
        reported = harness
            .setup_request("GET /setup/status", json!({}))
            .await
            .unwrap()["cloud_identity_sync"]
            .clone();
        if reported == want {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("cloud_identity_sync stayed {reported}, not {want}");
}

fn identity_puts(harness: &Harness) -> usize {
    harness
        .cloud
        .state
        .lock()
        .unwrap()
        .requests
        .iter()
        .filter(|r| r.method == "PUT" && r.path.ends_with("/messaging/desktop-identities"))
        .count()
}

#[tokio::test]
async fn another_person_s_cli_session_neither_binds_nor_syncs() {
    // The CLI is signed in as someone else: its session must not carry this
    // computer's agent tokens to Cloud.
    let harness = Harness::start_with(|cloud, setup| {
        setup.probe.state.lock().unwrap().installs = vec![FakeProbe::connected(&cloud.site_url)];
        write_cli_session(cloud, &setup.home);
        cloud.state.lock().unwrap().whoami_user = "someone-else".into();
        *setup.supervise_every.lock().unwrap() = Some(Duration::from_millis(50));
    })
    .await;
    identity_sync_reads(&harness, "session_mismatch").await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(harness.store()["cloud"].is_null());
    assert!(
        harness
            .cloud
            .requests("/cloud/api/v1/workspaces/")
            .is_empty()
            || harness
                .cloud
                .state
                .lock()
                .unwrap()
                .requests
                .iter()
                .all(|r| !r.path.ends_with("/resolve"))
    );
    assert_eq!(identity_puts(&harness), 0);
    harness.stop().await;
}

#[tokio::test]
async fn an_expired_kept_session_is_renewed_to_bind_the_workspace() {
    // This app's own kept session may be renewed (only the CLI's may not):
    // an expired one with a valid refresh token still links the agents.
    let harness = Harness::start_with(|cloud, setup| {
        keep_expired_session(cloud, setup);
        setup.probe.state.lock().unwrap().installs = vec![FakeProbe::connected(&cloud.site_url)];
        *setup.supervise_every.lock().unwrap() = Some(Duration::from_millis(50));
    })
    .await;
    eventually("workspace binding adopted", || {
        harness.store()["cloud"]["accountWorkspaceID"] == WORKSPACE
    })
    .await;
    assert!(!harness
        .cloud
        .requests("/cloud/api/v1/auth/token/refresh")
        .is_empty());
    identity_sync_reads(&harness, "ready").await;
    harness.stop().await;
}

#[tokio::test]
async fn a_binding_that_cloud_refused_is_retried_and_recovers() {
    let harness = Harness::start_with(|cloud, setup| {
        setup.probe.state.lock().unwrap().installs = vec![FakeProbe::connected(&cloud.site_url)];
        write_cli_session(cloud, &setup.home);
        cloud.state.lock().unwrap().resolve_status = 503;
        *setup.supervise_every.lock().unwrap() = Some(Duration::from_millis(20));
    })
    .await;
    identity_sync_reads(&harness, "no_binding").await;
    harness.cloud.state.lock().unwrap().resolve_status = 200;
    eventually("recovered", || {
        harness.store()["cloud"]["accountWorkspaceID"] == WORKSPACE
    })
    .await;
    identity_sync_reads(&harness, "ready").await;
    harness.stop().await;
}

#[tokio::test]
async fn a_binding_resolved_after_the_sign_in_changed_is_dropped() {
    // Cloud answers the resolve only after the person signed out: the answer
    // belongs to the earlier sign-in, so it is neither saved nor counted as a
    // failure.
    let gate = Arc::new(tokio::sync::Notify::new());
    let held = gate.clone();
    let harness = Harness::start_with(move |cloud, setup| {
        setup.probe.state.lock().unwrap().installs = vec![FakeProbe::connected(&cloud.site_url)];
        write_cli_session(cloud, &setup.home);
        cloud.state.lock().unwrap().resolve_gate = Some(held);
    })
    .await;
    eventually("resolve asked", || {
        harness
            .cloud
            .state
            .lock()
            .unwrap()
            .requests
            .iter()
            .any(|r| r.path.ends_with("/resolve"))
    })
    .await;
    harness.cloud.state.lock().unwrap().resolve_gate = None;
    let mut client = harness.client().await;
    client.ok("account.sign_out", json!({})).await;
    gate.notify_one();
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(
        harness.store()["cloud"].is_null(),
        "the answer for the earlier sign-in was saved"
    );
    harness.stop().await;
}

#[tokio::test]
async fn a_bound_computer_sends_no_agent_tokens_with_another_person_s_cli_session() {
    // Already bound by an earlier sign-in, now borrowing a CLI session that
    // is someone else's: the identity sync must not run with it.
    let harness = Harness::start_with(|cloud, setup| {
        setup.probe.state.lock().unwrap().installs = vec![FakeProbe::connected(&cloud.site_url)];
        write_cli_session(cloud, &setup.home);
        cloud.state.lock().unwrap().whoami_user = "someone-else".into();
        std::fs::create_dir_all(setup.home.join("app-data")).unwrap();
        std::fs::write(
            setup.home.join("app-data/injectable-agents.json"),
            json!({"registrations": [], "tokens": {}, "cloud": {"key": ACCOUNT_KEY,
                   "baseURL": "http://127.0.0.1:9", "accountWorkspaceID": WORKSPACE}})
            .to_string(),
        )
        .unwrap();
        *setup.supervise_every.lock().unwrap() = Some(Duration::from_millis(50));
    })
    .await;
    identity_sync_reads(&harness, "session_mismatch").await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(identity_puts(&harness), 0);
    harness.stop().await;
}

#[tokio::test]
async fn a_whoami_that_fails_is_retried_with_backoff_and_not_called_a_mismatch() {
    let harness = Harness::start_with(|cloud, setup| {
        setup.probe.state.lock().unwrap().installs = vec![FakeProbe::connected(&cloud.site_url)];
        write_cli_session(cloud, &setup.home);
        // Cloud cannot say whose the CLI's session is.
        cloud.state.lock().unwrap().whoami_status = Some(503);
        *setup.supervise_every.lock().unwrap() = Some(Duration::from_millis(20));
    })
    .await;
    identity_sync_reads(&harness, "no_binding").await;
    let before = harness.cloud.requests("/cloud/api/v1/auth/whoami").len();
    tokio::time::sleep(Duration::from_millis(600)).await;
    let asked = harness.cloud.requests("/cloud/api/v1/auth/whoami").len() - before;
    // About 30 passes; 20 + 40 + 80 + 160 + 320 ms of backoff allows ~5 asks.
    assert!(asked <= 7, "{asked} whoami calls without backing off");
    assert!(
        harness.store()["cloud"].is_null(),
        "bound on a whoami error"
    );
    harness.cloud.state.lock().unwrap().whoami_status = None;
    identity_sync_reads(&harness, "ready").await;
    harness.stop().await;
}

#[tokio::test]
async fn a_kept_session_that_cannot_be_renewed_settles_on_no_session() {
    let harness = Harness::start_with(|cloud, setup| {
        keep_expired_session(cloud, setup);
        cloud.state.lock().unwrap().refresh_status = Some(503);
        setup.probe.state.lock().unwrap().installs = vec![FakeProbe::connected(&cloud.site_url)];
        *setup.supervise_every.lock().unwrap() = Some(Duration::from_millis(20));
    })
    .await;
    identity_sync_reads(&harness, "no_session").await;
    for _ in 0..20 {
        let status = harness
            .setup_request("GET /setup/status", json!({}))
            .await
            .unwrap();
        assert_eq!(status["cloud_identity_sync"], "no_session");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    harness.stop().await;
}

#[tokio::test]
async fn a_renewal_the_uploads_already_failed_reports_no_session() {
    // Uploads blocked on sign-in tried to renew the kept session and Cloud
    // refused the refresh token: the person must sign in again.
    let harness = Harness::start_with(|cloud, setup| {
        keep_expired_session(cloud, setup);
        cloud.state.lock().unwrap().refresh_status = Some(401);
        let mut state = setup.probe.state.lock().unwrap();
        state.installs = vec![FakeProbe::connected(&cloud.site_url)];
        state.status = blocked_on_sign_in();
        *setup.supervise_every.lock().unwrap() = Some(Duration::from_millis(20));
    })
    .await;
    identity_sync_reads(&harness, "no_session").await;
    for _ in 0..20 {
        let status = harness
            .setup_request("GET /setup/status", json!({}))
            .await
            .unwrap();
        assert_eq!(status["cloud_identity_sync"], "no_session");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(harness.store()["cloud"].is_null());
    harness.stop().await;
}
