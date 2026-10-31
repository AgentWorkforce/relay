//! The agent runtime end to end, over the bridge socket, against an
//! in-process fake Relaycast (and fake sessions, injector and Cloud): putting
//! sessions on the relay, delivering to them at most once, renaming and
//! removing them, webhooks, messaging as the signed-in person, people, the
//! roster, settings and links. No broker, PTY runtime or agent harness is
//! ever started.

mod support {
    pub mod bridge;
    pub mod fake_relaycast;
}

use agent_relay_probe::relay::cloud_session::CloudAccess;
use agent_relay_probe::relay::daemon::{self, BoundSocket, Config, Core, Plugins};
use agent_relay_probe::relay::delivery::DeliveryTiming;
use agent_relay_probe::relay::inject::InjectOutcome;
use agent_relay_probe::relay::managed_sessions::ManagedAuthority;
use agent_relay_probe::relay::paths::{self, CorePaths};
use agent_relay_probe::relay::push::PushTiming;
use agent_relay_probe::relay::store::{SessionKind, Target};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;
use support::bridge::{
    eventually, eventually_for, session, Client, FakeCloud, FakeInjector, FakeSessions,
};
use support::fake_relaycast::{Behaviour, FakeRelaycast, WORKSPACE_KEY};

const CODEX: &str = "01a0c221-6806-7210-af25-97e104b15049";
const CLAUDE: &str = "727cce8d-8074-4ea3-94a0-dea144bf8747";
const PERSON: &str = "ada-lovelace";

#[tokio::test]
async fn codex_inbox_stall_is_listed_warns_once_and_clears() {
    use agent_relay_probe::relay::claude::inbox::InboxStall;
    let h = Harness::start(|_| {}).await;
    let mut client = h.client().await;
    client
        .ok("subscribe", json!({"topics": ["activity"]}))
        .await;
    h.register(&mut client, "codex", CODEX, Some("stuck-codex"))
        .await;
    *h.injector.codex_stall.lock().unwrap() = Some(InboxStall {
        undrained_count: 2,
        oldest_undrained_age_ms: 600_000,
    });
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let rows = client.ok("agents.list", json!({})).await;
            if rows["agents"][0]["inbox_stall"]["undrained_count"] == 2 {
                assert_eq!(
                    rows["agents"][0]["inbox_stall"]["oldest_undrained_age_ms"],
                    600_000
                );
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    let sessions = client.ok("sessions.list", json!({})).await;
    let session = sessions["sessions"].as_array().unwrap().iter()
        .find(|s| s["target"]["id"] == CODEX).unwrap();
    assert_eq!(session["registration"]["inbox_stall"]["undrained_count"], 2);
    *h.injector.codex_stall.lock().unwrap() = None;
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let rows = client.ok("agents.list", json!({})).await;
            if rows["agents"][0]["inbox_stall"].is_null() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    // The recovery line is published just after the listing clears.
    tokio::time::timeout(Duration::from_secs(10), async {
        while !client
            .events
            .iter()
            .any(|e| e.to_string().contains("no longer stalled"))
        {
            client.ok("agents.list", json!({})).await;
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    let events: Vec<_> = client.events.iter().map(Value::to_string).collect();
    assert_eq!(
        events
            .iter()
            .filter(|s| s.contains("waiting behind a stalled Codex turn"))
            .count(),
        1
    );
    assert_eq!(
        events
            .iter()
            .filter(|s| s.contains("Codex relay queue is no longer stalled"))
            .count(),
        1
    );
    h.stop().await;
}

#[derive(Default)]
struct UsageRecorder(std::sync::Mutex<Vec<Value>>);
impl agent_relay_probe::relay::telemetry::TelemetrySender for UsageRecorder {
    fn send(&self, events: Vec<Value>) -> Result<(), String> {
        self.0.lock().unwrap().extend(events);
        Ok(())
    }
}

struct Harness {
    fake: FakeRelaycast,
    _temp: tempfile::TempDir,
    home: PathBuf,
    socket: PathBuf,
    core: Arc<Core>,
    sessions: Arc<FakeSessions>,
    injector: Arc<FakeInjector>,
    cloud: Option<Arc<FakeCloud>>,
    task: tokio::task::JoinHandle<anyhow::Result<()>>,
}

impl Harness {
    async fn start(prepare: impl FnOnce(&Path)) -> Harness {
        Harness::start_with(|_| None, |home, _| prepare(home)).await
    }

    /// `prepare` is also given the fake Relaycast's origin, for stores
    /// seeded with registrations that must never reach a real host.
    async fn seeded(prepare: impl FnOnce(&Path, &str)) -> Harness {
        Harness::start_with(|_| None, prepare).await
    }

    /// Signed in to a fake Cloud that knows the fake Relaycast's person.
    async fn signed_in() -> Harness {
        Harness::start_with(|fake| Some(signed_in(fake)), |_, _| {}).await
    }

    async fn start_with(
        cloud: impl FnOnce(&FakeRelaycast) -> Option<Arc<FakeCloud>>,
        prepare: impl FnOnce(&Path, &str),
    ) -> Harness {
        Self::start_with_fake(cloud, |home, fake| prepare(home, &fake.base_url)).await
    }

    async fn start_with_fake(
        cloud: impl FnOnce(&FakeRelaycast) -> Option<Arc<FakeCloud>>,
        prepare: impl FnOnce(&Path, &FakeRelaycast),
    ) -> Harness {
        Self::start_with_heartbeat(cloud, prepare, Duration::from_secs(3600)).await
    }

    async fn start_with_heartbeat(
        cloud: impl FnOnce(&FakeRelaycast) -> Option<Arc<FakeCloud>>,
        prepare: impl FnOnce(&Path, &FakeRelaycast),
        heartbeat: Duration,
    ) -> Harness {
        Self::start_with_timing(
            cloud,
            prepare,
            DeliveryTiming {
                safety_poll: Duration::from_millis(150),
                fast_poll: Duration::from_millis(100),
                heartbeat,
                retry_unit: Duration::from_millis(20),
                replies: Duration::from_millis(50),
                ..DeliveryTiming::default()
            },
        )
        .await
    }

    async fn start_with_timing(
        cloud: impl FnOnce(&FakeRelaycast) -> Option<Arc<FakeCloud>>,
        prepare: impl FnOnce(&Path, &FakeRelaycast),
        delivery_timing: DeliveryTiming,
    ) -> Harness {
        Self::start_with_usage(cloud, prepare, delivery_timing, None).await
    }

    async fn start_with_usage(
        cloud: impl FnOnce(&FakeRelaycast) -> Option<Arc<FakeCloud>>,
        prepare: impl FnOnce(&Path, &FakeRelaycast),
        delivery_timing: DeliveryTiming,
        usage: Option<Arc<UsageRecorder>>,
    ) -> Harness {
        Self::start_with_plugins(cloud, prepare, delivery_timing, usage, None).await
    }

    async fn start_with_plugins(
        cloud: impl FnOnce(&FakeRelaycast) -> Option<Arc<FakeCloud>>,
        prepare: impl FnOnce(&Path, &FakeRelaycast),
        delivery_timing: DeliveryTiming,
        usage: Option<Arc<UsageRecorder>>,
        spawner: Option<Arc<dyn agent_relay_probe::relay::spawn::launch::Spawner>>,
    ) -> Harness {
        let fake = FakeRelaycast::start(Behaviour::default()).await;
        let cloud = cloud(&fake);
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().to_path_buf();
        prepare(&home, &fake);
        support::fake_relaycast::sign_in_store(
            &home.join("app-data"),
            WORKSPACE_KEY,
            &fake.base_url,
        );
        let socket = home.join("run/core.sock");
        let mut env = BTreeMap::new();
        env.insert("RELAYCAST_URL".to_string(), fake.base_url.clone());
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
            delivery_timing,
        };
        paths::socket_directory(config.paths.directory()).unwrap();
        let bound = BoundSocket::bind(&config.paths).unwrap();
        let sessions = Arc::new(FakeSessions::with(vec![
            session(
                SessionKind::Codex,
                CODEX,
                "/Users/me/Projects/Relay Desktop",
            ),
            session(
                SessionKind::ClaudeTerminal,
                CLAUDE,
                "/Users/me/Projects/api",
            ),
        ]));
        let injector = Arc::new(FakeInjector::default());
        let mut plugins = Plugins {
            injector: injector.clone(),
            sessions: sessions.clone(),
            ..Plugins::default()
        };
        if let Some(spawner) = spawner { plugins.spawner = spawner; }
        if let Some(cloud) = &cloud {
            plugins.cloud = cloud.clone() as Arc<dyn CloudAccess>;
        }
        if let Some(sender) = usage {
            use agent_relay_probe::relay::{
                account::Account,
                telemetry::{PostHogProject, Telemetry, TelemetryConfig},
                uploader::{ProcessRunner, Uploader},
            };
            let mut telemetry_config = TelemetryConfig::new(
                config.app_data_dir.clone(),
                home.clone(),
                BTreeMap::new(),
                "test".into(),
            );
            telemetry_config.project =
                PostHogProject::new("phc_test", "https://analytics.example.com");
            let mut account = Account::new(
                None,
                &home,
                &BTreeMap::new(),
                &config.app_data_dir,
                Arc::new(Uploader::new(Arc::new(ProcessRunner::new(
                    home.join("nonexistent-test-probe"),
                )))),
            );
            account.telemetry = Some(Telemetry::new(telemetry_config, sender));
            plugins.account = Some(Arc::new(account));
        }
        let (core, signals) = Core::with_plugins(config, plugins);
        let task = tokio::spawn(daemon::run(core.clone(), bound, signals));
        Harness {
            fake,
            _temp: temp,
            home,
            socket,
            core,
            sessions,
            injector,
            cloud,
            task,
        }
    }

    async fn client(&self) -> Client {
        Client::connect(&self.socket).await
    }

    fn store_path(&self) -> PathBuf {
        self.home.join("app-data/injectable-agents.json")
    }

    fn store(&self) -> Value {
        serde_json::from_slice(&std::fs::read(self.store_path()).unwrap()).unwrap()
    }

    async fn register(
        &self,
        client: &mut Client,
        kind: &str,
        id: &str,
        name: Option<&str>,
    ) -> Value {
        let mut params = json!({"target": {"kind": kind, "id": id}});
        if let Some(name) = name {
            params["name"] = json!(name);
        }
        client.ok("agents.register", params).await
    }

    async fn stop(self) {
        self.core.request_shutdown();
        let _ = tokio::time::timeout(Duration::from_secs(5), self.task).await;
    }
}

async fn held_heartbeat_cohort() -> (Harness, tokio::sync::watch::Sender<bool>) {
    held_heartbeat_cohort_with_connect(None).await
}

async fn held_heartbeat_cohort_with_connect(
    connect: Option<&FakeRelaycast>,
) -> (Harness, tokio::sync::watch::Sender<bool>) {
    held_heartbeat_cohort_with_interval(connect, Duration::from_secs(3600)).await
}

async fn held_heartbeat_cohort_with_interval(
    connect: Option<&FakeRelaycast>,
    heartbeat: Duration,
) -> (Harness, tokio::sync::watch::Sender<bool>) {
    held_heartbeat_cohort_with_queue_reads(connect, heartbeat, true).await
}

// Heartbeat scheduling tests need a queue that cannot refresh presence;
// otherwise a successful read correctly makes the REST heartbeat redundant.
async fn held_heartbeat_cohort_with_queue_reads(
    connect: Option<&FakeRelaycast>,
    heartbeat: Duration,
    successful_reads: bool,
) -> (Harness, tokio::sync::watch::Sender<bool>) {
    let mut release = None;
    let h = Harness::start_with_heartbeat(
        |_| None,
        |home, fake| {
            release = Some(fake.hold("POST /v1/agents/heartbeat"));
            if !successful_reads {
                fake.set_failing(&["GET /v1/deliveries"]);
            }
            let mut registrations = Vec::new();
            let mut tokens = serde_json::Map::new();
            for (name, kind, id) in [
                ("codex-api", "codex", CODEX),
                ("claude-api", "claude-terminal", CLAUDE),
            ] {
                let agent = fake.seed_agent(name, "agent", json!({}));
                registrations.push(json!({"name": name, "agentID": agent.id,
                    "target": {"kind": kind, "id": id}, "title": name,
                    "baseURL": fake.base_url, "registeredAt": 1790683200.0,
                    "workspaceKey": WORKSPACE_KEY, "machinePrefix": "test-desk"}));
                tokens.insert(name.into(), json!(agent.token));
            }
            let data = home.join("app-data");
            std::fs::create_dir_all(&data).unwrap();
            if let Some(connect) = connect {
                let guest = connect.seed_agent("connect-guest", "agent", json!({}));
                std::fs::write(data.join("connect-sessions.json"), json!({
                    "version": 1, "sessions": [{
                        "target": {"kind": "codex", "id": CODEX},
                        "connect_id": "connect-1", "task": "Test polling", "expires_at": "2099-10-01T12:00:00Z",
                        "host": {"person": "Alice", "agent_name": "host"},
                        "agent_name": guest.name, "agent_id": guest.id, "role": "guest",
                        "token": guest.token, "base_url": connect.base_url,
                        "participants": [{"agent_name": guest.name, "role": "guest"}]
                    }]
                }).to_string()).unwrap();
            }
            std::fs::write(
                data.join("injectable-agents.json"),
                json!({"registrations": registrations, "tokens": tokens}).to_string(),
            )
            .unwrap();
        },
        heartbeat,
    )
    .await;
    (h, release.unwrap())
}

#[tokio::test]
async fn a_refused_delivery_is_journaled_before_write_cooldown_defers_failure() {
    let (h, release) = held_heartbeat_cohort().await;
    eventually("team heartbeat parked", || {
        h.fake.held("POST /v1/agents/heartbeat") == 1
    })
    .await;
    h.fake
        .set_api_error("POST /v1/agents/heartbeat", Some((429, "workspace_busy")));
    release.send(true).unwrap();
    eventually("heartbeat denial returned", || {
        h.fake.calls("POST", "/v1/agents/heartbeat").len() == 3
    })
    .await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    h.fake.seed_agent("alice", "agent", json!({}));
    h.injector.then(InjectOutcome::Refused(
        "this session rejects the message".into(),
    ));
    let (delivery, _) = h.fake.send_dm("alice", "codex-api", "do not send again");
    eventually("first refusal", || !h.injector.injected().is_empty()).await;
    // Multiple queue reads happen while the write gate is still closed.
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert_eq!(
        h.injector.injected().len(),
        1,
        "refused delivery must never be offered again"
    );
    assert!(h.store()["refusedDeliveryIDs"]
        .as_array()
        .unwrap()
        .contains(&json!(delivery)));
    h.fake.set_api_error("POST /v1/agents/heartbeat", None);
    eventually("only refusal settlement resumes", || {
        delivered(&h.fake, &delivery).as_deref() == Some("failed")
    })
    .await;
    assert_eq!(h.injector.injected().len(), 1);
    let result = h.fake.delivery_state(&delivery).unwrap();
    assert_eq!(result.retryable, Some(false));
    assert_eq!(
        result.error.as_deref(),
        Some("refused by the session: this session rejects the message")
    );
    h.stop().await;
}

#[tokio::test]
async fn a_refusal_after_a_stopped_core_legacy_save_fails_and_never_acks_or_injects() {
    let mut delivery_id = String::new();
    let h = Harness::start_with_fake(
        |_| None,
        |home, fake| {
            let agent = fake.seed_agent("codex-api", "agent", json!({}));
            delivery_id = fake
                .queue("codex-api", "dm", None, "bob", "refused earlier")
                .0;
            let mut store: agent_relay_probe::relay::store::Store = serde_json::from_value(json!({
                "registrations": [{"name":"codex-api", "agentID":agent.id,
                    "target":{"kind":"codex", "id":CODEX}, "title":"codex-api",
                    "baseURL":fake.base_url, "registeredAt":1790853200.0,
                    "workspaceKey":WORKSPACE_KEY, "machinePrefix":"test-desk"}],
                "tokens":{"codex-api":agent.token}
            }))
            .unwrap();
            store.record_refused(&delivery_id);
            let mut legacy = serde_json::to_value(store).unwrap();
            for field in [
                "refusedDeliveryIDs",
                "pendingRefusalSettlements",
                "inDoubtDeliveryIDs",
            ] {
                legacy.as_object_mut().unwrap().remove(field);
            }
            let data = home.join("app-data");
            std::fs::create_dir_all(&data).unwrap();
            std::fs::write(data.join("injectable-agents.json"), legacy.to_string()).unwrap();
        },
    )
    .await;
    eventually("legacy refusal failed", || {
        delivered(&h.fake, &delivery_id).as_deref() == Some("failed")
    })
    .await;
    assert!(h.injector.injected().is_empty());
    assert_eq!(
        h.fake.delivery_state(&delivery_id).unwrap().retryable,
        Some(false)
    );
    assert!(h
        .fake
        .calls("POST", &format!("/v1/deliveries/{delivery_id}/ack"))
        .is_empty());
    h.stop().await;
}

#[tokio::test]
async fn a_legacy_save_cannot_drop_an_archived_agents_pending_refusal() {
    const CLOUD: &str = "session_01ABCdef234567";
    let mut delivery_id = String::new();
    let h = Harness::start_with_fake(
        |_| None,
        |home, fake| {
            let agent = fake.seed_agent("claude-web", "agent", json!({}));
            delivery_id = fake
                .queue("claude-web", "dm", None, "bob", "refused earlier")
                .0;
            let mut store: agent_relay_probe::relay::store::Store = serde_json::from_value(json!({
                "registrations": [{"name":"claude-web", "agentID":agent.id,
                    "target":{"kind":"claude-cloud", "id":CLOUD}, "title":"claude-web",
                    "baseURL":fake.base_url, "registeredAt":1790853200.0,
                    "workspaceKey":WORKSPACE_KEY, "machinePrefix":"test-desk"}],
                "tokens":{"claude-web":agent.token}
            }))
            .unwrap();
            store.queue_refusal_with_reason(
                &delivery_id,
                &agent.id,
                Some("the Claude session is archived"),
            );
            store.mark_archived("claude-web", "test-desk", "2026-10-01T12:00:00Z");
            let mut legacy = serde_json::to_value(store).unwrap();
            for field in [
                "refusedDeliveryIDs",
                "pendingRefusalSettlements",
                "inDoubtDeliveryIDs",
            ] {
                legacy.as_object_mut().unwrap().remove(field);
            }
            let data = home.join("app-data");
            std::fs::create_dir_all(&data).unwrap();
            std::fs::write(data.join("injectable-agents.json"), legacy.to_string()).unwrap();
        },
    )
    .await;
    eventually("archived legacy refusal settled", || {
        delivered(&h.fake, &delivery_id).as_deref() == Some("failed")
    })
    .await;
    eventually(
        "archived legacy registration removed after settlement",
        || h.store()["registrations"].as_array().unwrap().is_empty(),
    )
    .await;
    assert!(h.injector.injected().is_empty());
    assert_eq!(
        h.fake
            .delivery_state(&delivery_id)
            .unwrap()
            .error
            .as_deref(),
        Some("refused by the session: the Claude session is archived")
    );
    assert!(h.fake.calls("GET", "/v1/deliveries").is_empty());
    h.stop().await;
}

#[tokio::test]
async fn delivery_settlements_back_off_without_reinjecting_messages() {
    let (h, release) = held_heartbeat_cohort().await;
    eventually("team heartbeat parked", || {
        h.fake.held("POST /v1/agents/heartbeat") == 1
    })
    .await;
    h.fake.seed_agent("alice", "agent", json!({}));
    let (first, _) = h.fake.send_dm("alice", "codex-api", "first");
    let ack = format!("/v1/deliveries/{first}/ack");
    h.fake
        .set_api_error(&format!("POST {ack}"), Some((429, "workspace_busy")));
    eventually("first ack exhausts SDK retries", || {
        h.fake.calls("POST", &ack).len() == 3
    })
    .await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    h.injector
        .then(InjectOutcome::InDoubt("uncertain handoff".into()));
    let (second, _) = h.fake.send_dm("alice", "codex-api", "second");
    let fail = format!("/v1/deliveries/{second}/fail");
    eventually(
        "second message read and journaled despite write contention",
        || h.injector.injected().len() == 2,
    )
    .await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(
        h.fake.calls("POST", &fail).len(),
        0,
        "fail settlement must honor the ack's write backoff"
    );
    assert_eq!(
        h.fake.calls("POST", &ack).len(),
        3,
        "acks must also stay deferred"
    );
    h.fake.set_api_error(&format!("POST {ack}"), None);
    release.send(true).unwrap();
    eventually("settlements recover after the cooldown", || {
        delivered(&h.fake, &first).as_deref() == Some("acked")
            && delivered(&h.fake, &second).as_deref() == Some("failed")
    })
    .await;
    assert_eq!(
        h.injector.injected().len(),
        2,
        "durable outcomes prevent reinjection while settlement waits"
    );
    h.stop().await;
}

#[tokio::test]
async fn connect_settlements_honor_heartbeat_write_contention() {
    let connect = FakeRelaycast::start(Behaviour::default()).await;
    connect.set_api_error("POST /v1/agents/heartbeat", Some((429, "workspace_busy")));
    let (h, release) = held_heartbeat_cohort_with_connect(Some(&connect)).await;
    eventually("team heartbeat parked after initial Connect denial", || {
        h.fake.held("POST /v1/agents/heartbeat") == 1
    })
    .await;
    eventually("Connect heartbeat denial returned before delivery", || {
        connect.calls("POST", "/v1/agents/heartbeat").len() == 3
    })
    .await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    connect.seed_agent("alice", "agent", json!({}));
    let (first, _) = connect.send_dm("alice", "connect-guest", "first");
    let ack = format!("/v1/deliveries/{first}/ack");
    eventually("Connect message injected during write contention", || {
        h.injector.injected().len() == 1
    })
    .await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(
        connect.calls("POST", &ack).len(),
        0,
        "Connect ack must honor heartbeat write backoff"
    );
    connect.set_api_error("POST /v1/agents/heartbeat", None);
    release.send(true).unwrap();
    eventually("Connect acknowledgement recovers", || {
        delivered(&connect, &first).as_deref() == Some("acked")
    })
    .await;
    assert_eq!(h.injector.injected().len(), 1);
    h.stop().await;
}

#[tokio::test]
async fn a_slow_initial_connect_poll_does_not_block_team_heartbeats_or_queues() {
    let connect = FakeRelaycast::start(Behaviour::default()).await;
    let connect_release = connect.hold("GET /v1/deliveries");
    let (h, release) = held_heartbeat_cohort_with_connect(Some(&connect)).await;
    eventually("initial Connect read held", || {
        connect.held("GET /v1/deliveries") >= 1
    })
    .await;
    eventually(
        "team heartbeat starts despite held initial Connect read",
        || h.fake.held("POST /v1/agents/heartbeat") >= 1,
    )
    .await;
    eventually(
        "team queue read starts despite held initial Connect read",
        || !h.fake.calls("GET", "/v1/deliveries").is_empty(),
    )
    .await;
    release.send(true).unwrap();
    connect_release.send(true).unwrap();
    h.stop().await;
}

#[tokio::test]
async fn a_held_connect_read_cannot_stop_later_presence_heartbeats() {
    let connect = FakeRelaycast::start(Behaviour::default()).await;
    let connect_release = connect.hold("GET /v1/deliveries");
    let (h, release) =
        held_heartbeat_cohort_with_queue_reads(Some(&connect), Duration::from_millis(350), false)
            .await;
    eventually("initial Connect read held", || {
        connect.held("GET /v1/deliveries") == 1
    })
    .await;
    release.send(true).unwrap();
    eventually("first heartbeat cohort completes", || {
        h.fake.calls("POST", "/v1/agents/heartbeat").len() >= 2
    })
    .await;
    eventually(
        "another presence cohort runs while Connect remains held",
        || h.fake.calls("POST", "/v1/agents/heartbeat").len() >= 4,
    )
    .await;
    assert_eq!(
        connect.held("GET /v1/deliveries"),
        1,
        "Connect stays single-flight"
    );
    connect_release.send(true).unwrap();
    h.stop().await;
}

#[tokio::test]
async fn slow_connect_inbox_does_not_suspend_heartbeats_or_agent_queue_polls() {
    let connect = FakeRelaycast::start(Behaviour::default()).await;
    let (h, release) =
        held_heartbeat_cohort_with_queue_reads(Some(&connect), Duration::from_secs(3600), false)
            .await;
    eventually("team heartbeat parked", || {
        h.fake.held("POST /v1/agents/heartbeat") == 1
    })
    .await;
    let connect_release = connect.hold("GET /v1/deliveries");
    eventually("periodic Connect read parked", || {
        connect.held("GET /v1/deliveries") >= 1
    })
    .await;
    release.send(true).unwrap();
    eventually(
        "team heartbeats finish while Connect read remains parked",
        || h.fake.calls("POST", "/v1/agents/heartbeat").len() == 2,
    )
    .await;
    let before = h.fake.calls("GET", "/v1/deliveries").len();
    eventually(
        "team queues continue while Connect read remains parked",
        || h.fake.calls("GET", "/v1/deliveries").len() > before,
    )
    .await;
    assert_eq!(
        connect.held("GET /v1/deliveries"),
        1,
        "no overlapping periodic Connect reads"
    );
    connect_release.send(true).unwrap();
    h.stop().await;
}

#[tokio::test]
async fn heartbeat_cohorts_keep_connect_inboxes_polling() {
    let connect = FakeRelaycast::start(Behaviour::default()).await;
    let (h, release) = held_heartbeat_cohort_with_connect(Some(&connect)).await;
    eventually("team heartbeat parked", || {
        h.fake.held("POST /v1/agents/heartbeat") == 1
    })
    .await;
    let before = connect.calls("GET", "/v1/deliveries").len();
    eventually(
        "Connect inbox keeps polling while team heartbeat is held",
        || connect.calls("GET", "/v1/deliveries").len() > before,
    )
    .await;
    release.send(true).unwrap();
    h.stop().await;
}

#[tokio::test]
async fn heartbeat_completion_does_not_add_a_full_connect_poll_sleep() {
    let connect = FakeRelaycast::start(Behaviour::default()).await;
    let (h, release) =
        held_heartbeat_cohort_with_queue_reads(Some(&connect), Duration::from_secs(3600), false)
            .await;
    eventually("team heartbeat parked", || {
        h.fake.held("POST /v1/agents/heartbeat") == 1
    })
    .await;
    release.send(true).unwrap();
    eventually("both team heartbeats finish", || {
        h.fake.calls("POST", "/v1/agents/heartbeat").len() == 2
    })
    .await;
    let completed = h.fake.calls("POST", "/v1/agents/heartbeat")[1].received_at;
    eventually("Connect read after cohort completion", || {
        connect
            .calls("GET", "/v1/deliveries")
            .iter()
            .any(|call| call.received_at > completed)
    })
    .await;
    let reads = connect.calls("GET", "/v1/deliveries");
    let first = reads
        .iter()
        .find(|call| call.received_at > completed)
        .unwrap();
    assert!(
        first.received_at.duration_since(completed) < Duration::from_millis(100),
        "cohort completion must not add the full 100ms test poll sleep"
    );
    h.stop().await;
}

#[tokio::test]
async fn heartbeat_cohorts_are_serial_and_do_not_hold_up_roster_or_deliveries() {
    let (h, release) =
        held_heartbeat_cohort_with_queue_reads(None, Duration::from_secs(3600), false).await;
    eventually("first heartbeat parked", || {
        h.fake.held("POST /v1/agents/heartbeat") >= 1
    })
    .await;
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert_eq!(
        h.fake.held("POST /v1/agents/heartbeat"),
        1,
        "one heartbeat per workspace, even when two agents start due"
    );
    let mut client = h.client().await;
    let roster = client.ok("roster.list", json!({})).await;
    assert_eq!(roster["unread_statuses"], json!([]));
    eventually("delivery reads while heartbeat is held", || {
        !h.fake.calls("GET", "/v1/deliveries").is_empty()
    })
    .await;
    let before = h.fake.calls("GET", "/v1/deliveries").len();
    eventually(
        "periodic delivery reads continue through a slow heartbeat",
        || h.fake.calls("GET", "/v1/deliveries").len() > before,
    )
    .await;
    release.send(true).unwrap();
    eventually("both heartbeats finish", || {
        h.fake.calls("POST", "/v1/agents/heartbeat").len() == 2
    })
    .await;
    let calls = h.fake.calls("POST", "/v1/agents/heartbeat");
    assert!(
        calls[1].received_at.duration_since(calls[0].received_at) >= Duration::from_millis(100),
        "successful heartbeats are staggered too"
    );
    h.stop().await;
}

#[tokio::test]
async fn an_overloaded_database_pauses_the_heartbeat_cohort() {
    let (h, release) =
        held_heartbeat_cohort_with_queue_reads(None, Duration::from_secs(3600), false).await;
    h.fake.set_api_error(
        "POST /v1/agents/heartbeat",
        Some((503, "database_overloaded")),
    );
    release.send(true).unwrap();
    eventually("the first heartbeat is refused", || {
        !h.fake.calls("POST", "/v1/agents/heartbeat").is_empty()
    })
    .await;
    let refused = h.fake.calls("POST", "/v1/agents/heartbeat").len();
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        h.fake.calls("POST", "/v1/agents/heartbeat").len(),
        refused,
        "an overloaded database is not asked again by the next agent 100 ms later"
    );
    h.fake.set_api_error("POST /v1/agents/heartbeat", None);
    eventually("heartbeats resume after backoff", || {
        h.fake.calls("POST", "/v1/agents/heartbeat").len() > refused
    })
    .await;
    h.stop().await;
}

#[tokio::test]
async fn heartbeat_write_contention_does_not_pause_roster_reads() {
    let (h, release) =
        held_heartbeat_cohort_with_queue_reads(None, Duration::from_secs(3600), false).await;
    h.fake
        .set_api_error("POST /v1/agents/heartbeat", Some((429, "workspace_busy")));
    // The published SDK retries an admission denial before returning it.
    release.send(true).unwrap();
    eventually("SDK exhausts the first heartbeat", || {
        h.fake.calls("POST", "/v1/agents/heartbeat").len() == 3
    })
    .await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        h.fake.calls("POST", "/v1/agents/heartbeat").len(),
        3,
        "observe the first denial before admitting the second agent"
    );
    let mut client = h.client().await;
    let roster = client.ok("roster.list", json!({})).await;
    assert_eq!(roster["unread_statuses"], json!([]));
    assert_eq!(roster["agents"].as_array().unwrap().len(), 2);
    h.fake.set_api_error("POST /v1/agents/heartbeat", None);
    eventually("the still-due sibling recovers after backoff", || {
        h.fake.calls("POST", "/v1/agents/heartbeat").len() == 4
    })
    .await;
    h.stop().await;
}

fn delivered(fake: &FakeRelaycast, id: &str) -> Option<String> {
    fake.delivery_state(id).map(|d| d.state)
}

#[tokio::test]
async fn a_session_goes_on_the_relay_and_gets_each_message_once() {
    let h = Harness::start(|_| {}).await;
    let mut client = h.client().await;
    let hello = client.ok("status.get", json!({})).await;
    assert_eq!(hello["agents"]["store_error"], Value::Null);

    let registered = h
        .register(&mut client, "codex", CODEX, Some("Codex-API"))
        .await;
    assert_eq!(registered["name"], "codex-api");
    assert_eq!(registered["already_registered"], false);
    let agent = h.fake.agent("codex-api").unwrap();
    assert_eq!(
        registered["address"],
        format!("codex-api@test-desk-{}", agent.id)
    );
    let registration = &h.fake.calls("POST", "/v1/agents")[0];
    assert_eq!(
        registration.authorization.as_deref(),
        Some("Bearer rk_live_node0000")
    );
    assert_eq!(registration.body["direct_machine_prefix"], "test-desk");
    assert_eq!(registration.body["auto_join_general"], false);
    assert_eq!(registration.body["metadata"]["session_kind"], "codex");
    assert_eq!(registration.body["metadata"]["session_id"], CODEX);
    assert_eq!(registration.body["metadata"]["host"], "Test Desk");

    // The token is on disk, readable by this user only, and never returned.
    // (Windows: the file inherits the user profile's private ACL.)
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(h.store_path())
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);
    }
    assert_eq!(h.store()["tokens"]["codex-api"], agent.token);
    let listed = client.ok("agents.list", json!({})).await;
    assert!(!listed.to_string().contains("at_live_"), "{listed}");
    assert_eq!(listed["agents"][0]["name"], "codex-api");

    // Again: reported as it is.
    let again = h.register(&mut client, "codex", CODEX, None).await;
    assert_eq!(again["already_registered"], true);

    // Its push channel goes live with its persisted machine address.
    eventually("push live", || {
        h.core
            .status()
            .push
            .get("codex-api")
            .map(|s| format!("{s:?}"))
            == Some("Live".into())
    })
    .await;
    let register_frame = h
        .fake
        .frames()
        .into_iter()
        .find(|f| f["type"] == "node.register")
        .unwrap();
    assert_eq!(
        register_frame["machine_id"],
        format!("test-desk-{}", agent.id)
    );

    // A DM is put into the session once, then acknowledged.
    let alice = h.fake.seed_agent("alice", "agent", json!({}));
    let (delivery, message) = h.fake.send_dm("alice", "codex-api", "Can you check CI?");
    eventually("acked", || {
        delivered(&h.fake, &delivery).as_deref() == Some("acked")
    })
    .await;
    let injected = h.injector.injected();
    assert_eq!(injected.len(), 1);
    assert_eq!(injected[0].target.id, CODEX);
    assert_eq!(injected[0].message_id, message);
    assert!(
        injected[0].text.starts_with(&format!(
            "[via Agent Relay — from @alice ({}) to @codex-api · message {message} · ref ",
            alice.address
        )),
        "{}",
        injected[0].text
    );
    let reference = injected[0].text.rsplit("ref ").next().unwrap();
    assert!(
        injected[0].text.ends_with(&format!(
            "\n\nCan you check CI?\n[end of Agent Relay message · ref {reference}"
        )),
        "{}",
        injected[0].text
    );
    assert!(h.store()["injectedDeliveryIDs"]
        .as_array()
        .unwrap()
        .contains(&json!(delivery)));
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert_eq!(h.injector.injected().len(), 1, "never injected twice");

    let activity = client.ok("activity.list", json!({})).await;
    assert_eq!(activity["activity"][0]["outcome"], "injected");
    assert_eq!(activity["activity"][0]["agent"], "codex-api");
    h.stop().await;
}

#[tokio::test]
async fn a_taken_suggested_name_retries_with_a_fresh_suffix() {
    let h = Harness::start(|_| {}).await;
    let mut client = h.client().await;
    client.ok("status.get", json!({})).await;

    // The workspace still holds the name this session's deterministic
    // suggestion resolves to — e.g. the local store was rebuilt and the old
    // registration is orphaned. Suggested names retry with a fresh suffix
    // rather than failing every pass.
    let stale = agent_relay_probe::relay::agents::suggested_name(&session(
        SessionKind::Codex,
        CODEX,
        "/Users/me/Projects/Relay Desktop",
    ));
    h.fake.seed_agent(&stale, "agent", json!({}));

    let registered = h.register(&mut client, "codex", CODEX, None).await;
    assert_eq!(registered["already_registered"], false);
    let name = registered["name"].as_str().unwrap();
    assert_ne!(name, stale);
    assert!(
        name.starts_with("codex-relay-desktop-"),
        "alternate name keeps the readable shape: {name}"
    );
    // The suggestion conflicted once, then the retry registered.
    assert_eq!(h.fake.calls("POST", "/v1/agents").len(), 2);

    // A name the caller chose still reports the conflict instead of
    // silently renaming.
    let (kind, message) = client
        .error(
            "agents.register",
            json!({"target": {"kind": "claude-terminal", "id": CLAUDE}, "name": stale}),
        )
        .await;
    assert_eq!(kind, "conflict");
    assert!(message.contains(&stale), "{message}");
    h.stop().await;
}

#[tokio::test]
async fn an_attached_screenshot_is_saved_and_its_path_injected() {
    let h = Harness::start(|_| {}).await;
    let mut client = h.client().await;
    h.register(&mut client, "codex", CODEX, Some("codex-api"))
        .await;
    h.fake.seed_agent("alice", "agent", json!({}));
    let png = b"\x89PNG\r\n\x1a\nfake screenshot".to_vec();
    let file = h.fake.seed_file("../shot.png", "image/png", &png);
    let (delivery, _) = h
        .fake
        .send_dm_with_files("alice", "codex-api", "Look at this", &[&file]);
    eventually("acked", || {
        delivered(&h.fake, &delivery).as_deref() == Some("acked")
    })
    .await;
    let saved = h
        .home
        .join("app-data/attachments")
        .join(&file)
        .join("shot.png");
    assert_eq!(std::fs::read(&saved).unwrap(), png);
    let text = h.injector.injected()[0].text.clone();
    let expected = format!(
        "\n\nLook at this\n[end of Agent Relay message · ref {}]\n\nAttachments:\n- ../shot.png (image/png, {} B) saved to {}",
        text.lines().next().unwrap().rsplit("ref ").next().unwrap().trim_end_matches(']'),
        png.len(),
        saved.display()
    );
    assert!(text.ends_with(&expected), "{text}");
    // The lookup used the agent's own token; the signed address is never shown.
    let token = h.fake.agent("codex-api").unwrap().token;
    let lookup = &h.fake.calls("GET", &format!("/v1/files/{file}"))[0];
    assert_eq!(
        lookup.authorization.as_deref(),
        Some(format!("Bearer {token}").as_str())
    );
    let download = &h.fake.calls("GET", &format!("/blob/{file}"))[0];
    assert_eq!(download.authorization, None);
    assert!(!text.contains("X-Signature"));

    h.stop().await;
}

#[tokio::test]
async fn an_attachment_only_message_that_cannot_be_downloaded_still_arrives() {
    let h = Harness::start(|_| {}).await;
    let mut client = h.client().await;
    h.register(&mut client, "codex", CODEX, Some("codex-api"))
        .await;
    h.fake.seed_agent("alice", "agent", json!({}));
    let file = h
        .fake
        .seed_file("report.pdf", "application/pdf", &[0u8; 2048]);
    h.fake.set_failing(&["GET /v1/files/*"]);
    let (delivery, _) = h
        .fake
        .send_dm_with_files("alice", "codex-api", "", &[&file]);
    eventually("acked", || {
        delivered(&h.fake, &delivery).as_deref() == Some("acked")
    })
    .await;
    let text = h.injector.injected()[0].text.clone();
    assert!(
        text.ends_with(&format!(
            "\n\nAttachments:\n- report.pdf (application/pdf, 2.0 KB) file {file} \
             (not downloaded: file lookup failed (HTTP 503)); \
             fetch with: agent-relay message file download {file}"
        )),
        "{text}"
    );
    h.stop().await;
}

#[tokio::test]
async fn a_pushed_message_is_injected_from_its_frame() {
    let h = Harness::start(|_| {}).await;
    let mut client = h.client().await;
    h.register(&mut client, "claude-terminal", CLAUDE, Some("claude-api"))
        .await;
    eventually("push live", || {
        h.core
            .status()
            .push
            .get("claude-api")
            .map(|s| format!("{s:?}"))
            == Some("Live".into())
    })
    .await;
    h.core.wake(
        "claude-api".into(),
        Some(json!({"type": "deliver", "delivery_id": "del_pushed", "msg_id": "m_pushed",
            "payload": {"type": "dm.received", "data": {"message": {"id": "m_pushed", "agent_name": "bob", "text": "pushed hello"}}}})),
    );
    eventually("pushed injection", || {
        h.injector
            .injected()
            .iter()
            .any(|i| i.message_id == "m_pushed")
    })
    .await;
    // The pushed delivery is settled over HTTP, never on the socket.
    eventually("ack sent", || {
        !h.fake
            .calls("POST", "/v1/deliveries/del_pushed/ack")
            .is_empty()
    })
    .await;
    assert!(h.fake.frames().iter().all(|f| f["type"] != "delivery.ack"));
    h.stop().await;
}

#[tokio::test]
async fn an_expired_claude_approval_is_removed_after_a_successful_queue_read() {
    let h = Harness::start(|_| {}).await;
    let mut client = h.client().await;
    h.register(&mut client, "claude-terminal", CLAUDE, Some("claude-api"))
        .await;
    h.core.set_claude_session_delivery(CLAUDE, false).unwrap();
    h.fake.seed_agent("alice", "agent", json!({}));
    let (delivery, _) = h.fake.send_dm("alice", "claude-api", "approve me");
    eventually("delivery held for approval", || {
        h.core
            .claude_delivery_status()
            .held
            .iter()
            .any(|held| held.id == delivery)
    })
    .await;

    h.fake
        .set_api_error("GET /v1/deliveries", Some((503, "unavailable")));
    assert!(h.fake.expire_delivery(&delivery));
    let reads = h.fake.calls("GET", "/v1/deliveries").len();
    eventually("failed queue read", || {
        h.fake.calls("GET", "/v1/deliveries").len() > reads
    })
    .await;
    assert!(h
        .core
        .claude_delivery_status()
        .held
        .iter()
        .any(|held| held.id == delivery));

    h.fake.set_api_error("GET /v1/deliveries", None);
    eventually("expired approval removed", || {
        h.core.claude_delivery_status().held.is_empty()
    })
    .await;
    assert!(!h.core.approve_claude_delivery(&delivery).unwrap());
    assert!(h.injector.injected().is_empty());
    h.stop().await;
}

#[tokio::test]
async fn an_addressless_thread_push_waits_for_the_queues_canonical_sender() {
    let h = Harness::start(|_| {}).await;
    let mut client = h.client().await;
    h.fake
        .set_api_error("GET /v1/deliveries", Some((503, "unavailable")));
    h.register(&mut client, "claude-terminal", CLAUDE, Some("claude-api"))
        .await;
    h.core.set_claude_delivery_restricted(true).unwrap();
    // A display name must never be accepted as an endpoint allowlist key.
    h.core
        .set_claude_sender_delivery("alice", "alice", true)
        .unwrap();
    h.fake.seed_agent("alice", "agent", json!({}));
    let (delivery, message) =
        h.fake
            .queue("claude-api", "thread-reply", None, "alice", "review this");
    h.core.wake(
        "claude-api".into(),
        Some(
            json!({"type": "deliver", "delivery_id": delivery, "msg_id": message,
            "payload": {"type": "thread.reply", "data": {"agent_name": "alice",
                "text": "review this", "thread_id": "thread-1"}}}),
        ),
    );
    eventually("addressless push asks for a queue read", || {
        !h.fake.calls("GET", "/v1/deliveries").is_empty()
    })
    .await;
    assert!(h.injector.injected().is_empty());

    h.fake.set_api_error("GET /v1/deliveries", None);
    eventually("complete queue item is held", || {
        h.core
            .claude_delivery_status()
            .held
            .iter()
            .any(|held| held.id == delivery && held.sender != "alice")
    })
    .await;
    assert!(h.injector.injected().is_empty());
    h.stop().await;
}

#[tokio::test]
async fn a_registration_credential_does_not_replace_the_desktop_consent_scope() {
    let h = Harness::start(|_| {}).await;
    let mut client = h.client().await;
    h.register(&mut client, "claude-terminal", CLAUDE, Some("claude-api"))
        .await;
    let alice = h.fake.seed_agent("alice", "agent", json!({}));

    // The registration retains the key it was created with. Consent changes
    // after the desktop switches workspaces must remain in that new desktop
    // scope while this older registration drains its queue.
    let store = h.home.join("app-data/injectable-agents.json");
    let mut switched: Value = serde_json::from_slice(&std::fs::read(&store).unwrap()).unwrap();
    switched["cloud"]["key"] = json!("rk_live_another000");
    std::fs::write(&store, switched.to_string()).unwrap();
    client.ok("workspace.refresh", json!({})).await;
    h.core.set_claude_delivery_restricted(true).unwrap();
    h.core
        .set_claude_sender_delivery(&alice.address, &alice.name, true)
        .unwrap();
    let (delivery, message) = h.fake.send_dm("alice", "claude-api", "allowed");

    eventually("allowed delivery reaches the session", || {
        h.injector
            .injected()
            .iter()
            .any(|injected| injected.message_id == message)
    })
    .await;
    assert!(h
        .core
        .claude_delivery_status()
        .held
        .iter()
        .all(|held| held.id != delivery));
    h.stop().await;
}

#[tokio::test]
async fn held_claude_attachments_are_visible_and_leave_with_the_agent() {
    let h = Harness::start(|_| {}).await;
    let mut client = h.client().await;
    h.register(&mut client, "claude-terminal", CLAUDE, Some("claude-api"))
        .await;
    h.core.set_claude_session_delivery(CLAUDE, false).unwrap();
    h.fake.seed_agent("alice", "agent", json!({}));
    let file = h.fake.seed_file("review.png", "image/png", b"png");
    let (delivery, _) = h
        .fake
        .send_dm_with_files("alice", "claude-api", "see file", &[&file]);
    eventually("attachment approval is shown", || {
        h.core
            .claude_delivery_status()
            .held
            .iter()
            .any(|held| held.id == delivery && held.text.contains("review.png"))
    })
    .await;

    client
        .ok(
            "agents.unregister",
            json!({"name": "claude-api", "allow_integrations": false}),
        )
        .await;
    assert!(h.core.claude_delivery_status().held.is_empty());
    h.stop().await;
}

#[tokio::test]
async fn a_failed_delivery_record_keeps_its_approval_decision() {
    let h = Harness::start(|_| {}).await;
    let mut client = h.client().await;
    h.register(&mut client, "claude-terminal", CLAUDE, Some("claude-api"))
        .await;
    h.core.set_claude_session_delivery(CLAUDE, false).unwrap();
    h.fake.seed_agent("alice", "agent", json!({}));
    let (delivery, message) = h.fake.send_dm("alice", "claude-api", "approve me");
    eventually("delivery held for approval", || {
        h.core
            .claude_delivery_status()
            .held
            .iter()
            .any(|held| held.id == delivery)
    })
    .await;

    // Make only the main agent store unsavable; the separate approval file
    // remains writable so this exercises the ordering between the two.
    std::fs::remove_file(h.store_path()).unwrap();
    std::fs::create_dir(h.store_path()).unwrap();
    assert!(h.core.approve_claude_delivery(&delivery).unwrap());
    eventually("message reaches the session", || {
        h.injector
            .injected()
            .iter()
            .any(|injected| injected.message_id == message)
    })
    .await;
    assert_eq!(delivered(&h.fake, &delivery).as_deref(), Some("queued"));
    let policy: Value = serde_json::from_slice(
        &std::fs::read(h.home.join("app-data/claude-delivery-policy.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(policy["consumed"][&delivery]["kind"], "delivered");
    h.stop().await;
}

#[tokio::test]
async fn an_in_doubt_injection_is_failed_and_never_resent() {
    let h = Harness::start(|_| {}).await;
    let mut client = h.client().await;
    h.register(&mut client, "codex", CODEX, Some("codex-api"))
        .await;
    h.fake.seed_agent("alice", "agent", json!({}));
    h.injector
        .then(InjectOutcome::InDoubt("the connection broke".into()));
    let (delivery, _) = h.fake.send_dm("alice", "codex-api", "hi");
    eventually("failed", || {
        delivered(&h.fake, &delivery).as_deref() == Some("failed")
    })
    .await;
    let state = h.fake.delivery_state(&delivery).unwrap();
    assert_eq!(state.retryable, Some(false));
    assert!(state.error.unwrap().starts_with("in doubt, not resent"));
    assert!(h.store()["inDoubtDeliveryIDs"]
        .as_array()
        .unwrap()
        .contains(&json!(delivery)));
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert_eq!(h.injector.injected().len(), 1);
    let activity = client.ok("activity.list", json!({"limit": 1})).await;
    assert_eq!(activity["activity"][0]["outcome"], "in_doubt");
    h.stop().await;
}

#[tokio::test]
async fn a_redelivered_in_doubt_message_is_failed_again_never_acked() {
    let h = Harness::start(|_| {}).await;
    let mut client = h.client().await;
    h.register(&mut client, "codex", CODEX, Some("codex-api"))
        .await;
    h.fake.seed_agent("alice", "agent", json!({}));
    h.injector.then(InjectOutcome::InDoubt("broke".into()));
    let (delivery, _) = h.fake.send_dm("alice", "codex-api", "hi");
    // The first report is lost.
    h.fake.set_unsettleable(&[&delivery]);
    eventually("an attempted fail", || {
        !h.fake
            .calls("POST", &format!("/v1/deliveries/{delivery}/fail"))
            .is_empty()
    })
    .await;
    h.fake.set_unsettleable(&[]);
    eventually("failed again", || {
        delivered(&h.fake, &delivery).as_deref() == Some("failed")
    })
    .await;
    assert!(h
        .fake
        .calls("POST", &format!("/v1/deliveries/{delivery}/ack"))
        .is_empty());
    assert_eq!(h.injector.injected().len(), 1);
    h.stop().await;
}

#[tokio::test]
async fn a_failed_injection_backs_off_then_retries_and_waiting_does_not_count() {
    let h = Harness::start(|_| {}).await;
    let mut client = h.client().await;
    h.register(&mut client, "codex", CODEX, Some("codex-api"))
        .await;
    h.fake.seed_agent("alice", "agent", json!({}));
    h.injector.then(InjectOutcome::Retry("not running".into()));
    h.injector
        .then(InjectOutcome::Waiting("Waiting — session busy".into()));
    let (delivery, _) = h.fake.send_dm("alice", "codex-api", "hi");
    eventually("acked after retries", || {
        delivered(&h.fake, &delivery).as_deref() == Some("acked")
    })
    .await;
    let attempts = h.injector.injected();
    assert_eq!(attempts.len(), 3);
    assert!(attempts
        .iter()
        .all(|a| a.message_id == attempts[0].message_id));
    let outcomes: Vec<Value> = client.ok("activity.list", json!({})).await["activity"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["outcome"].clone())
        .collect();
    assert_eq!(
        outcomes,
        [json!("injected"), json!("waiting"), json!("failed")]
    );
    h.stop().await;
}

#[tokio::test]
async fn own_and_empty_messages_are_acked_without_injecting() {
    // An ordinary channel post reaches an agent only from a channel it
    // subscribed to, and is injected (see relay_outbound's channel tests);
    // its own posts and messages without text never are.
    let h = Harness::start(|_| {}).await;
    let mut client = h.client().await;
    h.register(&mut client, "codex", CODEX, Some("codex-api"))
        .await;
    h.fake.seed_agent("bob", "agent", json!({}));
    let (own_post, _) = h.fake.queue(
        "codex-api",
        "message",
        Some("ch_swarm"),
        "codex-api",
        "my own post",
    );
    let (own, _) = h.fake.queue("codex-api", "dm", None, "codex-api", "echo");
    let (empty, _) = h.fake.queue("codex-api", "dm", None, "bob", "   ");
    let (empty_post, _) = h
        .fake
        .queue("codex-api", "message", Some("ch_swarm"), "bob", " ");
    for id in [&own_post, &own, &empty, &empty_post] {
        eventually("acked", || {
            delivered(&h.fake, id).as_deref() == Some("acked")
        })
        .await;
    }
    assert!(h.injector.injected().is_empty());
    h.stop().await;
}

#[tokio::test]
async fn removing_an_agent_waits_for_the_injection_in_flight() {
    let h = Harness::start(|_| {}).await;
    let mut client = h.client().await;
    h.register(&mut client, "codex", CODEX, Some("codex-api"))
        .await;
    h.fake.seed_agent("alice", "agent", json!({}));
    h.injector.hold.store(true, Ordering::SeqCst);
    let (delivery, _) = h.fake.send_dm("alice", "codex-api", "hi");
    eventually("injecting", || h.injector.holding.load(Ordering::SeqCst)).await;

    let socket = h.socket.clone();
    let removal = tokio::spawn(async move {
        let mut other = Client::connect(&socket).await;
        other
            .ok("agents.unregister", json!({"name": "codex-api"}))
            .await
    });
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(!removal.is_finished(), "removal waits for the injection");
    h.injector.hold.store(false, Ordering::SeqCst);
    removal.await.unwrap();

    assert_eq!(h.fake.agent("codex-api").map(|a| a.name), None);
    assert!(h.store()["registrations"].as_array().unwrap().is_empty());
    assert!(h.store()["tokens"].as_object().unwrap().is_empty());
    // The agent is gone upstream, its queue with it; nothing more is read
    // or injected for it.
    let _ = delivery;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(h.injector.injected().len(), 1);
    let status = client.ok("status.get", json!({})).await;
    assert_eq!(status["agents"]["delivery_error"], Value::Null);
    assert!(status["push"].get("codex-api").is_none());
    let (kind, _) = client
        .error("agents.unregister", json!({"name": "codex-api"}))
        .await;
    assert_eq!(kind, "not_found");
    h.stop().await;
}

#[tokio::test]
async fn removing_an_offline_agent_reports_remote_failure_and_can_be_retried() {
    let h = Harness::start(|_| {}).await;
    let mut client = h.client().await;
    h.register(&mut client, "codex", CODEX, Some("codex-api"))
        .await;
    h.sessions.0.lock().unwrap().clear();
    // Presentation follows the daemon's background discovery, while the
    // unregister action below still checks current authority itself.
    tokio::time::timeout(Duration::from_secs(7), async {
        loop {
            let sessions = client.ok("sessions.list", json!({})).await;
            let row = sessions["sessions"]
                .as_array()
                .unwrap()
                .iter()
                .find(|row| row["registration"]["name"] == "codex-api")
                .unwrap();
            if row["live"] == false {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("background discovery marks the cached session offline");

    h.fake.set_undeletable(&["codex-api"]);
    let (kind, message) = client
        .error("agents.unregister", json!({"name": "codex-api"}))
        .await;
    assert_eq!(kind, "relaycast_unreachable");
    assert!(message.contains("HTTP 503"), "{message}");
    assert!(message.contains("registration was kept"), "{message}");
    assert!(h.fake.agent("codex-api").is_some());
    assert_eq!(h.store()["registrations"].as_array().unwrap().len(), 1);

    h.fake.set_undeletable(&[]);
    client
        .ok("agents.unregister", json!({"name": "codex-api"}))
        .await;
    assert!(h.fake.agent("codex-api").is_none());
    assert!(h.store()["registrations"].as_array().unwrap().is_empty());
    h.stop().await;
}

#[tokio::test]
async fn stopping_settles_the_injection_in_flight_first() {
    let h = Harness::start(|_| {}).await;
    let mut client = h.client().await;
    h.register(&mut client, "codex", CODEX, Some("codex-api"))
        .await;
    h.fake.seed_agent("alice", "agent", json!({}));
    h.injector.hold.store(true, Ordering::SeqCst);
    let (delivery, _) = h.fake.send_dm("alice", "codex-api", "hi");
    eventually("injecting", || h.injector.holding.load(Ordering::SeqCst)).await;

    h.core.request_shutdown();
    let injector = h.injector.clone();
    // A thread, not a task: it must release the held injection even when
    // the test fails and its runtime stops.
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(500));
        injector.hold.store(false, Ordering::SeqCst);
    });
    // Once `run` returns, the process exits: the injection must be on disk
    // and acknowledged by then, or a restart would inject it again.
    let _ = tokio::time::timeout(Duration::from_secs(5), h.task).await;
    assert_eq!(delivered(&h.fake, &delivery).as_deref(), Some("acked"));
    let store: Value = serde_json::from_slice(
        &std::fs::read(h.home.join("app-data/injectable-agents.json")).unwrap(),
    )
    .unwrap();
    assert!(store["injectedDeliveryIDs"]
        .as_array()
        .unwrap()
        .contains(&json!(delivery)));
}

#[tokio::test]
async fn names_are_checked_here_and_on_relaycast() {
    let h = Harness::start(|_| {}).await;
    let mut client = h.client().await;
    let (kind, message) = client
        .error(
            "agents.register",
            json!({"target": {"kind": "codex", "id": CODEX}, "name": "Bad Name!"}),
        )
        .await;
    assert_eq!(kind, "invalid_params");
    assert!(message.contains("lowercase"));
    h.fake.seed_agent("taken", "agent", json!({}));
    let (kind, message) = client
        .error(
            "agents.register",
            json!({"target": {"kind": "codex", "id": CODEX}, "name": "taken"}),
        )
        .await;
    assert_eq!(kind, "conflict");
    assert!(message.contains("already taken"), "{message}");
    h.register(&mut client, "codex", CODEX, Some("shared"))
        .await;
    let (kind, message) = client
        .error(
            "agents.register",
            json!({"target": {"kind": "claude-terminal", "id": CLAUDE}, "name": "shared"}),
        )
        .await;
    assert_eq!(kind, "conflict");
    assert!(message.contains("another session here"), "{message}");
    // A session discovery does not find is not running.
    let (kind, _) = client
        .error(
            "agents.register",
            json!({"target": {"kind": "codex", "id": "0f6c3a52-5b4e-4f51-9d7e-3c1a2b4d5e6f"}}),
        )
        .await;
    assert_eq!(kind, "refused");
    h.sessions.0.lock().unwrap().clear();
    assert_eq!(
        h.register(&mut client, "codex", CODEX, None).await["already_registered"],
        true
    );
    h.stop().await;
}

#[tokio::test]
async fn the_suggested_name_is_used_when_none_is_given() {
    let h = Harness::start(|_| {}).await;
    let mut client = h.client().await;
    let registered = h.register(&mut client, "codex", CODEX, None).await;
    let name = registered["name"].as_str().unwrap();
    assert_eq!(name, "codex-relay-desktop-fix-tests");
    h.stop().await;
}

#[tokio::test]
async fn automatic_names_retry_remote_and_local_collisions_and_remain_stable() {
    let h = Harness::start(|_| {}).await;
    let base = "codex-relay-desktop-fix-tests";
    h.fake.seed_agent(base, "agent", json!({}));
    let mut client = h.client().await;
    let first = h.register(&mut client, "codex", CODEX, None).await;
    assert_eq!(first["name"], format!("{base}-2"));
    let mut second = session(
        SessionKind::Codex,
        "01a0c221-6806-7210-af25-97e104b15050",
        "/Users/me/Projects/Relay Desktop",
    );
    second.title = "Fix tests".into();
    let registered = h
        .core
        .register_session(&second, None, None, false)
        .await
        .unwrap();
    assert_eq!(registered.name, format!("{base}-3"));
    second.title = "A completely different task".into();
    let again = h
        .core
        .register_session(&second, None, None, false)
        .await
        .unwrap();
    assert_eq!(again.name, registered.name);
    assert!(again.already_registered);
    h.stop().await;
}

#[tokio::test]
async fn concurrent_automatic_names_are_allocated_to_distinct_sessions() {
    let h = Harness::start(|_| {}).await;
    let first = session(SessionKind::Codex, CODEX, "/projects/cloud");
    let second = session(
        SessionKind::Codex,
        "01a0c221-6806-7210-af25-97e104b15050",
        "/projects/cloud",
    );
    let (first, second) = tokio::join!(
        h.core.register_session(&first, None, None, false),
        h.core.register_session(&second, None, None, false),
    );
    let mut names = vec![first.unwrap().name, second.unwrap().name];
    names.sort();
    assert_eq!(names, ["codex-cloud-fix-tests", "codex-cloud-fix-tests-2"]);
    assert_eq!(h.store()["registrations"].as_array().unwrap().len(), 2);
    h.stop().await;
}

#[tokio::test]
async fn a_rename_adds_an_alias_and_keeps_the_original_name_and_its_webhook() {
    let h = Harness::start(|_| {}).await;
    let mut client = h.client().await;
    h.register(&mut client, "codex", CODEX, Some("old-name"))
        .await;
    let hook = client
        .ok("agents.webhook.create", json!({"name": "old-name"}))
        .await;
    assert_eq!(hook["created"], true);
    let channel = h.store()["registrations"][0]["webhook"]["channelName"]
        .as_str()
        .unwrap()
        .to_string();

    let renamed = client
        .ok(
            "agents.rename",
            json!({"name": "old-name", "new_name": "new-name"}),
        )
        .await;
    assert_eq!(renamed["name"], "new-name");
    let alias = h.fake.agent("new-name").unwrap();
    assert_eq!(
        renamed["address"],
        format!("new-name@test-desk-{}", alias.id)
    );
    // The original name stays: it is the agent, and the alias points at it.
    assert!(h.fake.agent("old-name").is_some());
    assert!(h
        .fake
        .channel_members(&channel)
        .contains(&"old-name".to_string()));
    let store = h.store();
    assert_eq!(store["registrations"][0]["name"], "old-name");
    assert_eq!(store["registrations"][0]["alias"]["name"], "new-name");
    assert_eq!(store["registrations"][0]["alias"]["agentID"], alias.id);
    assert_eq!(store["registrations"][0]["webhook"]["channelName"], channel);
    assert!(store["tokens"].get("old-name").is_some());
    let listed = client.ok("agents.list", json!({})).await;
    assert_eq!(listed["agents"][0]["name"], "old-name");
    assert_eq!(listed["agents"][0]["alias"], "new-name");

    // Either name reaches the session.
    h.fake.seed_agent("alice", "agent", json!({}));
    let (to_alias, _) = h.fake.send_dm("alice", "new-name", "to the alias");
    let (to_name, _) = h.fake.send_dm("alice", "old-name", "to the name");
    for delivery in [&to_alias, &to_name] {
        eventually("acked", || {
            delivered(&h.fake, delivery).as_deref() == Some("acked")
        })
        .await;
    }
    let texts: Vec<String> = h.injector.injected().into_iter().map(|i| i.text).collect();
    assert!(
        texts.iter().any(|t| t.contains("to the alias")),
        "{texts:?}"
    );
    assert!(texts.iter().any(|t| t.contains("to the name")), "{texts:?}");
    h.stop().await;
}

#[tokio::test]
async fn an_alias_is_held_against_other_sessions_until_the_agent_leaves() {
    let h = Harness::start(|_| {}).await;
    let mut client = h.client().await;
    h.register(&mut client, "codex", CODEX, Some("original"))
        .await;
    client
        .ok(
            "agents.rename",
            json!({"name": "original", "new_name": "nickname"}),
        )
        .await;
    let params = json!({"target": {"kind": "claude-terminal", "id": CLAUDE}, "name": "nickname"});
    let (kind, _) = client.error("agents.register", params.clone()).await;
    assert_eq!(kind, "conflict");

    client
        .ok("agents.unregister", json!({"name": "original"}))
        .await;
    // Both names are released together.
    assert!(h.fake.agent("original").is_none());
    assert!(h.fake.agent("nickname").is_none());
    client.ok("agents.register", params).await;
    h.stop().await;
}

#[tokio::test]
async fn renaming_to_the_current_alias_answers_with_the_alias_address() {
    let h = Harness::start(|_| {}).await;
    let mut client = h.client().await;
    h.register(&mut client, "codex", CODEX, Some("original"))
        .await;
    client
        .ok(
            "agents.rename",
            json!({"name": "original", "new_name": "nickname"}),
        )
        .await;
    let again = client
        .ok(
            "agents.rename",
            json!({"name": "original", "new_name": "nickname"}),
        )
        .await;
    let alias = h.fake.agent("nickname").unwrap();
    assert_eq!(again["name"], "nickname");
    assert_eq!(again["address"], format!("nickname@test-desk-{}", alias.id));
    h.stop().await;
}

#[tokio::test]
async fn a_failed_removal_of_the_original_does_not_keep_a_released_alias() {
    let h = Harness::start(|_| {}).await;
    let mut client = h.client().await;
    h.register(&mut client, "codex", CODEX, Some("original"))
        .await;
    client
        .ok(
            "agents.rename",
            json!({"name": "original", "new_name": "nickname"}),
        )
        .await;
    h.fake.set_undeletable(&["original"]);
    client
        .error("agents.unregister", json!({"name": "original"}))
        .await;
    assert!(h.fake.agent("nickname").is_none());
    let store = h.store();
    assert_eq!(store["registrations"][0]["name"], "original");
    assert!(store["registrations"][0].get("alias").is_none());
    // The retry finishes the removal.
    h.fake.set_undeletable(&[]);
    client
        .ok("agents.unregister", json!({"name": "original"}))
        .await;
    assert!(h.fake.agent("original").is_none());
    h.stop().await;
}

#[tokio::test]
async fn a_rename_s_roster_marker_is_retried_until_relaycast_has_it() {
    let h = Harness::start(|_| {}).await;
    let mut client = h.client().await;
    h.register(&mut client, "codex", CODEX, Some("original"))
        .await;
    h.fake
        .set_api_error("PATCH /v1/agents/original", Some((503, "unavailable")));
    client
        .ok(
            "agents.rename",
            json!({"name": "original", "new_name": "nickname"}),
        )
        .await;
    assert_eq!(h.store()["pendingNameMarkers"][0], "original");
    assert!(h
        .fake
        .agent("original")
        .unwrap()
        .metadata
        .get("renamed_to")
        .is_none());
    h.fake.set_api_error("PATCH /v1/agents/original", None);
    eventually("the marker is published", || {
        h.fake.agent("original").unwrap().metadata["renamed_to"] == "nickname"
    })
    .await;
    eventually("no longer pending", || {
        h.store().get("pendingNameMarkers").is_none()
    })
    .await;
    h.stop().await;
}

#[tokio::test]
async fn title_refresh_keeps_an_ended_unaliased_session_idle() {
    let h = Harness::start(|_| {}).await;
    let mut client = h.client().await;
    h.register(&mut client, "codex", CODEX, Some("title-idle"))
        .await;
    h.sessions.0.lock().unwrap()[0].live = false;
    h.core.poll_once().await;
    assert_eq!(h.fake.agent("title-idle").unwrap().status, "idle");
    h.sessions.0.lock().unwrap()[0].title = "An ended session".into();
    h.core.poll_once().await;
    eventually("ended title published", || {
        h.fake.agent("title-idle").unwrap().metadata["session_title"] == "An ended session"
    })
    .await;
    assert_eq!(h.fake.agent("title-idle").unwrap().status, "idle");
    h.stop().await;
}

#[tokio::test]
async fn title_refresh_includes_manually_registered_provider_inventory() {
    let h = Harness::start(|_| {}).await;
    let mut client = h.client().await;
    // Model providers whose full inventory is deliberately excluded from
    // automatic admission (Pi, OpenCode and Claude cloud).
    let target = Target::new(SessionKind::Codex, CODEX);
    h.sessions.7.lock().unwrap().insert(target);
    h.register(&mut client, "codex", CODEX, Some("manual-title"))
        .await;
    h.core.poll_once().await;
    client
        .ok("subscribe", json!({"topics": ["invalidated"]}))
        .await;
    client.events.clear();
    h.sessions.0.lock().unwrap()[0].title = "Renamed in provider".into();
    h.core.poll_once().await;
    eventually("manual provider title published", || {
        h.fake.agent("manual-title").unwrap().metadata["session_title"] == "Renamed in provider"
    })
    .await;
    assert_eq!(
        h.store()["registrations"][0]["title"],
        "Renamed in provider"
    );
    client.ok("agents.list", json!({})).await;
    assert!(
        client
            .events
            .iter()
            .any(|e| e["params"]["data"]["what"] == "agents"),
        "title-only change must invalidate agents: {:?}",
        client.events
    );
    h.stop().await;
}

#[tokio::test]
async fn title_refresh_retains_a_native_rename_while_an_older_patch_is_in_flight() {
    let h = Harness::start(|_| {}).await;
    let mut client = h.client().await;
    h.register(&mut client, "codex", CODEX, Some("title-race"))
        .await;
    h.core.poll_once().await;
    let release = h.fake.hold("PATCH /v1/agents/title-race");
    client
        .ok(
            "sessions.title.set",
            json!({"source": "codex", "session_id": CODEX, "title": "Older title"}),
        )
        .await;
    let core = h.core.clone();
    let poll = tokio::spawn(async move { core.poll_once().await });
    eventually("older title PATCH held", || {
        h.fake.held("PATCH /v1/agents/title-race") > 0
    })
    .await;
    client
        .ok(
            "sessions.title.set",
            json!({"source": "codex", "session_id": CODEX, "title": "Newest title"}),
        )
        .await;
    assert_eq!(h.store()["registrations"][0]["title"], "Newest title");
    release.send(true).unwrap();
    poll.await.unwrap();
    h.core.poll_once().await;
    eventually("newest title reaches roster", || {
        h.fake.agent("title-race").unwrap().metadata["session_title"] == "Newest title"
    })
    .await;
    eventually("latest title acknowledged", || {
        h.store().get("pendingNameMarkers").is_none()
    })
    .await;
    h.stop().await;
}

#[tokio::test]
async fn title_refresh_finishes_before_a_newer_idle_presence_write() {
    let h = Harness::start(|_| {}).await;
    let mut client = h.client().await;
    h.register(&mut client, "codex", CODEX, Some("title-presence-old"))
        .await;
    client
        .ok(
            "agents.rename",
            json!({"name": "title-presence-old", "new_name": "title-presence"}),
        )
        .await;
    h.core.poll_once().await;
    let release = h.fake.hold("PATCH /v1/agents/title-presence");
    client
        .ok(
            "sessions.title.set",
            json!({"source": "codex", "session_id": CODEX, "title": "In flight"}),
        )
        .await;
    let core = h.core.clone();
    let old_poll = tokio::spawn(async move { core.poll_once().await });
    eventually("active metadata PATCH held", || {
        h.fake.held("PATCH /v1/agents/title-presence") > 0
    })
    .await;
    h.sessions.0.lock().unwrap()[0].live = false;
    let core = h.core.clone();
    let new_poll = tokio::spawn(async move { core.poll_once().await });
    eventually("session absence recorded", || {
        h.store()["registrations"][0]["missingSince"].is_string()
    })
    .await;
    assert_eq!(
        h.fake.held("PATCH /v1/agents/title-presence"),
        1,
        "new presence must wait for the older metadata write"
    );
    release.send(true).unwrap();
    old_poll.await.unwrap();
    new_poll.await.unwrap();
    assert_eq!(h.fake.agent("title-presence").unwrap().status, "idle");
    h.stop().await;
}

#[tokio::test]
async fn a_test_message_goes_to_the_current_name() {
    let h = Harness::start(|_| {}).await;
    let mut client = h.client().await;
    h.register(&mut client, "codex", CODEX, Some("original"))
        .await;
    client
        .ok(
            "agents.rename",
            json!({"name": "original", "new_name": "nickname"}),
        )
        .await;
    let listed = client.ok("agents.list", json!({})).await;
    let alias = h.fake.agent("nickname").unwrap();
    assert_eq!(
        listed["agents"][0]["address"],
        format!("nickname@test-desk-{}", alias.id)
    );
    h.stop().await;
}

/// Backdates every replaced alias in the store file and has the core save,
/// so it reads the change.
async fn a_day_passes(h: &Harness, client: &mut Client) {
    let mut store: Value = serde_json::from_slice(&std::fs::read(h.store_path()).unwrap()).unwrap();
    for registration in store["registrations"].as_array_mut().unwrap() {
        for retired in registration["retiredAliases"]
            .as_array_mut()
            .into_iter()
            .flatten()
        {
            retired["retiredAt"] = json!("2020-01-01T00:00:00Z");
        }
    }
    std::fs::write(h.store_path(), serde_json::to_vec(&store).unwrap()).unwrap();
    // A save that leaves registrations alone, so the file's are kept.
    client
        .ok("settings.set", json!({"allow_self_registration": true}))
        .await;
}

#[tokio::test]
async fn renaming_again_keeps_the_replaced_name_forwarding_for_a_day() {
    let h = Harness::start(|_| {}).await;
    let mut client = h.client().await;
    h.register(&mut client, "codex", CODEX, Some("original"))
        .await;
    client
        .ok(
            "agents.rename",
            json!({"name": "original", "new_name": "first"}),
        )
        .await;
    let first = h.fake.agent("first").unwrap();
    // Renamed by any of its names alike.
    let renamed = client
        .ok(
            "agents.rename",
            json!({"name": "first", "new_name": "second"}),
        )
        .await;
    assert_eq!(renamed["released"], "first");
    let store = h.store();
    assert_eq!(store["registrations"][0]["alias"]["name"], "second");
    assert_eq!(
        store["registrations"][0]["retiredAliases"][0]["alias"]["name"],
        "first"
    );
    // The replaced name still forwards, hidden from rosters, and is held.
    assert_eq!(
        h.fake.agent("first").unwrap().metadata["renamed_to"],
        "second"
    );
    h.fake.seed_agent("alice", "agent", json!({}));
    let (late, _) = h.fake.send_dm("alice", "first", "a late reply");
    eventually("forwarded", || {
        delivered(&h.fake, &late).as_deref() == Some("acked")
    })
    .await;
    let params = json!({"target": {"kind": "claude-terminal", "id": CLAUDE}, "name": "first"});
    let (kind, _) = client.error("agents.register", params).await;
    assert_eq!(kind, "conflict");
    // Taking it up again reuses its agent; the one it replaces forwards in turn.
    let registered = h.fake.calls("POST", "/v1/agents").len();
    client
        .ok(
            "agents.rename",
            json!({"name": "original", "new_name": "first"}),
        )
        .await;
    assert_eq!(h.fake.calls("POST", "/v1/agents").len(), registered);
    assert_eq!(h.fake.agent("first").unwrap().id, first.id);
    assert_eq!(h.fake.agent("first").unwrap().metadata["renamed_to"], "");
    let store = h.store();
    assert_eq!(store["registrations"][0]["alias"]["name"], "first");
    assert_eq!(
        store["registrations"][0]["retiredAliases"][0]["alias"]["name"],
        "second"
    );
    // Back to the registered name: every alias forwards for its day.
    client
        .ok(
            "agents.rename",
            json!({"name": "original", "new_name": "original"}),
        )
        .await;
    assert!(h.fake.agent("first").is_some() && h.fake.agent("second").is_some());
    assert!(h.store()["registrations"][0].get("alias").is_none());
    h.stop().await;
}

#[tokio::test]
async fn a_replaced_name_is_released_after_a_day_and_retried_until_gone() {
    let h = Harness::start(|_| {}).await;
    let mut client = h.client().await;
    h.register(&mut client, "codex", CODEX, Some("old-name"))
        .await;
    client
        .ok(
            "agents.rename",
            json!({"name": "old-name", "new_name": "mid-name"}),
        )
        .await;
    client
        .ok(
            "agents.rename",
            json!({"name": "old-name", "new_name": "new-name"}),
        )
        .await;
    assert!(h.fake.agent("mid-name").is_some(), "forwarding for a day");
    h.fake.set_undeletable(&["mid-name"]);
    a_day_passes(&h, &mut client).await;
    eventually("released and queued", || {
        h.store()["pendingCleanups"][0]["name"] == "mid-name"
            && h.store()["registrations"][0]
                .get("retiredAliases")
                .is_none()
    })
    .await;
    h.fake.set_undeletable(&[]);
    eventually("removed", || h.fake.agent("mid-name").is_none()).await;
    eventually("forgotten", || h.store().get("pendingCleanups").is_none()).await;
    assert!(h.fake.agent("old-name").is_some() && h.fake.agent("new-name").is_some());
    // Turning the agent off releases every name.
    client
        .ok(
            "agents.rename",
            json!({"name": "old-name", "new_name": "later"}),
        )
        .await;
    client
        .ok("agents.unregister", json!({"name": "old-name"}))
        .await;
    for name in ["old-name", "new-name", "later"] {
        assert!(h.fake.agent(name).is_none(), "{name} released");
    }
    h.stop().await;
}

#[tokio::test]
async fn a_pending_cleanup_never_removes_a_name_registered_meanwhile() {
    let h = Harness::start(|_| {}).await;
    let mut client = h.client().await;
    h.register(&mut client, "codex", CODEX, Some("kept-name"))
        .await;
    client
        .ok(
            "agents.rename",
            json!({"name": "kept-name", "new_name": "old-name"}),
        )
        .await;
    h.fake.set_undeletable(&["old-name"]);
    client
        .ok(
            "agents.rename",
            json!({"name": "kept-name", "new_name": "new-name"}),
        )
        .await;
    a_day_passes(&h, &mut client).await;
    eventually("queued for removal", || {
        h.store()["pendingCleanups"][0]["name"] == "old-name"
    })
    .await;
    // Relaycast removed it already, but the answer was lost: the cleanup
    // retries, and its removal is in flight.
    h.fake.forget_agent("old-name");
    h.fake.set_undeletable(&[]);
    let release = h.fake.hold("DELETE /v1/agents/old-name");
    eventually("the cleanup's removal in flight", || {
        h.fake.held("DELETE /v1/agents/old-name") > 0
    })
    .await;

    let params = json!({"target": {"kind": "claude-terminal", "id": CLAUDE}, "name": "old-name"});
    let refused = client.call("agents.register", params.clone()).await;
    let _ = release.send(true);
    eventually("cleaned up", || h.store().get("pendingCleanups").is_none()).await;
    // Refused while the removal held the name; registered once it is done.
    if refused["error"].is_object() {
        client.ok("agents.register", params).await;
    }
    // Several cleanup passes later the new agent is still there.
    let polls = h.fake.calls("GET", "/v1/deliveries").len();
    eventually("more passes", || {
        h.fake.calls("GET", "/v1/deliveries").len() > polls + 2
    })
    .await;
    assert!(
        h.fake.agent("old-name").is_some(),
        "the new @old-name was removed"
    );
    assert_eq!(h.store()["registrations"][1]["name"], "old-name");
    h.stop().await;
}

#[tokio::test]
async fn a_webhook_posts_into_the_session_and_is_revoked() {
    let h = Harness::start(|_| {}).await;
    let mut client = h.client().await;
    h.register(&mut client, "codex", CODEX, Some("codex-api"))
        .await;
    let created = client
        .ok("agents.webhook.create", json!({"name": "codex-api"}))
        .await;
    let again = client
        .ok("agents.webhook.create", json!({"name": "codex-api"}))
        .await;
    assert_eq!(again["created"], false);
    assert_eq!(again["secret"], Value::Null, "the secret is shown once");
    assert_eq!(again["id"], created["id"]);
    let channel_id = h.store()["registrations"][0]["webhook"]["channelID"]
        .as_str()
        .unwrap()
        .to_string();
    h.fake.seed_agent("__relay_webhook__", "service", json!({}));
    let (delivery, _) = h.fake.queue(
        "codex-api",
        "message",
        Some(&channel_id),
        "__relay_webhook__",
        "Build failed on main",
    );
    eventually("acked", || {
        delivered(&h.fake, &delivery).as_deref() == Some("acked")
    })
    .await;
    let text = &h.injector.injected()[0].text;
    assert!(
        text.starts_with("[via Agent Relay — from webhook to @codex-api"),
        "{text}"
    );

    let revoked = client
        .ok("agents.webhook.revoke", json!({"name": "codex-api"}))
        .await;
    assert_eq!(revoked["already_deleted"], false);
    assert!(h.fake.webhook_ids().is_empty());
    assert!(h.store()["registrations"][0].get("webhook").is_none());
    let revoked = client
        .ok("agents.webhook.revoke", json!({"name": "codex-api"}))
        .await;
    assert_eq!(revoked["already_deleted"], true);
    h.stop().await;
}

#[tokio::test]
async fn a_test_message_takes_a_teammates_path() {
    let h = Harness::start(|_| {}).await;
    let mut client = h.client().await;
    let registered = h
        .register(&mut client, "codex", CODEX, Some("codex-api"))
        .await;
    let sent = client
        .ok("agents.test_message", json!({"name": "codex-api"}))
        .await;
    assert!(sent["message_id"].as_str().unwrap().starts_with("m_"));
    let dm = &h.fake.calls("POST", "/v1/dm")[0];
    assert_eq!(dm.body["address"], registered["address"]);
    let sender = h.store()["testSenders"]
        .as_object()
        .unwrap()
        .values()
        .next()
        .unwrap()
        .clone();
    assert!(sender["name"]
        .as_str()
        .unwrap()
        .starts_with("desktop-tester-"));
    eventually("injected", || !h.injector.injected().is_empty()).await;
    assert!(h.injector.injected()[0]
        .text
        .contains("from @desktop-tester-"));
    // The sender is reused.
    client
        .ok(
            "agents.test_message",
            json!({"name": "codex-api", "text": "again"}),
        )
        .await;
    assert_eq!(h.fake.calls("POST", "/v1/agents").len(), 2);
    h.stop().await;
}

#[tokio::test]
async fn an_automatic_final_answer_is_claimed_then_sent_once() {
    let h = Harness::start(|_| {}).await;
    let mut client = h.client().await;
    h.register(&mut client, "codex", CODEX, Some("codex-api"))
        .await;
    h.fake.seed_agent("alice", "agent", json!({}));
    let (delivery, message) = h.fake.send_dm("alice", "codex-api", "What failed?");
    eventually("acked", || {
        delivered(&h.fake, &delivery).as_deref() == Some("acked")
    })
    .await;
    let reference = agent_relay_probe::relay::delivery::policy::MessageRef::of(&message);
    h.injector
        .answers
        .lock()
        .unwrap()
        .insert(reference, "The lint step failed.".into());
    let replies = format!("/v1/messages/{message}/replies");
    eventually("answered", || !h.fake.calls("POST", &replies).is_empty()).await;
    let reply = &h.fake.calls("POST", &replies)[0];
    assert_eq!(reply.body["text"], "The lint step failed.");
    let agent = h.fake.agent("codex-api").unwrap();
    assert_eq!(
        reply.authorization.as_deref(),
        Some(format!("Bearer {}", agent.token).as_str())
    );
    let expected_key = format!("desktop-reply-{}-{message}", agent.id);
    assert_eq!(
        reply.idempotency_key.as_deref(),
        Some(expected_key.as_str())
    );
    assert_eq!(h.store()["replies"][0]["claimed"], true);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        h.fake.calls("POST", &replies).len(),
        1,
        "never a second answer"
    );
    h.stop().await;
}

#[tokio::test]
async fn a_socket_send_claims_the_automatic_answer_it_replaces() {
    let h = Harness::start(|_| {}).await;
    let mut client = h.client().await;
    h.register(&mut client, "codex", CODEX, Some("codex-api"))
        .await;
    // The session was given a reply command and always answers too.
    *h.injector.hint.lock().unwrap() = Some("[reply: curl relay]".into());
    client
        .ok(
            "agents.reply_setting",
            json!({"name": "codex-api", "enabled": true}),
        )
        .await;
    h.fake.seed_agent("alice", "agent", json!({}));
    let (delivery, message) = h.fake.send_dm("alice", "codex-api", "What failed?");
    eventually("acked", || {
        delivered(&h.fake, &delivery).as_deref() == Some("acked")
    })
    .await;
    assert!(h.core.reply_parents("codex-api").contains(&message));
    // The session answers itself through the socket first.
    h.core
        .claim_socket_reply(
            "codex-api",
            &agent_relay_probe::relay::links::Endpoint::Name("alice".into()),
            Some(&message),
        )
        .unwrap();
    let reference = agent_relay_probe::relay::delivery::policy::MessageRef::of(&message);
    h.injector
        .answers
        .lock()
        .unwrap()
        .insert(reference, "The lint step failed.".into());
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert!(
        h.fake
            .calls("POST", &format!("/v1/messages/{message}/replies"))
            .is_empty(),
        "no second, automatic answer"
    );
    h.stop().await;
}

#[tokio::test]
async fn a_session_that_can_reply_itself_is_told_how_and_gets_no_automatic_answer() {
    let h = Harness::start(|_| {}).await;
    *h.injector.hint.lock().unwrap() = Some("[reply: curl relay]".into());
    let mut client = h.client().await;
    h.register(&mut client, "codex", CODEX, Some("codex-api"))
        .await;
    let alice = h.fake.seed_agent("alice", "agent", json!({}));
    let (delivery, message) = h.fake.send_dm("alice", "codex-api", "hi");
    eventually("acked", || {
        delivered(&h.fake, &delivery).as_deref() == Some("acked")
    })
    .await;
    let text = &h.injector.injected()[0].text;
    assert!(
        text.contains(&format!(
            "\n[reply: curl relay] to=- address={} reply_to={message}\n{}\n\nhi",
            alice.address,
            agent_relay_probe::relay::hosted_mcp::ROUTE_LINE
        )),
        "{text}"
    );
    let store = h.store();
    assert_eq!(store["replyRoutes"][0]["messageID"], message);
    assert!(store.get("replies").is_none());
    h.stop().await;
}

// Review on #381: the host note is not a reply command, so a session given
// only the note still gets its automatic answer sent.
#[tokio::test]
async fn a_host_note_alone_keeps_the_automatic_answer() {
    let h = Harness::start(|_| {}).await;
    *h.injector.note.lock().unwrap() = Some("[conductor: quote it]".into());
    let mut client = h.client().await;
    h.register(&mut client, "codex", CODEX, Some("codex-api"))
        .await;
    h.fake.seed_agent("alice", "agent", json!({}));
    let (delivery, message) = h.fake.send_dm("alice", "codex-api", "What failed?");
    eventually("acked", || {
        delivered(&h.fake, &delivery).as_deref() == Some("acked")
    })
    .await;
    assert!(h.injector.injected()[0]
        .text
        .contains("[conductor: quote it]"));
    let reference = agent_relay_probe::relay::delivery::policy::MessageRef::of(&message);
    h.injector
        .answers
        .lock()
        .unwrap()
        .insert(reference, "The lint step failed.".into());
    let replies = format!("/v1/messages/{message}/replies");
    eventually("answered", || !h.fake.calls("POST", &replies).is_empty()).await;
    assert_eq!(
        h.fake.calls("POST", &replies)[0].body["text"],
        "The lint step failed."
    );
    h.stop().await;
}

#[tokio::test]
async fn a_host_note_follows_the_reply_hint_before_the_message() {
    let h = Harness::start(|_| {}).await;
    *h.injector.hint.lock().unwrap() = Some("[reply: curl relay]".into());
    *h.injector.note.lock().unwrap() = Some("[conductor: quote it]".into());
    let mut client = h.client().await;
    h.register(&mut client, "codex", CODEX, Some("codex-api"))
        .await;
    h.fake.seed_agent("alice", "agent", json!({}));
    let (delivery, message) = h.fake.send_dm("alice", "codex-api", "hi");
    eventually("acked", || {
        delivered(&h.fake, &delivery).as_deref() == Some("acked")
    })
    .await;
    let text = &h.injector.injected()[0].text;
    assert!(
        text.contains(&format!(
            "reply_to={message}\n{}\n[conductor: quote it]\n\nhi",
            agent_relay_probe::relay::hosted_mcp::ROUTE_LINE
        )),
        "{text}"
    );
    // Without a reply hint the note still precedes the message.
    *h.injector.hint.lock().unwrap() = None;
    let (delivery, _) = h.fake.send_dm("alice", "codex-api", "again");
    eventually("acked", || {
        delivered(&h.fake, &delivery).as_deref() == Some("acked")
    })
    .await;
    let text = &h.injector.injected()[1].text;
    assert!(text.contains("]\n[conductor: quote it]\n\nagain"), "{text}");
    h.stop().await;
}

#[tokio::test]
async fn mobile_claude_handoff_reports_read_only_platform_support() {
    let h = Harness::start(|_| {}).await;
    let mut client = h.client().await;
    let values = client.ok("settings.get", json!({})).await;
    assert_eq!(values["mobile_claude_handoff_supported"], cfg!(unix));
    assert_eq!(values["mobile_claude_handoff"], false);
    let (kind, _) = client.error("settings.set", json!({"mobile_claude_handoff_supported": true})).await;
    assert_eq!(kind, "invalid_params");
    #[cfg(windows)] {
        let (kind, message) = client.error("settings.set", json!({"mobile_claude_handoff": true})).await;
        assert_eq!(kind, "refused");
        assert!(message.contains("unavailable on this platform"), "{message}");
        assert!(!h.home.join(".claude/skills/agent-relay-mobile").exists());
    }
    h.stop().await;
}

#[tokio::test]
async fn native_continuation_requires_separate_persisted_consent_and_claim() {
    let h = Harness::start(|_| {}).await;
    let mut client = h.client().await;
    let values = client.ok("settings.get", json!({})).await;
    assert_eq!(values["mobile_native_continuation"], false);
    assert_eq!(values["mobile_native_continuation_supported"], cfg!(unix));
    let (kind, _) = client.error("settings.set", json!({"mobile_native_continuation_supported": true})).await;
    assert_eq!(kind, "invalid_params");
    let (kind, _) = client.error("settings.set", json!({"mobile_native_continuation": true})).await;
    assert_eq!(kind, "refused");
    #[cfg(unix)] {
        mark_mobile_node_claimed(&h.core);
        client.ok("settings.set", json!({"mobile_native_continuation": true})).await;
        assert_eq!(h.store()["mobileNativeContinuation"], true);
        // Claude's own setting is on by default once the computer is claimed.
        assert_eq!(client.ok("settings.get", json!({})).await["mobile_claude_handoff"], true);
        assert!(h.store()["mobileClaudeHandoff"].is_null());
        let (kind, _) = client.error("settings.set", json!({"mobile_native_continuation": "yes"})).await;
        assert_eq!(kind, "invalid_params");
        client.ok("settings.set", json!({"mobile_native_continuation": false})).await;
        assert_eq!(h.store()["mobileNativeContinuation"], false);
    }
    h.stop().await;
}

// Simulates the existing signed-in node claim, never a new production authority.
fn mark_mobile_node_claimed(core: &Core) {
    use agent_relay_probe::relay::state::{SpawnClaim, SpawnClaimState, SpawnState, SpawnStatus};
    core.hub().update(|status| status.spawn = Some(SpawnStatus {
        state: SpawnState::Live,
        claim: Some(SpawnClaim { state: SpawnClaimState::Claimed, note: None }),
        ..SpawnStatus::default()
    }));
}

#[cfg(unix)]
#[tokio::test]
async fn mobile_claude_handoff_refuses_unclaimed_host_before_installing() {
    let h = Harness::start(|_| {}).await;
    let mut client = h.client().await;
    let (kind, message) = client.error("settings.set", json!({"mobile_claude_handoff": true})).await;
    assert_eq!(kind, "refused");
    assert!(message.contains("Accept spawns from Agent Relay"), "{message}");
    assert_eq!(client.ok("settings.get", json!({})).await["mobile_claude_handoff"], false);
    assert!(!h.home.join(".claude/skills/agent-relay-mobile").exists());
    h.stop().await;
}

#[cfg(unix)]
#[tokio::test]
async fn mobile_claude_handoff_is_on_once_claimed_and_turning_it_off_persists() {
    let h = Harness::start(|_| {}).await;
    let mut client = h.client().await;
    h.register(
        &mut client,
        "claude-terminal",
        CLAUDE,
        Some("claude-mobile"),
    )
    .await;
    // Off until this computer's ownership is verified, with nothing stored.
    assert_eq!(
        client.ok("settings.get", json!({})).await["mobile_claude_handoff"],
        false
    );
    assert!(h.store()["mobileClaudeHandoff"].is_null());
    mark_mobile_node_claimed(&h.core);
    // On by default once it is, still with nothing stored.
    assert_eq!(
        client.ok("settings.get", json!({})).await["mobile_claude_handoff"],
        true
    );
    assert!(h.store()["mobileClaudeHandoff"].is_null());
    client
        .ok("settings.set", json!({"mobile_claude_handoff": true}))
        .await;
    assert_eq!(h.store()["mobileClaudeHandoff"], true);
    let plugin = h.home.join(".claude/skills/agent-relay-mobile");
    assert!(plugin.join(".agent-relay-managed").is_file());
    assert!(plugin.join("hooks/register.mjs").is_file());
    let (kind, _) = client
        .error("settings.set", json!({"mobile_claude_handoff": "yes"}))
        .await;
    assert_eq!(kind, "invalid_params");
    assert_eq!(
        client.ok("settings.get", json!({})).await["mobile_claude_handoff"],
        true
    );
    let patches = h.fake.calls("PATCH", "/v1/agents/claude-mobile").len();
    client
        .ok("settings.set", json!({"mobile_claude_handoff": false}))
        .await;
    eventually("opt-out republishes cleared handoff status", || {
        h.fake
            .calls("PATCH", "/v1/agents/claude-mobile")
            .into_iter()
            .skip(patches)
            .any(|call| call.body["metadata"]["mobile_handoff_state"] == "" && call.body["metadata"]["mobile_handoff_enabled"] == false)
    })
    .await;
    assert_eq!(h.store()["mobileClaudeHandoff"], false);
    assert!(
        plugin.join("hooks/register.mjs").is_file(),
        "turning off leaves the inert plugin installed"
    );
    h.stop().await;
}

#[cfg(unix)]
#[tokio::test]
async fn mobile_claude_handoff_install_failure_keeps_the_setting_off() {
    let h = Harness::start(|home| {
        let plugin = home.join(".claude/skills/agent-relay-mobile");
        std::fs::create_dir_all(&plugin).unwrap();
        std::fs::write(plugin.join("user-data"), "keep").unwrap();
    })
    .await;
    let mut client = h.client().await;
    mark_mobile_node_claimed(&h.core);
    // The one Settings row sets both routes: a failed Claude install stores
    // no choice for Claude but still saves the other adapters' route.
    let (kind, _) = client
        .error(
            "settings.set",
            json!({"mobile_claude_handoff": true, "mobile_native_continuation": true}),
        )
        .await;
    assert_eq!(kind, "refused");
    assert!(
        h.store()["mobileClaudeHandoff"].is_null(),
        "a failed install stores no choice"
    );
    assert_eq!(h.store()["mobileNativeContinuation"], true);
    assert_eq!(
        std::fs::read_to_string(h.home.join(".claude/skills/agent-relay-mobile/user-data"))
            .unwrap(),
        "keep"
    );
    h.stop().await;
}

#[cfg(unix)]
#[tokio::test]
async fn mobile_claude_handoff_explains_an_unsafe_shared_skills_target() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let h = Harness::start(|home| {
        let config = home.join(".claude");
        let shared = home.join("shared-skills");
        std::fs::create_dir(&config).unwrap();
        std::fs::create_dir(&shared).unwrap();
        std::fs::set_permissions(&shared, std::fs::Permissions::from_mode(0o777)).unwrap();
        symlink(&shared, config.join("skills")).unwrap();
    })
    .await;
    let mut client = h.client().await;
    mark_mobile_node_claimed(&h.core);

    let (kind, message) = client
        .error("settings.set", json!({"mobile_claude_handoff": true}))
        .await;

    assert_eq!(kind, "refused");
    assert!(message.contains("writable by other users"), "{message}");
    assert!(
        message.contains("Choose a skills directory only you can modify"),
        "{message}"
    );
    assert!(h.store()["mobileClaudeHandoff"].is_null());
    assert!(!h.home.join("shared-skills/agent-relay-mobile").exists());
    h.stop().await;
}

#[tokio::test]
async fn settings_round_trip_and_refuse_unknown_keys() {
    let h = Harness::start(|_| {}).await;
    let mut client = h.client().await;
    let settings = client.ok("settings.get", json!({})).await;
    assert_eq!(
        settings,
        json!({
            "allow_self_registration": true, "auto_activate": false, "show_relay_messages": false,
            "auto_join_general": false, "mobile_claude_handoff": false, "mobile_claude_handoff_supported": cfg!(unix), "mobile_native_continuation": false, "mobile_native_continuation_supported": cfg!(unix), "teammate_native_input": true, "pi_auto_activate": false, "opencode_auto_activate": false, "agent_changes": [],
            "accept_spawns": true, "spawn_max_agents": 0,
            "spawn_full_access_codex": true, "spawn_full_access_claude": true,
            "spawn_allow_teammates": false, "spawn_native_input": true,
            "spawn_billing_codex": "unspecified", "spawn_billing_claude": "unspecified",
            "spawn_repositories": [],
            "spawn_harnesses": {
                "codex": {"full_access": true, "billing": "unspecified"},
                "claude": {"full_access": true, "billing": "unspecified"},
                "opencode": {"full_access": true, "billing": "unspecified"},
                "grok": {"full_access": true, "billing": "unspecified"},
                "muse": {"full_access": false, "billing": "unspecified"},
                "devin": {"full_access": false, "billing": "unspecified"},
            },
        })
    );
    let changed = client
        .ok("settings.set", json!({"allow_self_registration": false}))
        .await;
    assert_eq!(changed["allow_self_registration"], false);
    // The app's own change is the person's: it is not listed as an agent's.
    let changed = client
        .ok("settings.set", json!({"auto_join_general": true}))
        .await;
    assert_eq!(changed["auto_join_general"], true);
    assert_eq!(changed["agent_changes"], json!([]));
    assert_eq!(h.store()["autoJoinGeneral"], true);
    let changed = client
        .ok(
            "settings.set",
            json!({"spawn_max_agents": 2, "spawn_full_access_claude": false}),
        )
        .await;
    assert_eq!(changed["spawn_max_agents"], 2);
    assert_eq!(changed["spawn_full_access_claude"], false);
    assert_eq!(changed["spawn_harnesses"]["claude"]["full_access"], false);
    // Per harness through the map: the flat keys and the store agree.
    let changed = client
        .ok(
            "settings.set",
            json!({"spawn_harnesses": {"codex": {"full_access": false, "billing": "api"}}}),
        )
        .await;
    assert_eq!(changed["spawn_full_access_codex"], false);
    assert_eq!(changed["spawn_billing_codex"], "api");
    assert_eq!(
        changed["spawn_harnesses"]["codex"],
        json!({"full_access": false, "billing": "api"})
    );
    assert_eq!(h.store()["spawnFullAccessCodex"], false);
    assert_eq!(h.store()["spawnBillingCodex"], "api");
    // A harness added since the flat keys is in the map only.
    let changed = client
        .ok(
            "settings.set",
            json!({"spawn_harnesses": {"opencode": {"full_access": false}}}),
        )
        .await;
    assert_eq!(
        changed["spawn_harnesses"]["opencode"],
        json!({"full_access": false, "billing": "unspecified"})
    );
    assert!(changed.get("spawn_full_access_opencode").is_none());
    for bad in [
        json!({"spawn_full_access_opencode": false}),
        json!({"spawn_harnesses": {"aider": {"full_access": true}}}),
        json!({"spawn_harnesses": {"codex": {"sandbox": true}}}),
        json!({"spawn_harnesses": {"codex": {"billing": "free"}}}),
    ] {
        let (kind, _) = client.error("settings.set", bad.clone()).await;
        assert_eq!(kind, "invalid_params", "{bad}");
    }
    // Only the owner spawns here unless teammates are let in.
    let changed = client
        .ok("settings.set", json!({"spawn_allow_teammates": true}))
        .await;
    assert_eq!(changed["spawn_allow_teammates"], true);
    assert_eq!(h.store()["spawnAllowTeammates"], true);
    // On by default; turned off it stays off.
    assert_eq!(changed["accept_spawns"], true);
    let changed = client
        .ok("settings.set", json!({"accept_spawns": false}))
        .await;
    assert_eq!(changed["accept_spawns"], false);
    assert_eq!(h.store()["acceptSpawns"], false);
    assert_eq!(h.store()["allowSelfRegistration"], false);
    let changed = client
        .ok("settings.set", json!({"show_relay_messages": true}))
        .await;
    assert_eq!(changed["show_relay_messages"], true);
    assert_eq!(h.store()["showRelayMessages"], true);
    let (kind, _) = client
        .error("settings.set", json!({"show_relay_messages": "no"}))
        .await;
    assert_eq!(kind, "invalid_params");
    let (kind, _) = client
        .error("settings.set", json!({"analytics": true}))
        .await;
    assert_eq!(kind, "invalid_params");
    let (kind, _) = client
        .error("settings.set", json!({"auto_activate": "yes"}))
        .await;
    assert_eq!(kind, "invalid_params");
    let (kind, _) = client
        .error("settings.set", json!({"auto_activate": null}))
        .await;
    assert_eq!(kind, "invalid_params");
    h.stop().await;
}

#[tokio::test]
async fn auto_activation_puts_new_live_sessions_on_the_relay() {
    let h = Harness::start(|_| {}).await;
    let mut client = h.client().await;
    client
        .ok("settings.set", json!({"auto_activate": true}))
        .await;
    eventually("both registered", || h.fake.agent_names().len() == 2).await;
    // The server sees a registration before the store records it.
    eventually("both recorded", || {
        let store = h.store();
        let auto = store["registrations"]
            .as_array()
            .map_or(0, |registrations| {
                registrations
                    .iter()
                    .filter(|registration| registration["autoActivated"] == true)
                    .count()
            });
        auto == 2
            && store["autoActivationEvents"]
                .as_array()
                .is_some_and(|events| events.len() == 2)
    })
    .await;
    let names = h.fake.agent_names();
    assert!(
        names.iter().any(|n| n.starts_with("codex-relay-desktop-")),
        "{names:?}"
    );
    assert!(
        names.iter().any(|n| n.starts_with("claude-api-")),
        "{names:?}"
    );
    let store = h.store();
    assert_eq!(
        store["registrations"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|registration| registration["autoActivated"] == true)
            .count(),
        2
    );
    assert_eq!(store["autoActivationEvents"].as_array().unwrap().len(), 2);
    h.stop().await;
}

#[tokio::test]
async fn a_devin_session_joins_without_the_auto_activate_setting() {
    let h = Harness::start(|_| {}).await;
    // auto_activate stays off (the default): the Codex and Claude fixtures
    // never register, but a discovered Devin session does — its live lock
    // holder is already the caller proof the other kinds opt in for.
    h.sessions.0.lock().unwrap().push(session(
        SessionKind::Devin,
        "real-gallium",
        "/Users/me/Projects/flows",
    ));
    eventually("devin registered", || {
        h.fake.agent_names().iter().any(|n| n.contains("devin"))
    })
    .await;
    std::thread::sleep(Duration::from_millis(150));
    let names = h.fake.agent_names();
    assert_eq!(
        names.iter().filter(|n| n.contains("devin")).count(),
        1,
        "{names:?}"
    );
    assert!(
        !names
            .iter()
            .any(|n| n.contains("codex") || n.contains("claude")),
        "{names:?}"
    );
    // An explicit off still wins, even for Devin: the setting write queues
    // a pass, and the second session never joins.
    let mut client = h.client().await;
    client
        .ok("settings.set", json!({"auto_activate": false}))
        .await;
    h.sessions.0.lock().unwrap().push(session(
        SessionKind::Devin,
        "other-devin",
        "/Users/me/Projects/two",
    ));
    tokio::time::sleep(Duration::from_secs(1)).await;
    let names = h.fake.agent_names();
    assert_eq!(
        names.iter().filter(|n| n.contains("devin")).count(),
        1,
        "{names:?}"
    );
    h.stop().await;
}

#[tokio::test]
async fn an_ended_automatic_session_is_removed_after_grace_even_when_admission_is_off() {
    let seeded = Arc::new(std::sync::Mutex::new(None));
    let seed_for_fake = seeded.clone();
    let seed_for_store = seeded.clone();
    let h = Harness::start_with(
        move |fake| {
            *seed_for_fake.lock().unwrap() =
                Some(fake.seed_agent("ended-auto", "agent", json!({})));
            None
        },
        move |home, base_url| {
            let agent = seed_for_store.lock().unwrap().clone().unwrap();
            let data = home.join("app-data");
            std::fs::create_dir_all(&data).unwrap();
            std::fs::write(
                data.join("injectable-agents.json"),
                json!({
                    "registrations": [{
                        "name": agent.name,
                        "agentID": agent.id,
                        "target": {"kind": "codex", "id": "01a0c221-6806-7210-af25-97e104b15000"},
                        "title": "Ended work",
                        "baseURL": base_url,
                        "registeredAt": "2020-01-01T00:00:00Z",
                        "workspaceKey": WORKSPACE_KEY,
                        "machinePrefix": "test-desk",
                        "addedBySession": false,
                        "autoActivated": true,
                        "missingSince": "2020-01-01T00:00:00Z"
                    }],
                    "tokens": {"ended-auto": agent.token},
                    "autoActivate": false,
                    "injectedDeliveryIDs": []
                })
                .to_string(),
            )
            .unwrap();
        },
    )
    .await;
    eventually("ended automatic identity removed", || {
        h.fake.agent("ended-auto").is_none()
            && h.store()["registrations"].as_array().unwrap().is_empty()
    })
    .await;
    assert_eq!(h.store()["autoActivate"], false);
    h.stop().await;
}

#[tokio::test]
async fn an_archived_session_leaves_the_relay_and_is_recorded_however_it_was_added() {
    let h = Harness::start(|_| {}).await;
    let mut client = h.client().await;
    h.register(&mut client, "codex", CODEX, Some("codex-api"))
        .await;
    h.register(&mut client, "claude-terminal", CLAUDE, Some("claude-api"))
        .await;
    let address = client.ok("agents.list", json!({})).await["agents"][0]["address"]
        .as_str()
        .unwrap()
        .to_string();
    // A manually added agent whose session merely ended would be kept;
    // one whose session was archived leaves and its name is released.
    h.sessions.archive(Target::new(SessionKind::Codex, CODEX));
    eventually("archived agent removed", || {
        h.fake.agent("codex-api").is_none()
            && h.store()["registrations"].as_array().unwrap().len() == 1
    })
    .await;
    assert!(h.fake.agent("claude-api").is_some(), "others stay");
    let archived = &h.store()["archivedSessions"];
    assert_eq!(archived.as_array().unwrap().len(), 1, "{archived}");
    assert_eq!(archived[0]["name"], "codex-api");
    assert_eq!(archived[0]["address"], address.as_str());
    assert_eq!(archived[0]["target"]["id"], CODEX);
    assert!(archived[0]["archivedAt"].as_str().unwrap().ends_with('Z'));
    let listed = client.ok("agents.list", json!({})).await;
    assert_eq!(listed["agents"].as_array().unwrap().len(), 1);
    assert_eq!(listed["archived"][0]["name"], "codex-api");
    assert_eq!(listed["archived"][0]["address"], address.as_str());
    assert_eq!(
        listed["archived"][0]["archived_at"],
        archived[0]["archivedAt"]
    );
    h.stop().await;
}

#[tokio::test]
async fn a_claude_app_session_that_refuses_as_archived_leaves_the_relay() {
    const CLOUD: &str = "session_01ABCdef234567";
    let h = Harness::start(|_| {}).await;
    h.sessions.0.lock().unwrap().push(session(
        SessionKind::ClaudeCloud,
        CLOUD,
        "/Users/me/Projects/web",
    ));
    let mut client = h.client().await;
    h.register(&mut client, "claude-cloud", CLOUD, Some("claude-web"))
        .await;
    h.injector.then(InjectOutcome::Refused(
        "cloud session session_01ABCdef234567 is archived and cannot accept new messages".into(),
    ));
    let (delivery, _) = h
        .fake
        .queue("claude-web", "dm", None, "bob", "still there?");
    eventually("refusal settled", || {
        delivered(&h.fake, &delivery).as_deref() == Some("failed")
    })
    .await;
    eventually("archived agent removed", || {
        h.fake.agent("claude-web").is_none()
            && h.store()["registrations"].as_array().unwrap().is_empty()
    })
    .await;
    assert_eq!(h.store()["archivedSessions"][0]["name"], "claude-web");
    h.stop().await;
}

#[tokio::test]
async fn an_archived_refusal_settles_after_write_admission_recovers_before_removal() {
    const CLOUD: &str = "session_01ABCdef234567";
    let h = Harness::start(|_| {}).await;
    h.sessions.0.lock().unwrap().push(session(
        SessionKind::ClaudeCloud,
        CLOUD,
        "/Users/me/Projects/web",
    ));
    let mut client = h.client().await;
    h.register(&mut client, "claude-cloud", CLOUD, Some("claude-web"))
        .await;
    h.injector.then(InjectOutcome::Refused(
        "cloud session session_01ABCdef234567 is archived and cannot accept new messages".into(),
    ));
    let (delivery, _) = h
        .fake
        .queue("claude-web", "dm", None, "bob", "still there?");
    let failure_path = format!("POST /v1/deliveries/{delivery}/fail");
    h.fake
        .set_api_error(&failure_path, Some((429, "workspace_busy")));
    eventually("archived refusal recorded", || {
        h.store()["archivedSessions"].is_array()
    })
    .await;
    eventually("SDK exhausts refusal settlement", || {
        h.fake
            .calls("POST", &format!("/v1/deliveries/{delivery}/fail"))
            .len()
            == 3
    })
    .await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(h.injector.injected().len(), 1);
    assert_ne!(delivered(&h.fake, &delivery).as_deref(), Some("failed"));
    h.fake.set_api_error(&failure_path, None);
    eventually("archived refusal settled", || {
        delivered(&h.fake, &delivery).as_deref() == Some("failed")
    })
    .await;
    assert_eq!(
        h.fake.delivery_state(&delivery).unwrap().retryable,
        Some(false)
    );
    eventually("archived registration removed after settlement", || {
        h.store()["registrations"].as_array().unwrap().is_empty()
    })
    .await;
    assert_eq!(h.injector.injected().len(), 1);
    h.stop().await;
}

#[tokio::test]
async fn archive_discovery_cannot_remove_credentials_from_an_inflight_refusal() {
    const CLOUD: &str = "session_01ABCdef234567";
    let h = Harness::start(|_| {}).await;
    h.sessions.0.lock().unwrap().push(session(
        SessionKind::ClaudeCloud,
        CLOUD,
        "/Users/me/Projects/web",
    ));
    let mut client = h.client().await;
    h.register(&mut client, "claude-cloud", CLOUD, Some("claude-web"))
        .await;
    h.injector.then(InjectOutcome::Refused(
        "cloud session session_01ABCdef234567 is archived and cannot accept new messages".into(),
    ));
    h.injector.hold.store(true, Ordering::SeqCst);
    let (delivery, _) = h
        .fake
        .queue("claude-web", "dm", None, "bob", "still there?");
    let fail = format!("/v1/deliveries/{delivery}/fail");
    h.fake
        .set_api_error(&format!("POST {fail}"), Some((429, "workspace_busy")));
    eventually("injector held", || {
        h.injector.holding.load(Ordering::SeqCst)
    })
    .await;
    h.sessions
        .archive(Target::new(SessionKind::ClaudeCloud, CLOUD));
    eventually("discovery archived agent while injection held", || {
        h.store()["archivedSessions"].is_array()
    })
    .await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    h.injector.hold.store(false, Ordering::SeqCst);
    eventually("refusal settlement exhausted SDK retries", || {
        h.fake.calls("POST", &fail).len() == 3
    })
    .await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    h.fake.set_api_error(&format!("POST {fail}"), None);
    eventually(
        "inflight refusal settled before discovered archive removal",
        || delivered(&h.fake, &delivery).as_deref() == Some("failed"),
    )
    .await;
    eventually("archived registration removed", || {
        h.store()["registrations"].as_array().unwrap().is_empty()
    })
    .await;
    assert_eq!(h.injector.injected().len(), 1);
    h.stop().await;
}

#[tokio::test]
async fn an_archived_agent_is_never_listed_on_the_relay_while_its_removal_is_pending() {
    const CLOUD: &str = "session_01ABCdef234567";
    let h = Harness::start(|_| {}).await;
    h.sessions.0.lock().unwrap().push(session(
        SessionKind::ClaudeCloud,
        CLOUD,
        "/Users/me/Projects/web",
    ));
    let mut client = h.client().await;
    h.register(&mut client, "claude-cloud", CLOUD, Some("claude-web"))
        .await;
    h.fake.set_undeletable(&["claude-web"]);
    h.injector.then(InjectOutcome::Refused(
        "cloud session session_01ABCdef234567 is archived".into(),
    ));
    h.fake
        .queue("claude-web", "dm", None, "bob", "still there?");
    eventually("marked archived", || {
        h.store()["registrations"][0]["archivedAt"].is_string()
    })
    .await;
    // Removal keeps failing: the agent is listed only as archived.
    let listed = client.ok("agents.list", json!({})).await;
    assert!(listed["agents"].as_array().unwrap().is_empty(), "{listed}");
    assert_eq!(listed["archived"][0]["name"], "claude-web");
    let sessions = client.ok("sessions.list", json!({})).await;
    assert!(
        !sessions["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["target"]["id"] == CLOUD),
        "{sessions}"
    );
    h.fake.set_undeletable(&[]);
    eventually("archived agent removed once Agent Relay allows it", || {
        h.fake.agent("claude-web").is_none()
            && h.store()["registrations"].as_array().unwrap().is_empty()
    })
    .await;
    h.stop().await;
}

#[tokio::test]
async fn a_refusal_that_is_not_an_archive_keeps_the_agent() {
    let h = Harness::start(|_| {}).await;
    let mut client = h.client().await;
    h.register(&mut client, "codex", CODEX, Some("codex-api"))
        .await;
    h.injector
        .then(InjectOutcome::Refused("no Codex thread has this id".into()));
    let (delivery, _) = h.fake.queue("codex-api", "dm", None, "bob", "hello");
    eventually("refusal settled", || {
        delivered(&h.fake, &delivery).as_deref() == Some("failed")
    })
    .await;
    assert!(h.fake.agent("codex-api").is_some());
    assert!(h.store().get("archivedSessions").is_none());
    h.stop().await;
}

#[tokio::test]
async fn a_linux_store_is_migrated_when_the_core_starts() {
    let h = Harness::seeded(|home, relaycast| {
        let data = home.join("app-data");
        std::fs::create_dir_all(&data).unwrap();
        std::fs::write(
            data.join("injectable-agents.json"),
            json!({
                "registrations": [{"name": "claude-rd-1a2b", "agentID": "agent_1",
                    "target": {"kind": "claude-terminal", "id": CLAUDE}, "title": "api",
                    "baseURL": relaycast, "registeredAt": 1790683200.0,
                    "workspaceKey": "rk_live_test0000", "machinePrefix": "linux-box"}],
                "tokens": {"claude-rd-1a2b": "at_live_x"},
                "workspaceKey": null, "workspaceID": null,
                "replyParents": {CLAUDE: ["m1"]},
                "injectedDeliveryIDs": [], "inDoubtDeliveryIDs": []
            })
            .to_string(),
        )
        .unwrap();
    })
    .await;
    let mut client = h.client().await;
    let listed = client.ok("agents.list", json!({})).await;
    assert_eq!(listed["agents"][0]["name"], "claude-rd-1a2b");
    assert_eq!(
        listed["agents"][0]["address"],
        "claude-rd-1a2b@linux-box-agent_1"
    );
    let store = h.store();
    assert_eq!(
        store["registrations"][0]["registeredAt"],
        "2026-09-29T12:00:00Z"
    );
    assert_eq!(store["replyRoutes"][0]["messageID"], "m1");
    assert!(store.get("replyParents").is_none());
    h.stop().await;
}

#[tokio::test]
async fn an_undecodable_store_is_set_aside_and_reported() {
    let h = Harness::start(|home| {
        let data = home.join("app-data");
        std::fs::create_dir_all(&data).unwrap();
        std::fs::write(
            data.join("injectable-agents.json"),
            br#"{"registrations": 7}"#,
        )
        .unwrap();
    })
    .await;
    let mut client = h.client().await;
    let status = client.ok("status.get", json!({})).await;
    let error = status["agents"]["store_error"].as_str().unwrap();
    assert!(error.contains("could not be read"), "{error}");
    let aside: Vec<_> = std::fs::read_dir(h.home.join("app-data"))
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().contains(".unreadable-"))
        .collect();
    assert_eq!(aside.len(), 1);
    h.stop().await;
}

// MARK: Messaging as the signed-in person

fn signed_in(fake: &FakeRelaycast) -> Arc<FakeCloud> {
    let person = fake.seed_agent(PERSON, "human", json!({}));
    let cloud = Arc::new(FakeCloud::new("user-1"));
    cloud.answer(
        "POST",
        "/workspaces/50587328-441d-4acb-b8f3-dbe1b3c5de99/messaging/identity/credential",
        Ok(
            json!({"identity": {"name": PERSON, "agentId": person.id, "token": person.token,
            "relaycastUrl": fake.base_url}}),
        ),
    );
    cloud
}

#[tokio::test]
async fn messages_go_out_as_you_and_history_reads_in_threads() {
    let h = Harness::signed_in().await;
    let cloud = h.cloud.clone().unwrap();
    let mut client = h.client().await;
    h.fake.seed_agent("reviewer", "agent", json!({}));

    let sent = client
        .ok(
            "messages.send",
            json!({"to": "reviewer", "text": "  first question  "}),
        )
        .await;
    assert_eq!(sent["to"], "reviewer");
    let first = sent["message_id"].as_str().unwrap().to_string();
    let dm = h.fake.calls("POST", "/v1/dm").pop().unwrap();
    assert_eq!(dm.body["text"], "first question");
    let person = h.fake.agent(PERSON).unwrap();
    assert_eq!(
        dm.authorization.as_deref(),
        Some(format!("Bearer {}", person.token).as_str())
    );
    client
        .ok("messages.send", json!({"to": "reviewer", "text": "second"}))
        .await;
    // The reviewer answers beneath the first question, then DMs plainly.
    let reviewer = h.fake.agent("reviewer").unwrap();
    let base = h.fake.base_url.clone();
    let token = agent_relay_probe::relay::workspace::Secret::new(reviewer.token.clone());
    agent_relay_probe::relay::client::reply(&base, &token, &first, "answer to first", None)
        .await
        .unwrap();
    agent_relay_probe::relay::client::send_dm(
        &base,
        &token,
        &agent_relay_probe::relay::links::Endpoint::Name(PERSON.into()),
        "plain DM",
        None,
    )
    .await
    .unwrap();

    let history = client
        .ok("messages.history", json!({"endpoint": "reviewer"}))
        .await;
    assert_eq!(history["identity"], PERSON);
    let texts: Vec<&str> = history["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["text"].as_str().unwrap())
        .collect();
    assert_eq!(
        texts,
        ["first question", "answer to first", "second", "plain DM"]
    );
    assert_eq!(history["messages"][1]["thread_id"], first);
    assert_eq!(history["messages"][0]["mine"], true);
    assert_eq!(history["messages"][1]["mine"], false);
    // Replies queued for you were acknowledged while reading.
    assert!(!h.fake.calls("GET", "/v1/deliveries").is_empty());

    let conversations = client.ok("messages.conversations", json!({})).await;
    assert_eq!(
        conversations["conversations"][0]["peer"]["name"],
        "reviewer"
    );
    // One identity fetch, reused.
    let fetches = cloud
        .paths()
        .iter()
        .filter(|p| p.ends_with("/messaging/identity/credential"))
        .count();
    assert_eq!(fetches, 1);
    h.stop().await;
}

#[tokio::test]
async fn an_exact_address_history_needs_immutable_proof() {
    let h = Harness::signed_in().await;
    let mut client = h.client().await;
    let reviewer = h.fake.seed_agent("reviewer", "agent", json!({}));
    // Before the reviewer ever wrote, nothing proves the address.
    client
        .ok(
            "messages.send",
            json!({"address": reviewer.address, "text": "exact"}),
        )
        .await;
    let dm = h.fake.calls("POST", "/v1/dm").pop().unwrap();
    assert_eq!(
        dm.body,
        json!({"address": reviewer.address, "text": "exact"})
    );
    let history = client
        .ok("messages.history", json!({"endpoint": reviewer.address}))
        .await;
    assert_eq!(history["messages"], json!([]));
    // A name lookup is never a fallback for an address.
    let (kind, _) = client
        .error(
            "messages.send",
            json!({"address": "reviewer@nowhere", "text": "x"}),
        )
        .await;
    assert_eq!(kind, "not_found");
    let (kind, _) = client
        .error("messages.send", json!({"address": "reviewer", "text": "x"}))
        .await;
    assert_eq!(kind, "invalid_params");
    let (kind, _) = client
        .error("messages.send", json!({"to": "reviewer", "text": "   "}))
        .await;
    assert_eq!(kind, "invalid_params");
    h.stop().await;
}

#[tokio::test]
async fn a_send_reports_what_relaycast_holds_for_the_message() {
    let h = Harness::signed_in().await;
    let mut client = h.client().await;
    eventually("the workspace", || h.core.workspace().is_some()).await;
    let now = chrono::Utc::now().to_rfc3339();
    let reviewer = h.fake.seed_agent("reviewer", "agent", json!({}));
    h.fake.set_presence("reviewer", "active", &now, true);
    h.fake.seed_agent("sleeper", "agent", json!({}));
    h.fake
        .set_presence("sleeper", "offline", "2026-09-29T11:00:00Z", true);

    // Relaycast holds the message until the reviewer's host takes it,
    // however live the reviewer reads.
    let sent = client
        .ok(
            "messages.send",
            json!({"to": "reviewer", "text": "status?"}),
        )
        .await;
    let message = sent["message_id"].as_str().unwrap().to_string();
    assert_eq!(sent["recipient"]["known"], true);
    assert_eq!(sent["recipient"]["agent"]["liveness"], "live");
    assert_eq!(sent["recipient"]["message"], "queued");
    let call = h.fake.calls("GET", "/v1/agents/reviewer").pop().unwrap();
    assert_eq!(
        call.authorization.as_deref(),
        Some(format!("Bearer {WORKSPACE_KEY}").as_str()),
        "the roster is read with the workspace key"
    );
    let follow = |message: &str| json!({"to": "reviewer", "message_id": message});
    h.fake.hand_over("reviewer");
    let looked = client.ok("roster.get", follow(&message)).await;
    assert_eq!(looked["message"], "delivered");
    h.fake.acknowledge_all("reviewer");
    let looked = client.ok("roster.get", follow(&message)).await;
    assert_eq!(looked["message"], "picked_up");

    // An agent that is not running: queued, and the liveness says why.
    let sent = client
        .ok(
            "messages.send",
            json!({"to": "@sleeper", "text": "status?"}),
        )
        .await;
    assert_eq!(sent["recipient"]["message"], "queued");
    assert_eq!(sent["recipient"]["agent"]["liveness"], "offline");

    // An exact address matches only the agent hosted there.
    let looked = client
        .ok("roster.get", json!({"address": reviewer.address}))
        .await;
    assert_eq!(looked["agent"]["name"], "reviewer");
    assert_eq!(looked["message"], Value::Null, "no message asked about");

    // Nobody has the name or address.
    for params in [
        json!({"to": "nobody", "message_id": "m1"}),
        json!({"address": "reviewer@nowhere", "message_id": "m1"}),
    ] {
        let looked = client.ok("roster.get", params.clone()).await;
        assert_eq!(looked["known"], true, "{params}");
        assert_eq!(looked["agent"], Value::Null, "{params}");
        assert_eq!(looked["message"], "no_such_agent", "{params}");
    }
    let (kind, _) = client
        .error("messages.send", json!({"to": "nobody", "text": "x"}))
        .await;
    assert_eq!(kind, "not_found");
    let (kind, _) = client
        .error("roster.get", json!({"to": "a", "address": "a@b"}))
        .await;
    assert_eq!(kind, "invalid_params");
    h.stop().await;
}

#[tokio::test]
async fn a_status_relaycast_cannot_list_leaves_out_only_its_agents() {
    let h = Harness::signed_in().await;
    let mut client = h.client().await;
    eventually("the workspace", || h.core.workspace().is_some()).await;
    let now = chrono::Utc::now().to_rfc3339();
    h.fake.seed_agent("working", "agent", json!({}));
    h.fake.seed_agent("resting", "agent", json!({}));
    h.fake.set_presence("resting", "idle", &now, true);
    h.fake.set_failing(&["GET /v1/agents?status=idle"]);
    let roster = client.ok("roster.list", json!({})).await;
    let names: Vec<&str> = roster["agents"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["name"].as_str().unwrap())
        .collect();
    assert!(names.contains(&"working"), "{names:?}");
    assert!(!names.contains(&"resting"), "{names:?}");
    assert_eq!(roster["unread_statuses"], json!(["idle"]));

    // Every read failing is the list failing.
    h.fake.set_failing(&["GET /v1/agents"]);
    client.error("roster.list", json!({})).await;
    h.fake.set_failing(&[]);
    let roster = client.ok("roster.list", json!({})).await;
    assert_eq!(roster["unread_statuses"], json!([]));
    assert_eq!(roster["agents"].as_array().unwrap().len(), 3, "with you");
    h.stop().await;
}

#[tokio::test]
async fn an_agent_without_a_node_is_offline_never_gone() {
    let h = Harness::signed_in().await;
    let mut client = h.client().await;
    eventually("the workspace", || h.core.workspace().is_some()).await;
    h.fake.seed_agent("mcp-agent", "agent", json!({}));
    h.fake
        .set_presence("mcp-agent", "offline", "2026-09-29T11:00:00Z", false);
    let looked = client.ok("roster.get", json!({"to": "mcp-agent"})).await;
    assert_eq!(looked["agent"]["address"], Value::Null);
    assert_eq!(looked["agent"]["liveness"], "offline");
    let roster = client
        .ok("roster.list", json!({"include_idle": true}))
        .await;
    let listed = roster["agents"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["name"] == "mcp-agent")
        .unwrap()
        .clone();
    assert_eq!(listed["liveness"], "offline");
    // The default roster lists only running agents.
    let roster = client.ok("roster.list", json!({})).await;
    assert!(!roster["agents"]
        .as_array()
        .unwrap()
        .iter()
        .any(|a| a["name"] == "mcp-agent"));
    h.stop().await;
}

#[tokio::test]
async fn another_workspaces_roster_never_answers_for_your_messages() {
    // Your identity sends in one Relaycast; this computer's key is for
    // another, with a same-name agent in it.
    let messaging = FakeRelaycast::start(Behaviour::default()).await;
    messaging.seed_agent("alice", "agent", json!({}));
    let h = Harness::start_with(|_| Some(signed_in(&messaging)), |_, _| {}).await;
    let mut client = h.client().await;
    eventually("the workspace", || h.core.workspace().is_some()).await;
    h.fake.seed_agent("alice", "agent", json!({}));

    let looked = client.ok("roster.get", json!({"to": "alice"})).await;
    assert_eq!(
        looked,
        json!({"known": false, "agent": null, "message": null})
    );
    let sent = client
        .ok("messages.send", json!({"to": "alice", "text": "hi"}))
        .await;
    assert!(sent["message_id"].is_string());
    assert_eq!(sent["recipient"]["known"], false);
    assert_eq!(sent["recipient"]["message"], Value::Null);
    assert!(
        h.fake.calls("GET", "/v1/agents/alice").is_empty(),
        "the key's workspace is never read for it"
    );
    h.stop().await;
}

#[tokio::test]
async fn a_session_on_this_computer_is_live_only_while_it_runs() {
    let h = Harness::signed_in().await;
    let mut client = h.client().await;
    h.register(&mut client, "codex", CODEX, Some("codex-api"))
        .await;
    *h.sessions.5.lock().unwrap() = Duration::from_millis(500);
    let looked = tokio::time::timeout(
        Duration::from_millis(200),
        client.ok("roster.get", json!({"to": "codex-api"})),
    )
    .await
    .expect("roster liveness reads the shared snapshot without discovery");
    assert_eq!(looked["agent"]["where"], "this_computer");
    assert_eq!(looked["agent"]["liveness"], "live");

    // Relaycast still sees this desktop, but the session stopped. The
    // background pass updates the shared view independently of list reads.
    for session in h.sessions.0.lock().unwrap().iter_mut() {
        session.live = false;
    }
    tokio::time::timeout(Duration::from_secs(7), async {
        loop {
            let looked = client.ok("roster.get", json!({"to": "codex-api"})).await;
            if looked["agent"]["liveness"] == "offline" {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("background discovery updates roster liveness");
    h.stop().await;
}

#[tokio::test]
async fn agents_name_their_owner_and_keep_it_when_another_person_attaches() {
    let h = Harness::signed_in().await;
    let cloud = h.cloud.clone().unwrap();
    let mut client = h.client().await;
    h.register(&mut client, "codex", CODEX, Some("codex-api"))
        .await;
    let registered = h.fake.calls("POST", "/v1/agents").pop().unwrap();
    let metadata = &registered.body["metadata"];
    assert_eq!(metadata["cloud_user_id"], "user-1");
    assert_eq!(
        metadata["cloud_workspace_id"],
        "50587328-441d-4acb-b8f3-dbe1b3c5de99"
    );
    assert_eq!(
        metadata["owner_hash"],
        json!(agent_relay_probe::relay::people::identity_hash("user-1"))
    );
    assert_eq!(
        registered.origin,
        (
            Some("relay-desktop".to_string()),
            Some(agent_relay_probe::VERSION.to_string())
        )
    );

    // Ownership never moves after registration: another person attaching
    // credits nothing to them.
    h.core.credit_agents().await;
    cloud.account.lock().unwrap().as_mut().unwrap().user_id = Some("user-2".into());
    h.core.credit_agents().await;
    assert!(h.fake.calls("PATCH", "/v1/agents/codex-api").is_empty());
    assert_eq!(
        h.fake.agent("codex-api").unwrap().metadata["cloud_user_id"],
        "user-1"
    );
    h.stop().await;
}

#[tokio::test]
async fn a_stored_registration_is_never_credited_after_the_fact() {
    let h = Harness::start_with(
        |fake| Some(signed_in(fake)),
        |home, relaycast| {
            let data = home.join("app-data");
            std::fs::create_dir_all(&data).unwrap();
            let registration = |name: &str, base: &str, key: Option<&str>| {
                json!({"name": name, "agentID": format!("agent_{name}"),
                    "target": {"kind": "claude-terminal", "id": CLAUDE}, "title": "api",
                    "baseURL": base, "registeredAt": 1790683200.0,
                    "workspaceKey": key, "machinePrefix": "linux-box"})
            };
            std::fs::write(
                data.join("injectable-agents.json"),
                json!({
                    "registrations": [
                        registration("keyed", relaycast, Some(WORKSPACE_KEY)),
                        registration("keyless", "https://other.example", None),
                    ],
                    "tokens": {"keyed": "at_live_x", "keyless": "at_live_y"},
                    "workspaceKey": null, "workspaceID": null,
                    "injectedDeliveryIDs": [], "inDoubtDeliveryIDs": []
                })
                .to_string(),
            )
            .unwrap();
        },
    )
    .await;
    h.fake.seed_agent("keyed", "agent", json!({}));
    h.core.credit_agents().await;
    h.core.credit_agents().await;
    // No historical backfill: registrations stored before an owner was bound
    // are not credited to whoever is signed in now.
    assert!(h.fake.calls("PATCH", "/v1/agents/keyed").is_empty());
    assert!(h.fake.calls("PATCH", "/v1/agents/keyless").is_empty());
    h.stop().await;
}

#[tokio::test]
async fn people_and_the_roster_join_by_owner_hash() {
    let h = Harness::signed_in().await;
    let cloud = h.cloud.clone().unwrap();
    cloud.answer(
        "GET",
        "/members",
        Ok(json!({"members": [
            {"userId": "user-1", "name": "Ada", "email": "ada@example.com", "role": "owner"},
            {"userId": "user-2", "name": "Alice", "email": "a@example.com", "avatarUrl": "https://example.com/a.png"},
        ]})),
    );
    let mut client = h.client().await;
    let people = client.ok("people.list", json!({})).await;
    assert!(
        cloud.paths().contains(&"GET /members".to_string()),
        "{:?}",
        cloud.paths()
    );
    let alice_hash = agent_relay_probe::relay::people::identity_hash("user-2");
    assert_eq!(
        people["people"],
        json!([
            {"name": "Ada", "avatar_url": "https://www.gravatar.com/avatar/3e3417d7ef77d5932a6734b916515ed5?d=identicon&s=96",
             "identity_hash": agent_relay_probe::relay::people::identity_hash("user-1"), "is_self": true},
            {"name": "Alice", "avatar_url": "https://example.com/a.png", "identity_hash": alice_hash, "is_self": false},
        ])
    );

    h.register(&mut client, "codex", CODEX, Some("codex-api"))
        .await;
    let mine = &h.fake.calls("POST", "/v1/agents")[0].body["metadata"]["owner_hash"];
    assert_eq!(
        mine,
        &json!(agent_relay_probe::relay::people::identity_hash("user-1"))
    );
    h.fake.seed_agent(
        "alice-agent",
        "agent",
        json!({"owner_hash": alice_hash, "host": "Alice's Mac", "objective": "Reviews"}),
    );
    h.fake.seed_agent(
        "cloud-bot",
        "agent",
        json!({"source": "cloud-persona-deploy"}),
    );
    let roster = client.ok("roster.list", json!({})).await;
    let by_name = |name: &str| {
        roster["agents"]
            .as_array()
            .unwrap()
            .iter()
            .find(|a| a["name"] == name)
            .cloned()
            .unwrap()
    };
    assert_eq!(by_name("codex-api")["where"], "this_computer");
    assert_eq!(by_name("codex-api")["is_self"], true);
    assert_eq!(by_name("alice-agent")["where"], "other_desktop");
    assert_eq!(by_name("alice-agent")["owner_hash"], alice_hash);
    assert_eq!(by_name("alice-agent")["host"], "Alice's Mac");
    assert_eq!(by_name("cloud-bot")["where"], "cloud");
    let filtered = client.ok("roster.list", json!({"where": "cloud"})).await;
    assert_eq!(filtered["agents"].as_array().unwrap().len(), 1);
    let queries: Vec<String> = h
        .fake
        .calls("GET", "/v1/agents")
        .into_iter()
        .map(|call| call.query)
        .collect();
    for status in ["active", "online", "idle", "waiting", "blocked"] {
        assert!(queries.contains(&format!("status={status}")), "{queries:?}");
    }
    client
        .ok("roster.list", json!({"include_idle": true}))
        .await;
    assert_eq!(
        h.fake.calls("GET", "/v1/agents").pop().unwrap().query,
        "status=all"
    );
    h.stop().await;
}

#[tokio::test]
async fn signed_out_messaging_and_people_ask_for_a_sign_in() {
    let h = Harness::start(|_| {}).await;
    let mut client = h.client().await;
    for (method, params) in [
        ("people.list", json!({})),
        ("messages.conversations", json!({})),
        ("messages.history", json!({"endpoint": "reviewer"})),
        ("messages.send", json!({"to": "reviewer", "text": "hi"})),
    ] {
        let (kind, _) = client.error(method, params).await;
        assert_eq!(kind, "not_signed_in", "{method}");
    }
    h.stop().await;
}

#[tokio::test]
async fn links_parse_for_the_configured_site() {
    let h = Harness::start(|_| {}).await;
    let mut client = h.client().await;
    let link = client
        .ok(
            "links.parse",
            json!({"url": "agentrelay://message?to=reviewer%40sf-frame"}),
        )
        .await;
    assert_eq!(
        link,
        json!({"kind": "message", "endpoint": "reviewer@sf-frame", "address": true})
    );
    let connect = client
        .ok(
            "links.parse",
            json!({"url": "agentrelay-dev://connect?site=http%3A%2F%2Flocalhost%3A3100&account=user-1&workspace=ws_1",
                "site_url": "http://localhost:3100"}),
        )
        .await;
    assert_eq!(connect["kind"], "connect");
    assert_eq!(connect["workspace_id"], "ws_1");
    let (kind, _) = client
        .error(
            "links.parse",
            json!({"url": "agentrelay://message?to=a%40b&text=secret"}),
        )
        .await;
    assert_eq!(kind, "invalid_params");
    h.stop().await;
}

#[tokio::test]
async fn hello_lists_the_agent_methods_and_topics() {
    let h = Harness::start(|_| {}).await;
    let stream = agent_relay_probe::relay::transport::CoreStream::connect(&h.socket)
        .await
        .unwrap();
    drop(stream);
    let mut client = h.client().await;
    let hello = client.ok("hello", json!({"bridge_version": 2})).await;
    let methods = hello["methods"].as_array().unwrap();
    for method in [
        "agents.register",
        "messages.history",
        "people.list",
        "links.parse",
        "roster.list",
        "settings.set",
    ] {
        assert!(methods.contains(&json!(method)), "{method}");
    }
    let topics = hello["topics"].as_array().unwrap();
    assert!(topics.contains(&json!("invalidated")) && topics.contains(&json!("notify")));
    h.stop().await;
}

#[tokio::test]
async fn an_integration_subscribes_and_cleans_up_through_relayfile() {
    let h = Harness::signed_in().await;
    let cloud = h.cloud.clone().unwrap();
    cloud.answer(
        "GET",
        "/workspaces/rw_fake/integrations",
        Ok(json!({"integrations": [{"provider": "github", "status": "connected"}]})),
    );
    cloud.answer(
        "POST",
        "/workspaces/rw_fake/relayfile/delegated-token",
        Ok(json!({"relayfileToken": "rf_token", "relayfileUrl": h.fake.base_url, "relayfileWorkspaceId": "rw_fake"})),
    );
    let mut client = h.client().await;
    h.register(&mut client, "codex", CODEX, Some("codex-api"))
        .await;
    let subscribed = client
        .ok(
            "agents.integrations.subscribe",
            json!({"name": "codex-api", "provider": "github", "resource": "acme/api#1"}),
        )
        .await;
    assert_eq!(subscribed["path_glob"], "/github/repos/acme/api/pulls/1/**");
    let store = h.store();
    let entry = &store["registrations"][0]["integrations"][0];
    assert_eq!(entry["ready"], true);
    assert!(entry["inboundURL"]
        .as_str()
        .unwrap()
        .contains("desktopSubscription="));
    let agent = h.fake.agent("codex-api").unwrap();
    assert_eq!(
        store["registrations"][0]["integrationChannelName"],
        format!("agent-events-{}", agent.id)
    );
    assert_eq!(h.fake.relayfile_subscriptions().len(), 1);
    assert_eq!(h.fake.subscription_ids().len(), 1);
    let reply_subscriptions = h.fake.calls("POST", "/v1/subscriptions");
    assert_eq!(reply_subscriptions.len(), 1);
    assert_eq!(
        reply_subscriptions[0].body["filter"],
        json!({"channel": format!("agent-events-{}", agent.id)})
    );
    let (kind, _) = client
        .error("agents.unregister", json!({"name": "codex-api"}))
        .await;
    assert_eq!(kind, "refused", "integrations first");
    // A provider event in the agent's channel is injected; no automatic
    // answer goes back to the provider.
    let channel_id = store["registrations"][0]["integrationChannelID"]
        .as_str()
        .unwrap()
        .to_string();
    h.fake.seed_agent("__relay_webhook__", "service", json!({}));
    let (event, _) = h.fake.queue(
        "codex-api",
        "message",
        Some(&channel_id),
        "__relay_webhook__",
        "Github pull_request.closed\nRelayfile path: /github/repos/acme/api/pulls/1__done/meta.json",
    );
    eventually("acked", || {
        delivered(&h.fake, &event).as_deref() == Some("acked")
    })
    .await;
    assert_eq!(h.injector.injected().len(), 1);
    assert!(h.store().get("replies").is_none());

    // A close event is delivered first, then retires the numeric PR binding.
    // GitHub also sends this event when a pull request is merged.
    eventually("terminal integration cleanup", || {
        h.store()["registrations"][0].get("integrations").is_none()
            && h.fake.relayfile_subscriptions().is_empty()
            && h.fake.subscription_ids().is_empty()
    })
    .await;

    let already_gone = client
        .ok(
            "agents.integrations.unsubscribe",
            json!({"name": "codex-api", "provider": "github", "resource": "acme/api#1"}),
        )
        .await;
    assert_eq!(already_gone["already_unsubscribed"], true);
    assert!(h.fake.relayfile_subscriptions().is_empty());
    assert!(h.fake.subscription_ids().is_empty());
    assert!(h.store()["registrations"][0].get("integrations").is_none());
    client
        .ok("agents.unregister", json!({"name": "codex-api"}))
        .await;
    h.stop().await;
}

#[tokio::test]
async fn a_terminal_integration_cleans_up_when_injection_cannot_complete() {
    for outcome in [
        InjectOutcome::InDoubt("session answer was lost".into()),
        InjectOutcome::Refused("session is archived".into()),
    ] {
        let h = Harness::signed_in().await;
        let cloud = h.cloud.clone().unwrap();
        cloud.answer(
            "GET",
            "/workspaces/rw_fake/integrations",
            Ok(json!({"integrations": [{"provider": "github", "status": "connected"}]})),
        );
        cloud.answer(
            "POST",
            "/workspaces/rw_fake/relayfile/delegated-token",
            Ok(json!({"relayfileToken": "rf_token", "relayfileUrl": h.fake.base_url, "relayfileWorkspaceId": "rw_fake"})),
        );
        let mut client = h.client().await;
        h.register(&mut client, "codex", CODEX, Some("codex-api"))
            .await;
        client
            .ok(
                "agents.integrations.subscribe",
                json!({"name": "codex-api", "provider": "github", "resource": "acme/api#1"}),
            )
            .await;
        let channel_id = h.store()["registrations"][0]["integrationChannelID"]
            .as_str()
            .unwrap()
            .to_string();
        h.injector.then(outcome);
        h.fake.seed_agent("__relay_webhook__", "service", json!({}));
        let (event, _) = h.fake.queue(
            "codex-api",
            "message",
            Some(&channel_id),
            "__relay_webhook__",
            "Github pull_request.closed\nRelayfile path: /github/repos/acme/api/pulls/1__done/meta.json",
        );
        eventually("terminal event settled", || {
            delivered(&h.fake, &event).as_deref() == Some("failed")
        })
        .await;
        eventually("terminal integration cleanup", || {
            h.store()["registrations"][0].get("integrations").is_none()
                && h.fake.relayfile_subscriptions().is_empty()
                && h.fake.subscription_ids().is_empty()
        })
        .await;
        h.stop().await;
    }
}

#[tokio::test]
async fn connecting_a_provider_does_not_hold_the_agent() {
    let h = Harness::signed_in().await;
    let cloud = h.cloud.clone().unwrap();
    cloud.answer(
        "GET",
        "/workspaces/rw_fake/integrations",
        Ok(json!({"integrations": []})),
    );
    cloud.answer(
        "POST",
        "/workspaces/rw_fake/integrations/connect-session",
        Ok(json!({"connectLink": "https://connect.example/github"})),
    );
    let mut client = h.client().await;
    h.register(&mut client, "codex", CODEX, Some("codex-api"))
        .await;
    let socket = h.socket.clone();
    let subscribing = tokio::spawn(async move {
        let mut other = Client::connect(&socket).await;
        other
            .error(
                "agents.integrations.subscribe",
                json!({"name": "codex-api", "provider": "github", "resource": "acme/api"}),
            )
            .await
    });
    eventually("connecting", || {
        cloud
            .paths()
            .contains(&"POST /workspaces/rw_fake/integrations/connect-session".to_string())
    })
    .await;
    // The person may take minutes in the browser; the agent can still be
    // turned off meanwhile.
    tokio::time::timeout(
        Duration::from_secs(2),
        client.ok("agents.unregister", json!({"name": "codex-api"})),
    )
    .await
    .expect("unregister is not held behind the provider connection");
    subscribing.abort();
    h.stop().await;
}

#[tokio::test]
async fn a_refusal_created_while_the_old_alias_retires_is_not_orphaned() {
    let h = Harness::start(|_| {}).await;
    let mut client = h.client().await;
    h.register(&mut client, "codex", CODEX, Some("codex-api"))
        .await;
    client
        .ok(
            "agents.rename",
            json!({"name":"codex-api", "new_name":"first"}),
        )
        .await;
    let register_release = h.fake.hold("POST /v1/agents");
    let mut rename_client = h.client().await;
    let renamed = tokio::spawn(async move {
        rename_client
            .ok(
                "agents.rename",
                json!({"name":"codex-api", "new_name":"new-name"}),
            )
            .await
    });
    eventually("rename registration held after checking old queue", || {
        h.fake.held("POST /v1/agents") >= 1
    })
    .await;
    h.injector.then(InjectOutcome::Refused(
        "session rejects this message".into(),
    ));
    h.injector.hold.store(true, Ordering::SeqCst);
    let (delivery, _) = h
        .fake
        .queue("first", "dm", None, "bob", "arrived during rename");
    let fail = format!("/v1/deliveries/{delivery}/fail");
    h.fake
        .set_api_error(&format!("POST {fail}"), Some((429, "workspace_busy")));
    eventually("old injection held", || {
        h.injector.holding.load(Ordering::SeqCst)
    })
    .await;
    register_release.send(true).unwrap();
    eventually("old alias replaced before refusal finishes", || {
        h.store()["registrations"][0]["alias"]["name"] == "new-name"
    })
    .await;
    h.injector.hold.store(false, Ordering::SeqCst);
    let result = renamed.await.unwrap();
    assert_eq!(result["name"], "new-name");
    // The refusal was journaled under the replaced name, which keeps
    // forwarding (and its credential) after the rename; its settlement is
    // retried under that credential once Relaycast stops answering busy.
    eventually("refusal journaled under the retired name", || {
        h.store()["pendingRefusalSettlements"]
            .as_array()
            .is_some_and(|pending| pending.len() == 1)
    })
    .await;
    h.fake.set_api_error(&format!("POST {fail}"), None);
    eventually_for(
        "retired credential has no pending refusal settlement",
        Duration::from_secs(30),
        || {
            h.store()["pendingRefusalSettlements"]
                .as_array()
                .is_none_or(|pending| pending.is_empty())
        },
    )
    .await;
    assert_eq!(delivered(&h.fake, &delivery).as_deref(), Some("failed"));
    assert_eq!(h.injector.injected().len(), 1);
    h.stop().await;
}

#[tokio::test]
async fn a_rename_never_waits_on_or_loses_messages_to_the_original_name() {
    let h = Harness::start(|_| {}).await;
    let mut client = h.client().await;
    h.register(&mut client, "codex", CODEX, Some("old-name"))
        .await;
    h.fake.seed_agent("alice", "agent", json!({}));
    for _ in 0..3 {
        h.injector.then(InjectOutcome::Waiting(
            "Waiting — session not running".into(),
        ));
    }
    let (delivery, _) = h.fake.send_dm("alice", "old-name", "hi");
    eventually("waiting", || !h.injector.injected().is_empty()).await;
    // In flight to the original name: the rename goes ahead regardless.
    client
        .ok(
            "agents.rename",
            json!({"name": "old-name", "new_name": "new-name"}),
        )
        .await;
    assert!(h.fake.agent("old-name").is_some() && h.fake.agent("new-name").is_some());
    eventually("acked", || {
        delivered(&h.fake, &delivery).as_deref() == Some("acked")
    })
    .await;
    h.stop().await;
}

#[tokio::test]
async fn parameters_that_clear_something_must_be_given() {
    let h = Harness::start(|_| {}).await;
    let mut client = h.client().await;
    h.register(&mut client, "codex", CODEX, Some("codex-api"))
        .await;
    let (kind, _) = client
        .error("agents.reply_setting", json!({"name": "codex-api"}))
        .await;
    assert_eq!(kind, "invalid_params");
    client
        .ok(
            "agents.reply_setting",
            json!({"name": "codex-api", "enabled": null}),
        )
        .await;
    h.stop().await;
}

#[tokio::test]
async fn a_failed_webhook_leaves_no_channel_behind() {
    let h = Harness::start(|_| {}).await;
    let mut client = h.client().await;
    h.register(&mut client, "codex", CODEX, Some("codex-api"))
        .await;
    h.fake.set_failing(&["POST /v1/webhooks"]);
    let (kind, _) = client
        .error("agents.webhook.create", json!({"name": "codex-api"}))
        .await;
    assert_eq!(kind, "relaycast_unreachable");
    assert!(
        h.fake.channels().iter().all(|c| !c.starts_with("hook-")),
        "{:?}",
        h.fake.channels()
    );
    assert!(h.store()["registrations"][0].get("webhook").is_none());
    h.stop().await;
}

#[tokio::test]
async fn a_webhook_channel_that_did_not_read_back_is_removed() {
    let h = Harness::start(|_| {}).await;
    let mut client = h.client().await;
    h.register(&mut client, "codex", CODEX, Some("codex-api"))
        .await;
    // Created and joined, then the readback fails.
    h.fake.set_failing(&["GET /v1/channels/hook-*"]);
    let (kind, _) = client
        .error("agents.webhook.create", json!({"name": "codex-api"}))
        .await;
    assert_eq!(kind, "relaycast_unreachable");
    assert!(
        h.fake.channels().iter().all(|c| !c.starts_with("hook-")),
        "{:?}",
        h.fake.channels()
    );
    assert!(h.store()["registrations"][0].get("webhook").is_none());
    h.stop().await;
}

#[tokio::test]
async fn a_webhook_created_while_the_queue_is_read_routes_its_posts() {
    let h = Harness::start(|_| {}).await;
    let mut client = h.client().await;
    h.register(&mut client, "codex", CODEX, Some("codex-api"))
        .await;
    let release = h.fake.hold("GET /v1/deliveries");
    h.core.request_drain("codex-api");
    eventually("a queue read in flight", || {
        h.fake.held("GET /v1/deliveries") > 0
    })
    .await;

    client
        .ok("agents.webhook.create", json!({"name": "codex-api"}))
        .await;
    let channel_id = h.store()["registrations"][0]["webhook"]["channelID"]
        .as_str()
        .unwrap()
        .to_string();
    h.fake.seed_agent("__relay_webhook__", "service", json!({}));
    let (delivery, _) = h.fake.queue(
        "codex-api",
        "message",
        Some(&channel_id),
        "__relay_webhook__",
        "Build failed on main",
    );
    let _ = release.send(true);
    eventually("acked", || {
        delivered(&h.fake, &delivery).as_deref() == Some("acked")
    })
    .await;
    let injected = h.injector.injected();
    assert_eq!(injected.len(), 1, "the post reaches the session");
    assert!(
        injected[0]
            .text
            .starts_with("[via Agent Relay — from webhook to @codex-api"),
        "{}",
        injected[0].text
    );
    h.stop().await;
}

#[tokio::test]
async fn a_webhook_for_an_agent_another_process_removed_is_taken_back() {
    let h = Harness::start(|_| {}).await;
    let mut client = h.client().await;
    h.register(&mut client, "codex", CODEX, Some("codex-api"))
        .await;
    // The macOS app removes the agent in the shared store meanwhile.
    let mut store = h.store();
    store["registrations"] = json!([]);
    store["tokens"] = json!({});
    std::fs::write(h.store_path(), store.to_string()).unwrap();
    let (kind, _) = client
        .error("agents.webhook.create", json!({"name": "codex-api"}))
        .await;
    assert_eq!(kind, "not_found");
    assert!(
        h.fake.channels().iter().all(|c| !c.starts_with("hook-")),
        "{:?}",
        h.fake.channels()
    );
    h.stop().await;
}

#[tokio::test]
async fn another_person_signing_in_never_inherits_the_last_identity() {
    let h = Harness::signed_in().await;
    let cloud = h.cloud.clone().unwrap();
    let mut client = h.client().await;
    h.fake.seed_agent("reviewer", "agent", json!({}));
    client
        .ok(
            "messages.send",
            json!({"to": "reviewer", "text": "from the first person"}),
        )
        .await;
    // Someone else signs in to the same workspace.
    let second = h.fake.seed_agent("second-person", "human", json!({}));
    cloud.account.lock().unwrap().as_mut().unwrap().user_id = Some("user-2".into());
    cloud.answer(
        "POST",
        "/workspaces/50587328-441d-4acb-b8f3-dbe1b3c5de99/messaging/identity/credential",
        Ok(
            json!({"identity": {"name": "second-person", "agentId": second.id,
            "token": second.token, "relaycastUrl": h.fake.base_url}}),
        ),
    );
    let history = client
        .ok("messages.history", json!({"endpoint": "reviewer"}))
        .await;
    assert_eq!(history["identity"], "second-person");
    assert_eq!(history["messages"], json!([]));
    let sent = h.fake.calls("POST", "/v1/dm");
    client
        .ok("messages.send", json!({"to": "reviewer", "text": "mine"}))
        .await;
    let last = h.fake.calls("POST", "/v1/dm").pop().unwrap();
    assert_eq!(sent.len() + 1, h.fake.calls("POST", "/v1/dm").len());
    assert_eq!(
        last.authorization.as_deref(),
        Some(format!("Bearer {}", second.token).as_str())
    );
    h.stop().await;
}

#[tokio::test]
async fn an_answer_owed_before_a_rename_goes_out_as_the_new_name() {
    let h = Harness::start(|_| {}).await;
    let mut client = h.client().await;
    h.register(&mut client, "codex", CODEX, Some("old-name"))
        .await;
    h.fake.seed_agent("alice", "agent", json!({}));
    let (delivery, message) = h.fake.send_dm("alice", "old-name", "What failed?");
    eventually("acked", || {
        delivered(&h.fake, &delivery).as_deref() == Some("acked")
    })
    .await;
    assert_eq!(h.store()["replies"][0]["claimed"], Value::Null);
    client
        .ok(
            "agents.rename",
            json!({"name": "old-name", "new_name": "new-name"}),
        )
        .await;
    let original = h.fake.agent("old-name").unwrap();
    let renamed = h.fake.agent("new-name").unwrap();
    // Owed by the same session, and sent under its one current name.
    assert_eq!(h.store()["replies"][0]["agentID"], original.id);
    let reference = agent_relay_probe::relay::delivery::policy::MessageRef::of(&message);
    h.injector
        .answers
        .lock()
        .unwrap()
        .insert(reference, "The lint step failed.".into());
    let replies = format!("/v1/messages/{message}/replies");
    eventually("answered", || !h.fake.calls("POST", &replies).is_empty()).await;
    let reply = &h.fake.calls("POST", &replies)[0];
    assert_eq!(
        reply.authorization.as_deref(),
        Some(format!("Bearer {}", renamed.token).as_str())
    );
    h.stop().await;
}

#[tokio::test]
async fn an_already_registered_managed_session_is_answered_only_under_its_live_authority() {
    let h = Harness::signed_in().await;
    let id = "ses_managed01";
    let target = Target::new(SessionKind::OpenCode, id);
    h.sessions
        .0
        .lock()
        .unwrap()
        .push(session(SessionKind::OpenCode, id, "/Users/me/Projects/api"));
    let authority = ManagedAuthority {
        workspace_id: "rw_fake".into(),
        owner_id: "user-1".into(),
        owner_uid: agent_relay_probe::relay::peer::current_uid(),
    };
    let bind = |authority: Option<ManagedAuthority>| {
        *h.sessions.4.lock().unwrap() = authority
            .map(|authority| vec![(target.clone(), authority)])
            .unwrap_or_default();
    };
    bind(Some(authority.clone()));
    let mut client = h.client().await;
    let registered = h
        .register(&mut client, "opencode", id, Some("open-api"))
        .await;
    assert_eq!(registered["already_registered"], false);

    // The binding no longer proves this workspace and owner: the stored
    // registration is not handed back.
    for changed in [
        None,
        Some(ManagedAuthority {
            workspace_id: "rw_other".into(),
            ..authority.clone()
        }),
    ] {
        bind(changed);
        let (kind, message) = client
            .error(
                "agents.register",
                json!({"target": {"kind": "opencode", "id": id}}),
            )
            .await;
        assert_eq!(kind, "refused");
        assert_eq!(
            message,
            "This managed session is not bound to the current workspace and owner."
        );
    }

    bind(Some(authority));
    let again = h
        .register(&mut client, "opencode", id, Some("another-name"))
        .await;
    assert_eq!(again["already_registered"], true);
    assert_eq!(again["name"], "open-api");
    h.stop().await;
}

// Scale production intervals together so these tests exercise the request
// budget, not a separately invented test polling policy.
fn scaled_production_delivery_timing() -> DeliveryTiming {
    let timing = DeliveryTiming::default();
    DeliveryTiming {
        safety_poll: timing.safety_poll / 100,
        fast_poll: timing.fast_poll / 100,
        heartbeat: timing.heartbeat / 100,
        ..timing
    }
}

#[tokio::test]
async fn idle_push_connections_keep_presence_without_repeated_queue_reads() {
    let h =
        Harness::start_with_timing(|_| None, |_, _| {}, scaled_production_delivery_timing()).await;
    let mut client = h.client().await;
    h.register(&mut client, "codex", CODEX, Some("quiet")).await;
    eventually("push live and initial catch-up", || {
        h.core.status().push.get("quiet") == Some(&agent_relay_probe::relay::push::PushState::Live)
            && !h.fake.calls("GET", "/v1/deliveries").is_empty()
    })
    .await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    let reads = h.fake.calls("GET", "/v1/deliveries").len();
    let beats = h.fake.calls("POST", "/v1/agents/heartbeat").len();
    // A server other than hosted Relaycast keeps the 30 s fallback (scaled to
    // 300 ms) while it does not confirm socket presence.
    tokio::time::sleep(Duration::from_millis(750)).await;
    assert_eq!(
        h.fake.calls("GET", "/v1/deliveries").len(),
        reads,
        "live push must not keep reading an empty queue"
    );
    assert!(
        h.fake.calls("POST", "/v1/agents/heartbeat").len() >= beats + 2,
        "presence cannot wait for the longer safety poll"
    );

    // Deliver over the actual socket while the safety poll is still far away.
    let (delivery, message) = h.fake.queue("quiet", "dm", None, "bob", "pushed now");
    h.fake.push(json!({"type": "deliver", "delivery_id": delivery, "msg_id": message,
        "payload": {"type": "dm.received", "data": {"message": {"id": message, "agent_name": "bob", "text": "pushed now"}}}}));
    tokio::time::timeout(Duration::from_millis(500), async {
        eventually("push acknowledged before the safety poll", || {
            delivered(&h.fake, &delivery).as_deref() == Some("acked")
        })
        .await;
    })
    .await
    .unwrap();
    assert_eq!(h.fake.calls("GET", "/v1/deliveries").len(), reads);

    // A missed push is still recovered by the sparse safety-net read.
    let (missed, _) = h.fake.queue("quiet", "dm", None, "bob", "missed push");
    tokio::time::timeout(Duration::from_secs(4), async {
        eventually("safety net recovers a missed push", || {
            delivered(&h.fake, &missed).as_deref() == Some("acked")
        })
        .await;
    })
    .await
    .unwrap();
    h.stop().await;
}

#[tokio::test]
async fn empty_fallback_queues_back_off_and_queue_reads_refresh_presence() {
    let mut release = None;
    let h = Harness::start_with_timing(
        |_| None,
        |_, fake| {
            release = Some(fake.hold("POST /v1/agent/node-token"));
        },
        scaled_production_delivery_timing(),
    )
    .await;
    let mut client = h.client().await;
    h.register(&mut client, "codex", CODEX, Some("quiet")).await;
    eventually("initial fallback read", || {
        !h.fake.calls("GET", "/v1/deliveries").is_empty()
    })
    .await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    let reads = h.fake.calls("GET", "/v1/deliveries").len();
    let beats = h.fake.calls("POST", "/v1/agents/heartbeat").len();
    tokio::time::sleep(Duration::from_millis(650)).await;
    let additional = h.fake.calls("GET", "/v1/deliveries").len() - reads;
    assert!((3..=6).contains(&additional), "empty fallback queue made {additional} reads; expected bounded catch-up, not 3-second polling forever");
    assert_eq!(
        h.fake.calls("POST", "/v1/agents/heartbeat").len(),
        beats,
        "successful queue reads already refreshed server presence"
    );
    let (delivery, _) = h
        .fake
        .queue("quiet", "dm", None, "bob", "fallback still works");
    tokio::time::timeout(Duration::from_millis(500), async {
        eventually("fallback delivery", || {
            delivered(&h.fake, &delivery).as_deref() == Some("acked")
        })
        .await;
    })
    .await
    .unwrap();
    let reads_after_message = h.fake.calls("GET", "/v1/deliveries").len();
    tokio::time::timeout(Duration::from_millis(120), async {
        eventually("nonempty queue resets the fast cadence", || {
            h.fake.calls("GET", "/v1/deliveries").len() > reads_after_message
        })
        .await;
    })
    .await
    .unwrap();

    // Failure must not be credited as presence: resume separate heartbeats.
    h.fake
        .set_api_error("GET /v1/deliveries", Some((400, "test_read_refused")));
    let beats = h.fake.calls("POST", "/v1/agents/heartbeat").len();
    tokio::time::sleep(Duration::from_millis(650)).await;
    assert!(h.fake.calls("POST", "/v1/agents/heartbeat").len() > beats);
    release.unwrap().send(true).unwrap();
    h.stop().await;
}

#[tokio::test]
async fn websocket_presence_eliminates_idle_rest_heartbeats_and_falls_back_when_acks_stop() {
    let h = Harness::start_with_timing(
        |_| None,
        |_, fake| fake.acknowledge_presence(true),
        scaled_production_delivery_timing(),
    )
    .await;
    let mut client = h.client().await;
    h.register(&mut client, "codex", CODEX, Some("quiet")).await;
    eventually("several presence heartbeats", || {
        h.fake
            .frames()
            .iter()
            .filter(|f| f["type"] == "node.heartbeat")
            .count()
            >= 4
    })
    .await;
    let reads = h.fake.calls("GET", "/v1/deliveries").len();
    let beats = h.fake.calls("POST", "/v1/agents/heartbeat").len();
    tokio::time::sleep(Duration::from_millis(800)).await;
    assert_eq!(h.fake.calls("GET", "/v1/deliveries").len(), reads);
    assert_eq!(
        h.fake.calls("POST", "/v1/agents/heartbeat").len(),
        beats,
        "acknowledged socket presence replaces REST heartbeats"
    );

    // A still-open socket whose acknowledgements stop must not imply presence.
    h.fake.acknowledge_presence(false);
    eventually("REST fallback on lost acknowledgements", || {
        h.fake.calls("POST", "/v1/agents/heartbeat").len() > beats
    })
    .await;
    h.fake.acknowledge_presence(true);
    tokio::time::sleep(Duration::from_millis(150)).await;
    let recovered = h.fake.calls("POST", "/v1/agents/heartbeat").len();
    tokio::time::sleep(Duration::from_millis(650)).await;
    assert_eq!(
        h.fake.calls("POST", "/v1/agents/heartbeat").len(),
        recovered
    );
    h.stop().await;
}

#[tokio::test]
async fn warm_session_reads_do_not_repeat_live_discovery() {
    let harness = Harness::start(|_| {}).await;
    let mut client = harness.client().await;
    let first = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let first = client.ok("sessions.list", json!({})).await;
            if !first["sessions"].as_array().unwrap().is_empty() {
                break first;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    *harness.sessions.5.lock().unwrap() = Duration::from_millis(500);
    for _ in 0..3 {
        let result = tokio::time::timeout(
            Duration::from_millis(100),
            client.ok("sessions.list", json!({})),
        )
        .await;
        assert!(
            result.is_ok(),
            "a warm listing must read the shared snapshot"
        );
        assert_eq!(result.unwrap()["sessions"], first["sessions"]);
    }
    harness.stop().await;
}

#[tokio::test]
async fn registration_plan_quota_keeps_the_actionable_reason_and_can_recover() {
    let h = Harness::start(|_| {}).await;
    let mut client = h.client().await;
    h.fake
        .set_api_error("POST /v1/agents", Some((429, "plan_limit_exceeded")));
    let params = json!({"target": {"kind": "codex", "id": CODEX}, "name": "quota-test"});
    let response = client.call("agents.register", params.clone()).await;
    assert_eq!(response["error"]["data"]["kind"], "relaycast_refused");
    assert_eq!(response["error"]["data"]["retryable"], false);
    assert_eq!(response["error"]["message"], "Could not register @quota-test on Agent Relay. This Agent Relay workspace has reached its plan limit. Upgrade its plan or wait for the quota to reset, then try again.");
    assert!(h.store()["registrations"].as_array().unwrap().is_empty());
    assert!(h.fake.agent("quota-test").is_none());
    h.fake.set_api_error("POST /v1/agents", None);
    client.ok("agents.register", params).await;
    assert_eq!(h.store()["registrations"][0]["name"], "quota-test");
    h.stop().await;
}

#[tokio::test]
async fn rename_plan_quota_preserves_the_existing_registration() {
    let h = Harness::start(|_| {}).await;
    let mut client = h.client().await;
    h.register(&mut client, "codex", CODEX, Some("old-name"))
        .await;
    h.fake
        .set_api_error("POST /v1/agents", Some((429, "plan_limit_exceeded")));
    let response = client
        .call(
            "agents.rename",
            json!({"name": "old-name", "new_name": "new-name"}),
        )
        .await;
    assert_eq!(response["error"]["data"]["retryable"], false);
    assert!(response["error"]["message"]
        .as_str()
        .unwrap()
        .contains("Upgrade its plan"));
    assert_eq!(h.store()["registrations"][0]["name"], "old-name");
    assert!(h.store()["registrations"][0].get("alias").is_none());
    assert!(h.fake.agent("old-name").is_some());
    assert!(h.fake.agent("new-name").is_none());
    h.stop().await;
}

#[tokio::test]
async fn usage_records_new_and_existing_agents_and_sent_messages() {
    let usage = Arc::new(UsageRecorder::default());
    let h = Harness::start_with_usage(
        |fake| Some(signed_in(fake)),
        |_, _| {},
        DeliveryTiming::default(),
        Some(usage.clone()),
    )
    .await;
    let mut client = h.client().await;
    h.register(&mut client, "codex", CODEX, Some("usage-agent"))
        .await;
    h.register(&mut client, "codex", CODEX, Some("usage-agent"))
        .await;
    client
        .ok(
            "messages.send",
            json!({"to":"usage-agent", "text":"private message body"}),
        )
        .await;
    eventually("message usage delivered", || {
        usage.0.lock().unwrap().iter().any(|e| {
            e["properties"]["operation"] == "message_send"
                && e["properties"]["outcome"] == "succeeded"
        })
    })
    .await;
    let events = usage.0.lock().unwrap().clone();
    let registrations: Vec<_> = events
        .iter()
        .filter(|e| {
            e["event"] == "desktop_operation"
                && e["properties"]["operation"] == "agent_register"
                && e["properties"]["outcome"] == "succeeded"
        })
        .collect();
    assert_eq!(registrations.len(), 2, "{events:?}");
    assert_eq!(registrations[0]["properties"]["already_registered"], false);
    assert_eq!(registrations[1]["properties"]["already_registered"], true);
    assert!(events
        .iter()
        .any(|e| e["properties"]["operation"] == "message_send"
            && e["properties"]["outcome"] == "succeeded"
            && e["properties"]["is_reply"] == false));
    let encoded = serde_json::to_string(&events).unwrap();
    for forbidden in ["usage-agent", CODEX, "private message body"] {
        assert!(!encoded.contains(forbidden));
    }
    h.stop().await;
}

#[tokio::test]
async fn removing_a_spawned_agent_saves_its_spawn_receipt_first() {
    let h = Harness::seeded(|home, relaycast| {
        let data = home.join("app-data");
        std::fs::create_dir_all(&data).unwrap();
        // Kept after a restart: the registration is its invocation's only
        // record, with no receipt yet.
        std::fs::write(
            data.join("injectable-agents.json"),
            json!({
                "registrations": [{"name": "spawned-w1", "agentID": "agent_w1",
                    "target": {"kind": "codex", "id": CODEX}, "title": "Fix CI",
                    "baseURL": relaycast, "registeredAt": "2026-10-15T00:00:00Z",
                    "workspaceKey": WORKSPACE_KEY, "machinePrefix": "test-desk",
                    "spawn": {"nodeID": "node_desktop_1", "nodeName": "test-desk-desktop",
                        "invocationID": "inv_spawned_w1", "harness": "codex",
                        "taskUnconfirmed": "interrupted"}}],
                "tokens": {"spawned-w1": "at_live_w1"},
                "acceptSpawns": false,
            })
            .to_string(),
        )
        .unwrap();
    })
    .await;
    h.fake.seed_agent("spawned-w1", "agent", json!({}));
    let mut client = h.client().await;
    client
        .ok("agents.unregister", json!({"name": "spawned-w1"}))
        .await;
    assert!(h.store()["registrations"].as_array().unwrap().is_empty());
    let receipts: Vec<String> = std::fs::read_dir(h.home.join("app-data/spawn-completions"))
        .unwrap()
        .map(|entry| std::fs::read_to_string(entry.unwrap().path()).unwrap())
        .collect();
    assert_eq!(receipts.len(), 1);
    let receipt: Value = serde_json::from_str(&receipts[0]).unwrap();
    assert_eq!(receipt["invocation_id"], "inv_spawned_w1");
    assert_eq!(receipt["output"]["name"], "spawned-w1");
    assert_eq!(receipt["output"]["warning"]["verification"], "interrupted");
    assert!(!receipts[0].contains(WORKSPACE_KEY));
    h.stop().await;
}

#[path = "cases/pi_channel.rs"]
mod pi_channel;

#[path = "cases/spawner_native_input.rs"]
mod spawner_native_input;

#[path = "cases/spawner_final_answer.rs"]
mod spawner_final_answer;

#[tokio::test]
async fn an_agent_can_keep_messaging_a_session_with_no_person_in_between() {
    let h = Harness::start(|_| {}).await;
    let mut client = h.client().await;
    h.register(&mut client, "codex", CODEX, Some("codex-api"))
        .await;
    h.fake.seed_agent("alice", "agent", json!({}));
    let mut last = String::new();
    for n in 0..25 {
        let (delivery, message) = h.fake.send_dm("alice", "codex-api", &format!("turn {n}"));
        eventually("acked", || {
            delivered(&h.fake, &delivery).as_deref() == Some("acked")
        })
        .await;
        last = message;
    }
    assert_eq!(h.injector.injected().len(), 25);

    // The automatic answer to the 25th turn is still sent.
    let reference = agent_relay_probe::relay::delivery::policy::MessageRef::of(&last);
    h.injector
        .answers
        .lock()
        .unwrap()
        .insert(reference, "Done.".into());
    eventually("the answer sent", || {
        !h.fake
            .calls("POST", &format!("/v1/messages/{last}/replies"))
            .is_empty()
    })
    .await;
    h.stop().await;
}
