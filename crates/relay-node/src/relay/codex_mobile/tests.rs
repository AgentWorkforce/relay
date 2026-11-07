use super::*;
use crate::relay::cloud_session::{CloudAccess, CloudError};
use crate::relay::daemon::{Config, Plugins};
use crate::relay::inject::{DeliveryRoute, InjectOutcome, Injector};
use crate::relay::store::{CloudWorkspace, Target};
use crate::relay::workspace::Secret;
use futures_util::future::BoxFuture;
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Mutex,
};
#[path = "../../../tests/support/fake_relaycast.rs"]
mod fake_relaycast;
const THREAD: &str = "01a16f54-f5f0-7d10-b9d5-bef66e02d007";
struct SignedIn {
    base: String,
    owner: String,
    user: Mutex<Option<String>>,
    unavailable: AtomicBool,
    change_account: AtomicBool,
    wrong_origin: AtomicBool,
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
            if self.unavailable.load(Ordering::SeqCst) {
                return Err(CloudError::Unreachable);
            }
            if self.change_account.swap(false, Ordering::SeqCst) {
                *self.user.lock().unwrap() = Some("different-person".into());
            }
            Ok(if path.ends_with("/messaging/identity/credential") {
                json!({"identity":{"name":"owner","agentId":self.owner,"token":"at_owner","relaycastUrl":if self.wrong_origin.load(Ordering::SeqCst) { "http://127.0.0.1:1" } else { &self.base }}})
            } else {
                Value::Null
            })
        })
    }
}

#[derive(Default)]
struct Native {
    ready: AtomicBool,
    accepted: AtomicBool,
    writes: Arc<AtomicUsize>,
    late: Arc<Mutex<Option<Arc<dyn Fn() + Send + Sync>>>>,
}
struct FakeControl {
    scope: provider::Scope,
    request: ApprovalRequest,
    desktop: ApprovalRequest,
    writes: Arc<AtomicUsize>,
    late: Arc<Mutex<Option<Arc<dyn Fn() + Send + Sync>>>>,
}
fn request(turn: &str) -> ApprovalRequest {
    let mut registry =
        crate::relay::codex::follower::Registry::new(THREAD, "window-original").unwrap();
    registry.apply(&json!({"type":"broadcast","method":"thread-stream-state-changed","sourceClientId":"window-original","version":11,
        "params":{"hostId":"local","conversationId":THREAD,"change":{"type":"snapshot","revision":1,"conversationState":{"id":THREAD,"requests":[
            {"id":42,"method":"item/commandExecution/requestApproval","params":{"threadId":THREAD,"turnId":turn,"itemId":"item","command":"cargo test --lib","cwd":"/tmp/project","reason":"SECRET_COMMAND_NOT_FOR_PHONE"}}
        ]}}}})).unwrap();
    registry.pending()[0].clone()
}
impl provider::Control for FakeControl {
    fn scope(&self) -> &provider::Scope {
        &self.scope
    }
    fn poll(&mut self) -> Result<Vec<ApprovalRequest>, crate::relay::codex::follower::Error> {
        Ok(vec![self.request.clone(), self.desktop.clone()])
    }
    fn decide(
        &mut self,
        request: &ApprovalRequest,
        _: Decision,
        admit: &(dyn Fn() -> bool + Send + Sync),
    ) -> DecisionOutcome {
        if let Some(late) = self.late.lock().unwrap().clone() {
            late();
        }
        if request != &self.request || !admit() {
            return DecisionOutcome::Refused;
        }
        self.writes.fetch_add(1, Ordering::SeqCst);
        DecisionOutcome::AcknowledgedUnconfirmed
    }
    fn close(&mut self) {}
}
impl Injector for Native {
    fn inject(&self, _: &Target, _: &str, _: &str) -> InjectOutcome {
        panic!("no peer fallback")
    }
    fn final_answer(&self, _: &Target, _: &str) -> Option<String> {
        None
    }
    fn native_continuation(&self, _: &Registration) -> bool {
        self.ready.load(Ordering::SeqCst)
    }
    fn inject_native(
        &self,
        _: &Registration,
        _: &DeliveryRoute<'_>,
        _: &str,
        admit: &(dyn Fn() -> bool + Send + Sync),
    ) -> InjectOutcome {
        if !admit() {
            return InjectOutcome::Refused("revoked".into());
        }
        self.accepted.store(true, Ordering::SeqCst);
        InjectOutcome::Delivered
    }
    fn codex_mobile_control(
        &self,
        registration: &Registration,
        message: &str,
    ) -> Option<Box<dyn provider::Control>> {
        if !self.accepted.load(Ordering::SeqCst) {
            return None;
        }
        Some(Box::new(FakeControl {
            scope: provider::Scope {
                home: "pinned-home".into(),
                thread: registration.target.id.clone(),
                window: "window-original".into(),
                generation: crate::relay::store::random_uuid(),
                message: message.into(),
                turn: "mobile-turn".into(),
            },
            request: request("mobile-turn"),
            desktop: request("desktop-turn"),
            writes: self.writes.clone(),
            late: self.late.clone(),
        }))
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
        unavailable: AtomicBool::new(false),
        change_account: AtomicBool::new(false),
        wrong_origin: AtomicBool::new(false),
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
        "name":agent.name,"agentID":agent.id,"target":{"kind":"codex","id":THREAD},
        "title":"Codex","baseURL":server.base_url,"workspaceKey":fake_relaycast::WORKSPACE_KEY,
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
            store.mobile_native_continuation = Some(true);
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

async fn engage(core: &Arc<Core>, registration: &Registration, delivery: &Delivery) -> String {
    assert_eq!(
        core.deliver_native_continuation(registration, delivery, "Continue".into())
            .await,
        InjectOutcome::Delivered
    );
    let result = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let reference = core
                .delivery
                .lock()
                .unwrap()
                .codex_mobile
                .tickets
                .keys()
                .next()
                .cloned();
            if let Some(reference) = reference {
                if core.codex_mobile_approvals_ready(registration) {
                    return reference;
                }
            }
            tokio::task::yield_now().await;
        }
    })
    .await;
    if result.is_err() {
        diagnostic(core, registration);
    }
    result.unwrap()
}
fn diagnostic(core: &Core, registration: &Registration) {
    let snapshot = {
        let state = core.delivery.lock().unwrap();
        state
            .codex_mobile
            .sessions
            .get(&registration.agent_id)
            .map(|s| {
                (
                    s.authority.clone(),
                    s.ready.is_some(),
                    s.verified.is_some(),
                    s.revoked,
                )
            })
    };
    if let Some((authority, ready, verified, revoked)) = snapshot {
        eprintln!("observer ready={ready} verified={verified} revoked={revoked} current={} input_registration_matches={}",authority.current(core),authority.registration==*registration);
    } else {
        eprintln!("observer absent");
    }
}
fn reply(delivery: &Delivery, reference: &str) -> Delivery {
    Delivery {
        id: crate::relay::store::random_uuid(),
        message_id: crate::relay::store::random_uuid(),
        text: Some(format!("approve {reference}")),
        ..delivery.clone()
    }
}

#[cfg(unix)]
#[tokio::test]
async fn only_accepted_mobile_turn_exposes_safe_owner_ticket_and_consumes_once() {
    let (_home, server, core, native, registration, delivery, _cloud) = fixture().await;
    assert!(!core.codex_mobile_approvals_ready(&registration));
    assert!(core
        .delivery
        .lock()
        .unwrap()
        .codex_mobile
        .tickets
        .is_empty());
    let reference = engage(&core, &registration, &delivery).await;
    assert_eq!(
        core.delivery.lock().unwrap().codex_mobile.tickets.len(),
        1,
        "desktop-origin request excluded"
    );
    assert!(core.codex_mobile_approvals_ready(&registration));
    let mut peer = reply(&delivery, &reference);
    peer.sender_id = Some("peer".into());
    assert!(matches!(
        core.codex_mobile_reply(&registration, &peer).await,
        None
    ));
    let mut channel = reply(&delivery, &reference);
    channel.channel_id = Some("channel".into());
    assert!(matches!(
        core.codex_mobile_reply(&registration, &channel).await,
        None
    ));
    let answer = reply(&delivery, &reference);
    let result = core.codex_mobile_reply(&registration, &answer).await;
    assert!(matches!(result,Some(OwnerReply::Settled(text)) if text.contains("unconfirmed")));
    assert_eq!(native.writes.load(Ordering::SeqCst), 1);
    let _ = core.codex_mobile_reply(&registration, &answer).await;
    assert_eq!(native.writes.load(Ordering::SeqCst), 1);
    let recorded = format!("{:?}", server.requests());
    assert!(!recorded.contains("SECRET_COMMAND_NOT_FOR_PHONE"));
    core.withdraw_codex_mobile();
}

#[cfg(unix)]
#[tokio::test]
async fn late_account_revocation_refuses_before_provider_write() {
    let (_home, _server, core, native, registration, delivery, cloud) = fixture().await;
    let reference = engage(&core, &registration, &delivery).await;
    *native.late.lock().unwrap() = Some(Arc::new(move || {
        *cloud.user.lock().unwrap() = Some("replacement-person".into())
    }));
    let result = core
        .codex_mobile_reply(&registration, &reply(&delivery, &reference))
        .await;
    assert!(
        matches!(result,Some(OwnerReply::Settled(text)) if text.contains("No approval was sent"))
    );
    assert_eq!(native.writes.load(Ordering::SeqCst), 0);
    assert!(!core.codex_mobile_approvals_ready(&registration));
    core.withdraw_codex_mobile();
}

#[cfg(unix)]
#[tokio::test]
async fn optout_expiry_and_journal_failure_never_send_decisions() {
    for mode in ["optout", "expiry", "journal"] {
        let (_home, _server, core, native, registration, delivery, _cloud) = fixture().await;
        let reference = engage(&core, &registration, &delivery).await;
        match mode {
            "optout" => {
                core.store
                    .update(|store| store.mobile_native_continuation = Some(false))
                    .unwrap();
                core.withdraw_codex_mobile();
            }
            "expiry" => {
                core.delivery
                    .lock()
                    .unwrap()
                    .codex_mobile
                    .tickets
                    .get_mut(&reference)
                    .unwrap()
                    .expires = Instant::now();
            }
            _ => {
                std::fs::create_dir_all(&core.config.app_data_dir).unwrap();
                std::fs::write(
                    core.config.app_data_dir.join("codex-mobile-consumed"),
                    b"blocked",
                )
                .unwrap();
            }
        }
        let _ = core
            .codex_mobile_reply(&registration, &reply(&delivery, &reference))
            .await;
        assert_eq!(native.writes.load(Ordering::SeqCst), 0);
        core.withdraw_codex_mobile();
    }
}

#[cfg(unix)]
#[tokio::test]
async fn consumed_request_is_not_reoffered_after_observer_restart() {
    let (_home, _server, core, native, registration, delivery, _cloud) = fixture().await;
    let reference = engage(&core, &registration, &delivery).await;
    let _ = core
        .codex_mobile_reply(&registration, &reply(&delivery, &reference))
        .await;
    core.withdraw_codex_mobile();
    tokio::time::timeout(Duration::from_secs(3), async {
        while !core
            .delivery
            .lock()
            .unwrap()
            .codex_mobile
            .sessions
            .is_empty()
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        core.deliver_native_continuation(&registration, &delivery, "Continue".into())
            .await,
        InjectOutcome::Delivered
    );
    tokio::time::timeout(Duration::from_secs(3), async {
        while !core.codex_mobile_approvals_ready(&registration) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(core
        .delivery
        .lock()
        .unwrap()
        .codex_mobile
        .tickets
        .is_empty());
    assert_eq!(native.writes.load(Ordering::SeqCst), 1);
    core.withdraw_codex_mobile();
}

#[test]
fn durable_consumption_identity_survives_window_connection_and_message_changes() {
    let mut scope = provider::Scope {
        home: "home".into(),
        thread: THREAD.into(),
        window: "old".into(),
        generation: "old".into(),
        message: "old".into(),
        turn: "mobile-turn".into(),
    };
    let first = worker::request_key(&scope, &request("mobile-turn"));
    scope.window = "new".into();
    scope.generation = "new".into();
    scope.message = "new".into();
    assert_eq!(first, worker::request_key(&scope, &request("mobile-turn")));
}

#[cfg(unix)]
#[tokio::test]
async fn withdrawn_expired_and_restart_references_are_replies_not_new_native_turns() {
    let (_home, _server, core, native, registration, delivery, _cloud) = fixture().await;
    let reference = engage(&core, &registration, &delivery).await;
    assert_eq!(reference.len(), 4 + REFERENCE_HEX_LEN);
    core.delivery
        .lock()
        .unwrap()
        .codex_mobile
        .tickets
        .get_mut(&reference)
        .unwrap()
        .expires = Instant::now();
    assert!(matches!(
        core.owner_reply(&registration, &reply(&delivery, &reference))
            .await,
        OwnerReply::Settled(_)
    ));
    core.withdraw_codex_mobile();
    core.store
        .update(|store| store.mobile_native_continuation = Some(false))
        .unwrap();
    assert!(matches!(
        core.owner_reply(&registration, &reply(&delivery, &reference))
            .await,
        OwnerReply::Settled(_)
    ));
    assert!(matches!(
        core.owner_reply(&registration, &reply(&delivery, "cxm-0123456789abcdef"))
            .await,
        OwnerReply::Settled(_)
    ));
    assert_eq!(native.writes.load(Ordering::SeqCst), 0);
}

#[cfg(unix)]
#[tokio::test]
async fn transient_owner_outage_suspends_and_recovers_same_ticket_without_renewing_expiry() {
    let (_home, server, core, native, registration, delivery, _cloud) = fixture().await;
    let reference = engage(&core, &registration, &delivery).await;
    let expires = core.delivery.lock().unwrap().codex_mobile.tickets[&reference].expires;
    server.set_failing(&["GET /v1/agents/owner"]);
    tokio::time::timeout(Duration::from_secs(9), async {
        while core.codex_mobile_approvals_ready(&registration) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(matches!(
        core.owner_reply(&registration, &reply(&delivery, &reference))
            .await,
        OwnerReply::Settled(_)
    ));
    assert_eq!(native.writes.load(Ordering::SeqCst), 0);
    server.set_failing(&[]);
    tokio::time::timeout(Duration::from_secs(9), async {
        while !core.codex_mobile_approvals_ready(&registration) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        core.delivery.lock().unwrap().codex_mobile.tickets[&reference].expires,
        expires
    );
    let _ = core
        .owner_reply(&registration, &reply(&delivery, &reference))
        .await;
    assert_eq!(native.writes.load(Ordering::SeqCst), 1);
    core.withdraw_codex_mobile();
}

#[cfg(unix)]
#[tokio::test]
async fn metadata_changes_preserve_ticket_but_registration_replacement_revokes_it() {
    let (_home, _server, core, native, registration, delivery, _cloud) = fixture().await;
    let reference = engage(&core, &registration, &delivery).await;
    core.store
        .update(|store| {
            let mut current = store
                .registration_for(&registration.target)
                .unwrap()
                .clone();
            current.title = "New native title".into();
            current.missing_since = Some("2026-10-26T00:00:00Z".into());
            store.update(current);
        })
        .unwrap();
    assert!(core.codex_mobile_approvals_ready(&registration));
    core.store
        .update(|store| {
            let mut current = store
                .registration_for(&registration.target)
                .unwrap()
                .clone();
            current.route_binding = Some("replacement-binding".into());
            store.update(current);
        })
        .unwrap();
    assert!(!core.codex_mobile_approvals_ready(&registration));
    assert!(matches!(
        core.owner_reply(&registration, &reply(&delivery, &reference))
            .await,
        OwnerReply::Settled(_)
    ));
    assert_eq!(native.writes.load(Ordering::SeqCst), 0);
    core.withdraw_codex_mobile();
}

#[test]
fn mutable_file_state_cannot_resurrect_a_consumed_provider_request() {
    fn file_request(status: &str) -> ApprovalRequest {
        let mut registry = crate::relay::codex::follower::Registry::new(THREAD, "window").unwrap();
        registry.apply(&json!({"type":"broadcast","method":"thread-stream-state-changed","version":11,"sourceClientId":"window","params":{"hostId":"local","conversationId":THREAD,"change":{"type":"snapshot","revision":1,"conversationState":{"id":THREAD,"cwd":"/tmp/project","turns":[{"id":"mobile-turn","items":[{"id":"file","type":"fileChange","status":status,"changes":[{"path":"src/lib.rs","kind":{"type":"update"},"diff":"synthetic"}]}]}],"requests":[{"id":42,"method":"item/fileChange/requestApproval","params":{"threadId":THREAD,"turnId":"mobile-turn","itemId":"file"}}]}}}})).unwrap();
        registry.pending()[0].clone()
    }
    let scope = provider::Scope {
        home: "home".into(),
        thread: THREAD.into(),
        window: "window".into(),
        generation: "gen".into(),
        message: "mobile".into(),
        turn: "mobile-turn".into(),
    };
    let before = file_request("inProgress");
    let after = file_request("completed");
    assert_ne!(before.key(), after.key());
    assert_eq!(
        worker::request_key(&scope, &before),
        worker::request_key(&scope, &after)
    );
    assert!(description::safe(&before)
        .unwrap()
        .contains("/tmp/project/src/lib.rs"));
}

#[cfg(unix)]
#[tokio::test]
async fn fresh_owner_verification_failure_during_provider_preflight_blocks_decision() {
    let (_home, _server, core, native, registration, delivery, _cloud) = fixture().await;
    let reference = engage(&core, &registration, &delivery).await;
    let ticket = core.delivery.lock().unwrap().codex_mobile.tickets[&reference].clone();
    let weak = Arc::downgrade(&core);
    let authority = ticket.authority.clone();
    *native.late.lock().unwrap() = Some(Arc::new(move || {
        if let Some(core) = weak.upgrade() {
            core.codex_owner_observed(&authority, &OwnerProof::Unavailable);
        }
    }));
    assert!(
        matches!(core.owner_reply(&registration,&reply(&delivery,&reference)).await,OwnerReply::Settled(text) if text.contains("No approval was sent"))
    );
    assert_eq!(native.writes.load(Ordering::SeqCst), 0);
    assert!(!ledger::consumed(
        &core.config.app_data_dir.join("codex-mobile-consumed"),
        &ticket.key
    ));
    assert!(!core.codex_mobile_approvals_ready(&registration));
    core.withdraw_codex_mobile();
}

#[cfg(unix)]
#[tokio::test]
async fn unknown_mobile_references_preserve_peer_channel_and_other_provider_routing() {
    let (_home, _server, core, native, registration, delivery, _cloud) = fixture().await;
    let answer = reply(&delivery, "cxm-0123456789abcdef");
    let mut peer = answer.clone();
    peer.sender_id = Some("peer-immutable-id".into());
    let mut channel = answer.clone();
    channel.channel_id = Some("channel".into());
    for ordinary in [peer, channel] {
        assert!(matches!(
            core.owner_reply(&registration, &ordinary).await,
            OwnerReply::NotOne
        ));
    }
    for kind in [
        SessionKind::Pi,
        SessionKind::ClaudeTerminal,
        SessionKind::OpenCode,
    ] {
        let mut other = registration.clone();
        other.target.kind = kind;
        assert!(matches!(
            core.owner_reply(&other, &answer).await,
            OwnerReply::NotOne
        ));
    }
    assert_eq!(native.writes.load(Ordering::SeqCst), 0);
}

#[cfg(unix)]
#[tokio::test]
async fn restart_stale_owner_reference_waits_for_identity_then_settles_with_optin_off() {
    let (home, _server, core, native, registration, delivery, cloud) = fixture().await;
    core.store
        .update(|store| store.mobile_native_continuation = Some(false))
        .unwrap();
    // A new Core has neither observer state nor a cached person identity.
    let (restarted, _) = Core::with_plugins(
        config(home.path()),
        Plugins {
            cloud: cloud.clone(),
            injector: native.clone(),
            ..Plugins::default()
        },
    );
    std::thread::scope(|scope| {
        scope
            .spawn(|| restarted.rediscover_workspace())
            .join()
            .unwrap()
    });
    let answer = reply(&delivery, "cxm-0123456789abcdef");
    cloud.unavailable.store(true, Ordering::SeqCst);
    assert!(matches!(
        restarted.owner_reply(&registration, &answer).await,
        OwnerReply::Unsaved
    ));
    assert!(!restarted
        .store
        .read(|store| store.injected_delivery_ids.contains(&answer.id)));
    assert!(!native.accepted.load(Ordering::SeqCst));
    cloud.unavailable.store(false, Ordering::SeqCst);
    cloud.change_account.store(true, Ordering::SeqCst);
    assert!(
        matches!(
            restarted.owner_reply(&registration, &answer).await,
            OwnerReply::Unsaved
        ),
        "account change during identity lookup must remain deferred"
    );
    *cloud.user.lock().unwrap() = Some("person".into());
    assert!(matches!(
        restarted.owner_reply(&registration, &answer).await,
        OwnerReply::Settled(_)
    ));
    let mut peer = answer.clone();
    peer.sender_id = Some("peer-after-recovery".into());
    assert!(matches!(
        restarted.owner_reply(&registration, &peer).await,
        OwnerReply::NotOne
    ));
    assert!(!native.accepted.load(Ordering::SeqCst));
    assert_eq!(native.writes.load(Ordering::SeqCst), 0);
}

#[cfg(unix)]
#[tokio::test]
async fn mismatched_identity_origin_defers_until_valid_owner_proof_recovers() {
    let (_home, _server, core, native, registration, delivery, cloud) = fixture().await;
    *core.messaging.lock().unwrap() = Default::default();
    cloud.wrong_origin.store(true, Ordering::SeqCst);
    let answer = reply(&delivery, "cxm-0123456789abcdef");
    assert!(matches!(
        core.owner_reply(&registration, &answer).await,
        OwnerReply::Unsaved
    ));
    assert!(!core
        .store
        .read(|store| store.injected_delivery_ids.contains(&answer.id)));
    cloud.wrong_origin.store(false, Ordering::SeqCst);
    *core.messaging.lock().unwrap() = Default::default();
    assert!(matches!(
        core.owner_reply(&registration, &answer).await,
        OwnerReply::Settled(_)
    ));
    assert!(!native.accepted.load(Ordering::SeqCst));
    assert_eq!(native.writes.load(Ordering::SeqCst), 0);
}

#[cfg(unix)]
#[tokio::test]
async fn missing_registration_defers_stale_reply_until_canonical_scope_recovers() {
    let (_home, _server, core, native, registration, delivery, _cloud) = fixture().await;
    let saved = core.store.read(|store| store.registrations.clone());
    core.store
        .update(|store| store.registrations.clear())
        .unwrap();
    let answer = reply(&delivery, "cxm-0123456789abcdef");
    assert!(matches!(
        core.owner_reply(&registration, &answer).await,
        OwnerReply::Unsaved
    ));
    assert!(!core
        .store
        .read(|store| store.injected_delivery_ids.contains(&answer.id)));
    core.store
        .update(|store| store.registrations = saved)
        .unwrap();
    assert!(matches!(
        core.owner_reply(&registration, &answer).await,
        OwnerReply::Settled(_)
    ));
    assert!(!native.accepted.load(Ordering::SeqCst));
    assert_eq!(native.writes.load(Ordering::SeqCst), 0);
}

#[cfg(unix)]
#[tokio::test]
async fn mismatched_workspace_defers_stale_reply_until_original_scope_recovers() {
    let (_home, _server, core, native, registration, delivery, _cloud) = fixture().await;
    let saved = core.store.read(|store| store.cloud.clone());
    core.store
        .update(|store| store.cloud.as_mut().unwrap().key = Secret::new("rk_live_other0000"))
        .unwrap();
    std::thread::scope(|scope| scope.spawn(|| core.rediscover_workspace()).join().unwrap());
    assert_ne!(
        Some(core.workspace().unwrap().key),
        registration.workspace_key
    );
    let answer = reply(&delivery, "cxm-0123456789abcdef");
    assert!(matches!(
        core.owner_reply(&registration, &answer).await,
        OwnerReply::Unsaved
    ));
    assert!(!core
        .store
        .read(|store| store.injected_delivery_ids.contains(&answer.id)));
    core.store.update(|store| store.cloud = saved).unwrap();
    std::thread::scope(|scope| scope.spawn(|| core.rediscover_workspace()).join().unwrap());
    assert!(matches!(
        core.owner_reply(&registration, &answer).await,
        OwnerReply::Settled(_)
    ));
    assert!(!native.accepted.load(Ordering::SeqCst));
    assert_eq!(native.writes.load(Ordering::SeqCst), 0);
}
