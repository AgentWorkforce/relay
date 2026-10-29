//! Exercise source classification and dispatch together, without provider processes.
use super::*;
use crate::relay::cloud_session::{AgentOwner, CloudAccess, CloudAccount, CloudError};
use crate::relay::daemon::{Config, Plugins};
use crate::relay::inject::{DeliveryRoute, InjectOutcome, Injector};
use crate::relay::managed_sessions::ManagedAuthority;
use crate::relay::sessions::{DiscoveredSession, SessionDirectory};
use crate::relay::spawn::launch::{
    Launch, LaunchError, Launched, Message, SpawnedProcess, Spawner, Started,
};
use crate::relay::store::{CloudWorkspace, SessionKind, Target};
use futures_util::future::BoxFuture;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[path = "../../../../tests/support/fake_relaycast.rs"]
mod fake_relaycast;

struct SignedIn {
    base: String,
    owner: String,
}
impl CloudAccess for SignedIn {
    fn account(&self) -> Option<CloudAccount> {
        Some(CloudAccount {
            site_url: self.base.clone(),
            workspace_id: "cloud-workspace".into(),
            user_id: Some("person".into()),
        })
    }
    fn agent_owner(&self) -> Option<AgentOwner> {
        Some(AgentOwner {
            user_id: "person".into(),
            workspace_id: Some("cloud-workspace".into()),
        })
    }
    fn request(
        &self,
        _: &'static str,
        path: String,
        _: Option<Value>,
    ) -> BoxFuture<'_, Result<Value, CloudError>> {
        Box::pin(async move {
            Ok(if path.ends_with("/messaging/identity/credential") {
                json!({"identity":{"name":"owner","agentId":self.owner,"token":"at_owner","relaycastUrl":self.base}})
            } else {
                Value::Null
            })
        })
    }
}

struct Managed;
impl SessionDirectory for Managed {
    fn sessions(&self) -> Vec<DiscoveredSession> {
        vec![]
    }
    fn managed_authority(&self, target: &Target) -> Option<ManagedAuthority> {
        (target.kind == SessionKind::OpenCode).then(|| ManagedAuthority {
            workspace_id: "rw_source".into(),
            owner_id: "person".into(),
            owner_uid: crate::relay::peer::current_uid(),
        })
    }
}

#[derive(Default)]
struct Routes {
    owner: Mutex<Vec<String>>,
    requester: Mutex<Vec<String>>,
    peer: Mutex<Vec<String>>,
}
impl Injector for Routes {
    fn inject(&self, _: &Target, _: &str, text: &str) -> InjectOutcome {
        self.peer.lock().unwrap().push(text.into());
        InjectOutcome::Delivered
    }
    fn final_answer(&self, _: &Target, _: &str) -> Option<String> {
        None
    }
    fn native_continuation(&self, _: &Registration) -> bool {
        true
    }
    fn inject_native(
        &self,
        _: &Registration,
        route: &DeliveryRoute<'_>,
        text: &str,
        admit: &(dyn Fn() -> bool + Send + Sync),
    ) -> InjectOutcome {
        assert!(route.native);
        if !admit() {
            return InjectOutcome::Refused("owner authority changed".into());
        }
        self.owner.lock().unwrap().push(text.into());
        InjectOutcome::Delivered
    }
}
impl Spawner for Routes {
    fn available(&self) -> Vec<crate::relay::harness::HarnessId> {
        vec![]
    }
    fn launch(&self, _: &Launch, _: Started) -> Result<Launched, LaunchError> {
        panic!("no process launch")
    }
    fn alive(&self, _: &Target, _: Option<&SpawnedProcess>) -> bool {
        true
    }
    fn stop(&self, _: &Target, _: Option<&SpawnedProcess>) {}
    fn native_input(&self, _: &Target) -> bool {
        true
    }
    fn deliver(&self, _: &Target, message: &Message) -> Option<InjectOutcome> {
        if !message.native {
            return None;
        }
        self.requester.lock().unwrap().push(message.text.into());
        Some(InjectOutcome::Delivered)
    }
}

struct Fixture {
    _home: tempfile::TempDir,
    _server: fake_relaycast::FakeRelaycast,
    core: Arc<Core>,
    routes: Arc<Routes>,
    registration: Registration,
    requester: Delivery,
    owner: Delivery,
}
async fn fixture(kind: SessionKind, mobile: bool) -> Fixture {
    let server = fake_relaycast::FakeRelaycast::start(Default::default()).await;
    let owner = server.seed_agent("owner", "human", json!({}));
    let requester = server.seed_agent("requester", "agent", json!({}));
    let child = server.seed_agent("child", "agent", json!({}));
    let home = tempfile::tempdir().unwrap();
    let routes = Arc::new(Routes::default());
    let config = Config {
        paths: crate::relay::paths::CorePaths::for_socket(home.path().join("core.sock")).unwrap(),
        home: home.path().into(),
        app_data_dir: home.path().join("app-data"),
        env: Default::default(),
        version: "test".into(),
        host_name: "source-test".into(),
        rediscover_every: Duration::from_secs(3600),
        push_timing: Default::default(),
        delivery_timing: Default::default(),
    };
    let (core, _) = Core::with_plugins(
        config,
        Plugins {
            cloud: Arc::new(SignedIn {
                base: server.base_url.clone(),
                owner: owner.id.clone(),
            }),
            sessions: Arc::new(Managed),
            injector: routes.clone(),
            spawner: routes.clone(),
            ..Plugins::default()
        },
    );
    let harness = match kind {
        SessionKind::ClaudeTerminal => "claude",
        SessionKind::Codex => "codex",
        _ => "opencode",
    };
    let mut registration: Registration = serde_json::from_value(json!({
        "name":child.name,"agentID":child.id,"target":{"kind":"opencode","id":"01a16f54-f5f0-7d10-b9d5-bef66e02d007"},
        "title":"Source test", "baseURL":server.base_url,"workspaceKey":fake_relaycast::WORKSPACE_KEY,
        "registeredAt":"2026-10-26T00:00:00Z", "spawn":{"nodeID":"node", "nodeName":"source-test", "invocationID":"source",
            "harness":harness,"requester":{"name":requester.name,"agentID":requester.id}}
    })).unwrap();
    registration.target.kind = kind;
    core.store
        .update(|store| {
            store.cloud = Some(CloudWorkspace {
                key: Secret::new(fake_relaycast::WORKSPACE_KEY),
                base_url: server.base_url.clone(),
                workspace_id: Some("rw_source".into()),
                ..Default::default()
            });
            store.mobile_native_continuation = Some(mobile);
            store.extras.spawn_native_input = Some(true);
            store.add(registration.clone(), Secret::new(child.token.clone()));
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
    let make = |name: &str, id: String| Delivery {
        id: format!("delivery-{name}"),
        message_id: format!("message-{name}"),
        sender: Some(name.into()),
        sender_id: Some(id),
        reason: Some("dm".into()),
        text: Some("Continue the existing task".into()),
        ..Default::default()
    };
    Fixture {
        _home: home,
        _server: server,
        core,
        routes,
        registration,
        requester: make("requester", requester.id),
        owner: make("owner", owner.id),
    }
}

async fn deliver(f: &Fixture, delivery: &Delivery) -> (InputSource, String) {
    let (text, _, source) = f
        .core
        .session_text(&f.registration, (delivery, None), false, false)
        .await;
    assert_eq!(
        f.core
            .deliver_session_text(&f.registration, delivery, text.clone(), source)
            .await,
        InjectOutcome::Delivered
    );
    (source, text)
}

#[tokio::test]
async fn requester_native_source_keeps_spawn_route_for_all_supported_kinds_and_mobile_flags() {
    for kind in [
        SessionKind::OpenCode,
        SessionKind::Codex,
        SessionKind::ClaudeTerminal,
    ] {
        for mobile in [false, true] {
            let f = fixture(kind, mobile).await;
            let (source, text) = deliver(&f, &f.requester).await;
            assert_eq!(source, InputSource::Requester);
            assert!(text.starts_with("[Agent Relay native input — from @requester"));
            assert_eq!(
                crate::relay::delivery::policy::MessageRef::in_text(&text),
                Some(crate::relay::delivery::policy::MessageRef::of(
                    &f.requester.message_id
                ))
            );
            assert_eq!(f.routes.requester.lock().unwrap().len(), 1);
            assert!(f.routes.owner.lock().unwrap().is_empty());
            assert!(f.routes.peer.lock().unwrap().is_empty());
            for reference in ["0123456789abcdef", "cxm-0123456789abcdef"] {
                let mut approval = f.requester.clone();
                approval.text = Some(format!("approve {reference}"));
                assert!(
                    matches!(
                        f.core.owner_reply(&f.registration, &approval).await,
                        OwnerReply::NotOne
                    ),
                    "requester native input never grants human approval authority"
                );
            }
        }
    }
}

#[tokio::test]
async fn managed_opencode_owner_source_requires_separate_mobile_opt_in() {
    for mobile in [false, true] {
        let f = fixture(SessionKind::OpenCode, mobile).await;
        let (source, text) = deliver(&f, &f.owner).await;
        assert_eq!(
            source,
            if mobile {
                InputSource::Owner
            } else {
                InputSource::Peer
            }
        );
        assert_eq!(f.routes.owner.lock().unwrap().len(), usize::from(mobile));
        assert_eq!(f.routes.peer.lock().unwrap().len(), usize::from(!mobile));
        assert!(f.routes.requester.lock().unwrap().is_empty());
        if mobile {
            assert_eq!(text, f.owner.text.clone().unwrap());
        }
    }
}

#[tokio::test]
async fn requester_opt_out_and_different_sender_preserve_peer_source() {
    let f = fixture(SessionKind::OpenCode, true).await;
    f.core
        .store
        .update(|store| store.extras.spawn_native_input = Some(false))
        .unwrap();
    assert_eq!(deliver(&f, &f.requester).await.0, InputSource::Peer);
    f.core
        .store
        .update(|store| store.extras.spawn_native_input = Some(true))
        .unwrap();
    let mut peer = f.requester.clone();
    peer.sender_id = Some("different-agent".into());
    assert_eq!(deliver(&f, &peer).await.0, InputSource::Peer);
    assert_eq!(f.routes.peer.lock().unwrap().len(), 2);
    assert!(f.routes.requester.lock().unwrap().is_empty());
    assert!(f.routes.owner.lock().unwrap().is_empty());
}

#[tokio::test]
async fn requester_uses_native_input_when_the_setting_was_never_set() {
    let f = fixture(SessionKind::Codex, false).await;
    f.core
        .store
        .update(|store| store.extras.spawn_native_input = None)
        .unwrap();
    assert_eq!(deliver(&f, &f.requester).await.0, InputSource::Requester);
    assert_eq!(f.routes.requester.lock().unwrap().len(), 1);
    assert!(f.routes.peer.lock().unwrap().is_empty());
}
