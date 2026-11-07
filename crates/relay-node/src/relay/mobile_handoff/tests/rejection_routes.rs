//! Exercise the authenticated ack and normal delivery routes, rather than
//! relying only on the journal and capability predicates in isolation.
use super::*;
use crate::relay::delivery::session_text::InputSource;
use crate::relay::inject::Injector;
use crate::relay::local::{LocalConfig, LocalSessions};
use crate::relay::process::{FakeProcess, FakeProcesses};
use std::sync::Mutex;

#[derive(Default)]
struct Inbox(Mutex<Vec<String>>);
impl Injector for Inbox {
    fn inject(&self, _: &Target, _: &str, text: &str) -> InjectOutcome {
        self.0.lock().unwrap().push(text.into());
        InjectOutcome::Delivered
    }
    fn final_answer(&self, _: &Target, _: &str) -> Option<String> {
        None
    }
}

struct Fixture {
    _home: tempfile::TempDir,
    _server: fake_relaycast::FakeRelaycast,
    core: Arc<Core>,
    registration: Registration,
    delivery: Delivery,
    inbox: Arc<Inbox>,
}

async fn fixture(sdk: bool) -> Fixture {
    let server = fake_relaycast::FakeRelaycast::start(Default::default()).await;
    let owner = server.seed_agent("owner", "human", json!({}));
    let agent = server.seed_agent("claude-route-test", "agent", json!({}));
    let home = tempfile::tempdir().unwrap();
    let config = fixture_config(home.path());
    let registration: Registration = serde_json::from_value(json!({
        "name":agent.name,"agentID":agent.id,"target":{"kind":"claude-terminal", "id":"00000000-0000-4000-8000-000000000011"},
        "title":"Claude","baseURL":server.base_url,"workspaceKey":fake_relaycast::WORKSPACE_KEY,
        "registeredAt":"2026-10-24T00:00:00Z"
    })).unwrap();
    let sessions: Arc<dyn SessionDirectory> = if sdk {
        let local = LocalConfig::from_env(&|_| None, home.path());
        std::fs::create_dir_all(local.claude.registry()).unwrap();
        std::fs::write(
            local.claude.registry().join("4100.json"),
            json!({
                "sessionId":registration.target.id,"pid":4100,"procStart":100,
                "messagingSocketPath":"/synthetic/claude.sock","kind":"interactive",
                "entrypoint":"sdk-cli","peerProtocol":1
            })
            .to_string(),
        )
        .unwrap();
        let table = Arc::new(FakeProcesses::default());
        table.insert(
            4100,
            FakeProcess {
                uid: local.uid,
                start: 100,
                arguments: vec!["claude".into(), "--input-format=stream-json".into()],
                ..Default::default()
            },
        );
        Arc::new(LocalSessions::new(local, table))
    } else {
        Arc::new(Directory(
            DiscoveredSession {
                target: registration.target.clone(),
                title: "Claude".into(),
                directory: None,
                updated_at_ms: None,
                host: None,
                live: true,
                holder: None,
            },
            Arc::new(Mutex::new(Some(Runtime {
                pid: 4100,
                start: 100,
                idle: true,
            }))),
            Arc::new(std::sync::atomic::AtomicBool::new(true)),
            home.path().join(".claude"),
        ))
    };
    let inbox = Arc::new(Inbox::default());
    let (core, _) = Core::with_plugins(
        config,
        Plugins {
            cloud: Arc::new(SignedIn {
                base: server.base_url.clone(),
                owner: owner.id.clone(),
            }),
            sessions,
            injector: inbox.clone(),
            ..Plugins::default()
        },
    );
    core.store
        .update(|store| {
            store.cloud = Some(CloudWorkspace {
                key: Secret::new(fake_relaycast::WORKSPACE_KEY),
                base_url: server.base_url.clone(),
                ..Default::default()
            });
            store.mobile_claude_handoff = Some(true);
            store.add(registration.clone(), Secret::new(agent.token));
        })
        .unwrap();
    std::thread::scope(|scope| scope.spawn(|| core.rediscover_workspace()).join().unwrap());
    core.hub.update(|status| status.spawn = None);
    core.person_identity(false).await.unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        while core.status().spawn.is_none() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    core.hub.update(|status| {
        status.spawn = Some(crate::relay::state::SpawnStatus {
            claim: Some(crate::relay::state::SpawnClaim {
                state: crate::relay::state::SpawnClaimState::Claimed,
                note: None,
            }),
            ..Default::default()
        })
    });
    core.install_mobile_claude_plugin().unwrap();
    let delivery = Delivery {
        id: "route-delivery".into(),
        message_id: "route-message".into(),
        sender: Some(owner.name),
        sender_id: Some(owner.id),
        reason: Some("dm".into()),
        text: Some("Continue".into()),
        ..Default::default()
    };
    Fixture {
        _home: home,
        _server: server,
        core,
        registration,
        delivery,
        inbox,
    }
}

#[tokio::test]
async fn failed_ack_persists_reason_revokes_provisional_control_and_never_falls_back() {
    let f = fixture(false).await;
    let bridge = Outbound::new(f.core.clone(), Arc::new(NoDirect));
    let uid = crate::relay::peer::current_uid();
    assert!(matches!(
        f.core
            .deliver_mobile_owner(&f.registration, &f.delivery, "Continue")
            .await,
        InjectOutcome::Waiting(_)
    ));
    let poll = request("poll", json!({"version":"2.1.310"}));
    let submit = bridge.handle(4100, uid, &poll).await.unwrap();
    assert_eq!(submit["refusal_codes"], true);
    let binding = f
        .core
        .mobile_handoff_binding(&f.registration)
        .await
        .unwrap();
    let runtime = Runtime {
        pid: 4100,
        start: 100,
        idle: true,
    };
    let token = submit["control_token"].as_str().unwrap();
    assert!(f
        .core
        .mobile_handoff_control_valid(&binding, &runtime, token, false));
    bridge
        .handle(
            4100,
            uid,
            &request(
                "ack",
                json!({
                    "lease_id":submit["lease_id"],"outcome":"failed","refusal":"stopped"
                }),
            ),
        )
        .await
        .unwrap();
    assert!(!f
        .core
        .mobile_handoff_control_valid(&binding, &runtime, token, false));
    let persisted = journal::edit(&f.core.config.app_data_dir, |queue| {
        Ok((
            queue.previous(
                &binding.scope,
                &f.delivery.id,
                true,
                crate::relay::state::now_ms(),
            ),
            queue.notice(&binding.scope),
        ))
    })
    .unwrap();
    assert_eq!(
        persisted,
        (
            Some(journal::Outcome::Refused(Refusal::Stopped)),
            Refusal::Stopped.notice()
        )
    );
    assert_eq!(
        f.core
            .deliver_session_text(
                &f.registration,
                &f.delivery,
                "Continue".into(),
                InputSource::Owner
            )
            .await,
        InjectOutcome::Refused(Refusal::Stopped.notice().into())
    );
    assert!(f.inbox.0.lock().unwrap().is_empty());
    assert_eq!(
        bridge.handle(4100, uid, &poll).await.unwrap(),
        json!({"action":null})
    );
}

#[tokio::test]
async fn sdk_messages_reach_the_inbox_with_mobile_continuation_on_or_off() {
    let f = fixture(true).await;
    for (round, enabled) in [true, false, true].into_iter().enumerate() {
        f.core
            .store
            .update(|store| store.mobile_claude_handoff = Some(enabled))
            .unwrap();
        f.core.refresh_mobile_claude_plugin();
        assert!(!f.core.mobile_handoff_enabled(&f.registration));
        for (index, source) in [InputSource::Peer, InputSource::Owner, InputSource::Teammate]
            .into_iter()
            .enumerate()
        {
            let mut delivery = f.delivery.clone();
            delivery.id = format!("sdk-{round}-{index}");
            assert_eq!(
                f.core
                    .deliver_session_text(&f.registration, &delivery, "SDK inbox".into(), source)
                    .await,
                InjectOutcome::Delivered
            );
        }
    }
    assert_eq!(f.inbox.0.lock().unwrap().len(), 9);
    assert!(
        !f.core
            .config
            .app_data_dir
            .join("mobile-claude-handoff/queue.json")
            .exists()
            || !f.core.mobile_handoff_pending(&f.registration).unwrap()
    );
}
