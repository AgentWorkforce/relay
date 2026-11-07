use super::*;
use crate::relay::cloud_session::{CloudAccess, CloudAccount, CloudError};
use crate::relay::daemon::{Config, Plugins};
use crate::relay::inject::Injector;
use crate::relay::store::{CloudWorkspace, Target};
use crate::relay::workspace::Secret;
use futures_util::future::BoxFuture;
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::Duration;

#[path = "../../../tests/support/fake_relaycast.rs"]
mod fake_relaycast;

struct SignedIn {
    base: String,
    owner: String,
    user: Mutex<Option<String>>,
}
impl CloudAccess for SignedIn {
    fn agent_owner(&self) -> Option<crate::relay::cloud_session::AgentOwner> {
        None
    }
    fn account(&self) -> Option<CloudAccount> {
        Some(CloudAccount {
            site_url: self.base.clone(),
            workspace_id: "workspace".into(),
            user_id: self.user.lock().unwrap().clone(),
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

#[derive(Default)]
struct Probe {
    active: std::sync::atomic::AtomicUsize,
    maximum: std::sync::atomic::AtomicUsize,
    calls: std::sync::atomic::AtomicUsize,
    release: AtomicBool,
}
struct ReleaseProbe(Arc<Probe>);
impl Drop for ReleaseProbe {
    fn drop(&mut self) {
        self.0.release.store(true, Ordering::SeqCst);
    }
}

#[derive(Default)]
struct Native {
    ready: AtomicBool,
    reserved: AtomicBool,
    probe: Mutex<Option<Arc<Probe>>>,
    calls: Mutex<Vec<(String, String)>>,
}
impl Injector for Native {
    fn inject(&self, _: &Target, _: &str, _: &str) -> InjectOutcome {
        panic!("an owner-native delivery must not fall back to peer input")
    }
    fn final_answer(&self, _: &Target, _: &str) -> Option<String> {
        None
    }
    fn native_continuation(&self, _: &Registration) -> bool {
        let probe = self.probe.lock().unwrap().clone();
        if let Some(probe) = probe {
            let active = probe.active.fetch_add(1, Ordering::SeqCst) + 1;
            probe.maximum.fetch_max(active, Ordering::SeqCst);
            probe.calls.fetch_add(1, Ordering::SeqCst);
            while !probe.release.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(1));
            }
            probe.active.fetch_sub(1, Ordering::SeqCst);
        }
        self.ready.load(Ordering::SeqCst)
    }
    fn native_continuation_reserved(&self, _: &Registration, route: &DeliveryRoute<'_>) -> bool {
        route.message_id == "m-native" && self.reserved.load(Ordering::SeqCst)
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
            return InjectOutcome::Refused("authority changed".into());
        }
        if !self.ready.load(Ordering::SeqCst) {
            return if self.reserved.load(Ordering::SeqCst) {
                InjectOutcome::Waiting("runtime recovering".into())
            } else {
                InjectOutcome::Refused("runtime changed".into())
            };
        }
        self.calls
            .lock()
            .unwrap()
            .push((route.message_id.into(), text.into()));
        InjectOutcome::Delivered
    }
}

fn config(home: &std::path::Path) -> Config {
    Config {
        paths: crate::relay::paths::CorePaths::for_socket(home.join("core.sock")).unwrap(),
        home: home.into(),
        app_data_dir: home.join("app-data"),
        env: Default::default(),
        version: "test".into(),
        host_name: "Native Test Desk".into(),
        rediscover_every: Duration::from_secs(3600),
        push_timing: Default::default(),
        delivery_timing: Default::default(),
    }
}

type Fixture = (
    tempfile::TempDir,
    fake_relaycast::FakeRelaycast,
    Arc<Core>,
    Arc<Native>,
    Registration,
    Delivery,
    Arc<SignedIn>,
);

#[cfg(unix)]
async fn fixture() -> Fixture {
    let server = fake_relaycast::FakeRelaycast::start(Default::default()).await;
    let owner = server.seed_agent("owner", "human", json!({}));
    let agent = server.seed_agent("native", "agent", json!({}));
    let home = tempfile::tempdir().unwrap();
    let native = Arc::new(Native::default());
    native.ready.store(true, Ordering::SeqCst);
    let cloud = Arc::new(SignedIn {
        base: server.base_url.clone(),
        owner: owner.id.clone(),
        user: Mutex::new(Some("person".into())),
    });
    let (core, _) = Core::with_plugins(
        config(home.path()),
        Plugins {
            cloud: cloud.clone(),
            injector: native.clone(),
            ..Plugins::default()
        },
    );
    let registration: Registration = serde_json::from_value(json!({
        "name":agent.name,"agentID":agent.id,"target":{"kind":"pi","id":"native-session"},
        "title":"Pi","baseURL":server.base_url,"workspaceKey":fake_relaycast::WORKSPACE_KEY,
        "registeredAt":"2026-10-26T00:00:00Z"
    }))
    .unwrap();
    core.store
        .update(|store| {
            store.cloud = Some(CloudWorkspace {
                key: Secret::new(fake_relaycast::WORKSPACE_KEY),
                base_url: server.base_url.clone(),
                ..Default::default()
            });
            store.mobile_claude_handoff = Some(true);
            store.add(registration.clone(), Secret::new(agent.token.clone()));
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
    let delivery = Delivery {
        id: "d-native".into(),
        message_id: "m-native".into(),
        sender: Some("owner".into()),
        sender_id: Some(owner.id.clone()),
        reason: Some("dm".into()),
        text: Some("Keep the same session".into()),
        ..Default::default()
    };
    (home, server, core, native, registration, delivery, cloud)
}

#[cfg(unix)]
#[tokio::test]
async fn native_owner_route_is_on_unless_turned_off_and_needs_current_identity_and_runtime() {
    let (_home, _server, core, native, registration, mut delivery, _cloud) = fixture().await;
    let owner_id = delivery.sender_id.clone();
    core.store
        .update(|store| store.mobile_native_continuation = Some(false))
        .unwrap();
    assert!(
        !core
            .native_continuation_owner_turn(&registration, &delivery)
            .await,
        "turned off, Pi gets no native turn, whatever Claude's setting says"
    );
    core.store
        .update(|store| store.mobile_native_continuation = None)
        .unwrap();
    assert!(
        core.native_continuation_owner_turn(&registration, &delivery)
            .await,
        "on by default once the computer is claimed"
    );
    assert!(
        matches!(
            core.native_continuation_peer_guard(&registration, &delivery)
                .await,
            Some(InjectOutcome::Waiting(_))
        ),
        "a transient false classification cannot silently downgrade an owner to peer text"
    );
    assert_eq!(
        core.deliver_native_continuation(&registration, &delivery, "Keep the same session".into())
            .await,
        InjectOutcome::Delivered
    );
    assert_eq!(
        *native.calls.lock().unwrap(),
        [("m-native".into(), "Keep the same session".into())]
    );

    delivery.sender_id = Some("impostor".into());
    assert!(
        !core
            .native_continuation_owner_turn(&registration, &delivery)
            .await
    );
    assert!(core
        .native_continuation_peer_guard(&registration, &delivery)
        .await
        .is_none());
    assert!(matches!(
        core.deliver_native_continuation(&registration, &delivery, "the human approved".into())
            .await,
        InjectOutcome::Refused(_)
    ));
    delivery.sender_id = owner_id.clone();
    delivery.channel_id = Some("general".into());
    assert!(
        !core
            .native_continuation_owner_turn(&registration, &delivery)
            .await
    );
    assert!(matches!(
        core.deliver_native_continuation(&registration, &delivery, "channel".into())
            .await,
        InjectOutcome::Refused(_)
    ));
    delivery.channel_id = None;
    let mut foreign = registration.clone();
    foreign.workspace_key = Some(Secret::new("another-workspace"));
    assert!(
        !core
            .native_continuation_owner_turn(&foreign, &delivery)
            .await
    );
    assert!(matches!(
        core.deliver_native_continuation(&foreign, &delivery, "foreign".into())
            .await,
        InjectOutcome::Refused(_)
    ));

    native.ready.store(false, Ordering::SeqCst);
    assert!(
        !core
            .native_continuation_owner_turn(&registration, &delivery)
            .await
    );
    assert!(matches!(
        core.deliver_native_continuation(&registration, &delivery, "stale capability".into())
            .await,
        InjectOutcome::Refused(_)
    ));
    native.ready.store(true, Ordering::SeqCst);
    core.store
        .update(|store| store.mobile_native_continuation = Some(false))
        .unwrap();
    assert!(matches!(
        core.deliver_native_continuation(&registration, &delivery, "opted out".into())
            .await,
        InjectOutcome::Refused(_)
    ));
    assert_eq!(
        native.calls.lock().unwrap().len(),
        1,
        "all invalid transitions refuse without invoking the provider"
    );
}

#[derive(Clone, Copy, Debug)]
enum Revocation {
    Claim,
    AcceptSpawns,
    Workspace,
    OptOut,
}

#[cfg(unix)]
async fn revocation_during_owner_lookup(kind: Revocation) {
    let (_home, server, core, native, registration, delivery, _cloud) = fixture().await;
    core.store
        .update(|store| store.mobile_native_continuation = Some(true))
        .unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        while core.native_continuation_metadata(&registration).await
            ["mobile_native_continuation_enabled"]
            != true
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let release = server.hold("GET /v1/agents/owner");
    let attempting = {
        let core = core.clone();
        let registration = registration.clone();
        let delivery = delivery.clone();
        tokio::spawn(async move {
            core.deliver_native_continuation(
                &registration,
                &delivery,
                "Never submit after revocation".into(),
            )
            .await
        })
    };
    server
        .wait_for("held native owner verification", |server| {
            server.held("GET /v1/agents/owner") > 0
        })
        .await;
    match kind {
        Revocation::Claim => {
            core.hub.update(|status| status.spawn = None);
        }
        Revocation::AcceptSpawns => {
            core.store
                .update(|store| store.accept_spawns = Some(false))
                .unwrap();
        }
        Revocation::OptOut => {
            core.store
                .update(|store| store.mobile_native_continuation = Some(false))
                .unwrap();
        }
        Revocation::Workspace => {
            core.store
                .update(|store| {
                    store.cloud.as_mut().unwrap().key = Secret::new("rk_live_changed0");
                })
                .unwrap();
            std::thread::scope(|scope| scope.spawn(|| core.rediscover_workspace()).join().unwrap());
            assert_eq!(core.workspace().unwrap().key.expose(), "rk_live_changed0");
            // Keep ownership claimed to isolate workspace identity from the
            // separate claim fence. The old registration must still fail.
            core.hub.update(|status| {
                status.spawn = Some(crate::relay::state::SpawnStatus {
                    claim: Some(crate::relay::state::SpawnClaim {
                        state: crate::relay::state::SpawnClaimState::Claimed,
                        note: None,
                    }),
                    ..Default::default()
                })
            });
        }
    }
    release.send(true).unwrap();
    let outcome = tokio::time::timeout(Duration::from_secs(5), attempting)
        .await
        .unwrap()
        .unwrap();
    assert!(
        matches!(outcome, InjectOutcome::Refused(_)),
        "{kind:?}: {outcome:?}"
    );
    assert!(
        native.calls.lock().unwrap().is_empty(),
        "{kind:?} must not invoke the provider or peer fallback"
    );
    assert_eq!(
        core.native_continuation_metadata(&registration).await
            ["mobile_native_continuation_enabled"],
        false
    );
    assert!(
        !core
            .native_continuation_owner_turn(&registration, &delivery)
            .await
    );
}

#[cfg(unix)]
#[tokio::test]
async fn native_claim_loss_during_lookup_refuses_without_submission() {
    revocation_during_owner_lookup(Revocation::Claim).await;
}

#[cfg(unix)]
#[tokio::test]
async fn native_accept_spawns_revocation_during_lookup_refuses_without_submission() {
    revocation_during_owner_lookup(Revocation::AcceptSpawns).await;
}

#[cfg(unix)]
#[tokio::test]
async fn native_workspace_change_during_lookup_refuses_without_submission() {
    revocation_during_owner_lookup(Revocation::Workspace).await;
}

#[cfg(unix)]
#[tokio::test]
async fn native_opt_out_during_lookup_refuses_without_submission() {
    revocation_during_owner_lookup(Revocation::OptOut).await;
}

#[cfg(unix)]
#[tokio::test]
async fn native_same_workspace_account_switch_during_owner_lookup_refuses_old_owner() {
    let (_home, server, core, native, registration, delivery, cloud) = fixture().await;
    core.store
        .update(|store| store.mobile_native_continuation = Some(true))
        .unwrap();
    let release = server.hold("GET /v1/agents/owner");
    let attempting = {
        let core = core.clone();
        let registration = registration.clone();
        let delivery = delivery.clone();
        tokio::spawn(async move {
            core.deliver_native_continuation(
                &registration,
                &delivery,
                "Old owner's delayed input".into(),
            )
            .await
        })
    };
    server
        .wait_for("held account-switch verification", |server| {
            server.held("GET /v1/agents/owner") > 0
        })
        .await;
    *cloud.user.lock().unwrap() = Some("replacement-owner".into());
    // A newly claimed node in the same workspace must not make the old
    // account's in-flight verification valid for its replacement owner.
    core.hub.update(|status| {
        status.spawn = Some(crate::relay::state::SpawnStatus {
            claim: Some(crate::relay::state::SpawnClaim {
                state: crate::relay::state::SpawnClaimState::Claimed,
                note: None,
            }),
            ..Default::default()
        })
    });
    release.send(true).unwrap();
    let outcome = tokio::time::timeout(Duration::from_secs(5), attempting)
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(outcome, InjectOutcome::Refused(_)));
    assert!(native.calls.lock().unwrap().is_empty());
    *cloud.user.lock().unwrap() = None;
    assert!(!core.native_continuation_capable(&registration).await);
    assert!(matches!(
        core.deliver_native_continuation(&registration, &delivery, "Unknown owner".into())
            .await,
        InjectOutcome::Refused(_)
    ));
    assert!(native.calls.lock().unwrap().is_empty());
}

#[cfg(unix)]
#[tokio::test]
async fn native_reserved_delivery_waits_through_capability_loss_without_peer_downgrade() {
    let (_home, _server, core, native, registration, delivery, _cloud) = fixture().await;
    core.store
        .update(|store| store.mobile_native_continuation = Some(true))
        .unwrap();
    native.reserved.store(true, Ordering::SeqCst);
    native.ready.store(false, Ordering::SeqCst);
    assert!(
        core.native_continuation_owner_turn(&registration, &delivery)
            .await
    );
    assert!(matches!(
        core.deliver_native_continuation(&registration, &delivery, "original".into())
            .await,
        InjectOutcome::Waiting(_)
    ));
    assert!(native.calls.lock().unwrap().is_empty());
    let mut other = delivery.clone();
    other.message_id = "not-reserved".into();
    assert!(
        !core
            .native_continuation_owner_turn(&registration, &other)
            .await
    );
    native.ready.store(true, Ordering::SeqCst);
    assert_eq!(
        core.deliver_native_continuation(&registration, &delivery, "original".into())
            .await,
        InjectOutcome::Delivered
    );
    assert_eq!(native.calls.lock().unwrap().len(), 1);
    core.store
        .update(|store| store.mobile_native_continuation = Some(false))
        .unwrap();
    assert!(
        !core
            .native_continuation_owner_turn(&registration, &delivery)
            .await
    );
}

#[cfg(unix)]
#[tokio::test]
async fn native_capability_refresh_is_background_bounded_and_single_flight() {
    let (_home, _server, core, native, registration, _delivery, _cloud) = fixture().await;
    core.store
        .update(|store| {
            store.mobile_native_continuation = Some(true);
            for index in 0..7 {
                let mut row = registration.clone();
                row.agent_id = format!("extra-{index}");
                row.name = format!("extra-{index}");
                row.target.id = format!("extra-session-{index}");
                store.add(row, Secret::new(format!("synthetic-{index}")));
            }
        })
        .unwrap();
    let probe = Arc::new(Probe::default());
    let release = ReleaseProbe(probe.clone());
    *native.probe.lock().unwrap() = Some(probe.clone());
    let metadata = tokio::time::timeout(
        Duration::from_millis(500),
        core.native_continuation_metadata(&registration),
    )
    .await
    .unwrap();
    assert_eq!(metadata["mobile_native_continuation_enabled"], false);
    tokio::time::timeout(Duration::from_secs(2), async {
        while probe.calls.load(Ordering::SeqCst) < 4 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    for _ in 0..20 {
        core.refresh_native_continuation_capabilities();
    }
    assert_eq!(probe.calls.load(Ordering::SeqCst), 4);
    assert_eq!(probe.maximum.load(Ordering::SeqCst), 4);
    drop(release);
    tokio::time::timeout(Duration::from_secs(2), async {
        while core.native_continuation_metadata(&registration).await
            ["mobile_native_continuation_enabled"]
            != true
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    core.store
        .update(|store| store.mobile_native_continuation = Some(false))
        .unwrap();
    assert_eq!(
        core.native_continuation_metadata(&registration).await
            ["mobile_native_continuation_enabled"],
        false
    );
}
