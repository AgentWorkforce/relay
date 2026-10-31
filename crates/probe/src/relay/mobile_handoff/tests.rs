//! Joins the authenticated owner, durable queue, private socket and outbound DM seams.
use super::*;
use crate::relay::cloud_session::{AgentOwner, CloudAccess, CloudAccount, CloudError};
use crate::relay::daemon::{Config, Plugins};
use crate::relay::outbound::{Outbound, Request};
use crate::relay::sessions::{CallerMiss, DiscoveredSession, SessionDirectory};
use crate::relay::setup::DirectDelivery;
use crate::relay::store::{CloudWorkspace, Target};
use crate::relay::workspace::Secret;
use futures_util::future::BoxFuture;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;

#[path = "../../../tests/support/fake_relaycast.rs"]
mod fake_relaycast;

struct SignedIn {
    base: String,
    owner: String,
}
impl CloudAccess for SignedIn {
    fn account(&self) -> Option<CloudAccount> {
        Some(CloudAccount {
            site_url: self.base.clone(),
            workspace_id: "workspace".into(),
            user_id: Some("person".into()),
        })
    }
    fn agent_owner(&self) -> Option<AgentOwner> {
        None
    }
    fn request(
        &self,
        _: &'static str,
        path: String,
        _: Option<Value>,
    ) -> BoxFuture<'_, Result<Value, CloudError>> {
        Box::pin(async move {
            if path.ends_with("/messaging/identity/credential") {
                Ok(
                    json!({"identity":{"name":"owner", "agentId":self.owner, "token":"at_owner", "relaycastUrl":self.base}}),
                )
            } else {
                Ok(Value::Null)
            }
        })
    }
}
struct Directory(
    DiscoveredSession,
    Arc<std::sync::Mutex<Option<Runtime>>>,
    Arc<std::sync::atomic::AtomicBool>,
    std::path::PathBuf,
);
impl SessionDirectory for Directory {
    fn mobile_claude_config_roots(&self) -> std::collections::BTreeMap<Target, std::path::PathBuf> {
        if self.2.load(std::sync::atomic::Ordering::SeqCst) {
            [(self.0.target.clone(), self.3.clone())]
                .into_iter()
                .collect()
        } else {
            Default::default()
        }
    }
    fn sessions(&self) -> Vec<DiscoveredSession> {
        let mut session = self.0.clone();
        session.live = self.1.lock().unwrap().is_some();
        vec![session]
    }
    fn caller(&self, pid: i32) -> Result<DiscoveredSession, CallerMiss> {
        if matches!(pid, 4100 | 4102) {
            Ok(self.0.clone())
        } else {
            Err(CallerMiss::NotASession)
        }
    }
    fn mobile_claude_incarnation(&self, expected: &Runtime) -> Option<bool> {
        Some(
            self.1.lock().unwrap().as_ref().is_some_and(|runtime| {
                runtime.pid == expected.pid && runtime.start == expected.start
            }),
        )
    }
    fn mobile_claude_runtime(&self, target: &Target, pid: i32) -> Option<Runtime> {
        if !self.2.load(std::sync::atomic::Ordering::SeqCst) {
            return None;
        }
        self.1
            .lock()
            .unwrap()
            .clone()
            .filter(|runtime| target == &self.0.target && pid == runtime.pid)
    }
}
struct NoDirect;
impl DirectDelivery for NoDirect {
    fn delivers_directly(&self) -> bool {
        false
    }
    fn managed_value(&self) -> Option<String> {
        None
    }
    fn user_choice(&self) -> Option<String> {
        None
    }
    fn set_direct_delivery(&self, _: bool) -> Result<(), String> {
        panic!("native control never changes peer settings")
    }
}
fn request(route: &str, body: Value) -> Request {
    Request {
        method: "POST".into(),
        path: format!("/claude/mobile-handoff/{route}"),
        body: serde_json::to_vec(&body).unwrap(),
        ..Request::default()
    }
}

fn fixture_config(home: &std::path::Path) -> Config {
    Config {
        paths: crate::relay::paths::CorePaths::for_socket(home.join("core.sock")).unwrap(),
        home: home.into(),
        app_data_dir: home.join("app-data"),
        env: Default::default(),
        version: "test".into(),
        host_name: "Test Desk".into(),
        rediscover_every: Duration::from_secs(3600),
        push_timing: Default::default(),
        delivery_timing: Default::default(),
    }
}

#[tokio::test]
async fn mobile_owner_roundtrip_preserves_authority_and_idle_poll_is_local() {
    let server = fake_relaycast::FakeRelaycast::start(Default::default()).await;
    let owner = server.seed_agent("owner", "human", json!({}));
    let agent = server.seed_agent("claude-mobile", "agent", json!({}));
    let home = tempfile::tempdir().unwrap();
    let config = fixture_config(home.path());
    let registration: Registration = serde_json::from_value(json!({
        "name":agent.name, "agentID":agent.id, "target":{"kind":"claude-terminal", "id":"00000000-0000-4000-8000-000000000001"},
        "title":"Claude", "baseURL":server.base_url, "workspaceKey":fake_relaycast::WORKSPACE_KEY,
        "registeredAt":"2026-10-24T00:00:00Z"
    })).unwrap();
    let session = DiscoveredSession {
        target: registration.target.clone(),
        title: "Claude".into(),
        directory: None,
        updated_at_ms: None,
        host: None,
        live: true,
        holder: None,
    };
    let registry_ready = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let plugins = Plugins {
        cloud: Arc::new(SignedIn {
            base: server.base_url.clone(),
            owner: owner.id.clone(),
        }),
        sessions: Arc::new(Directory(
            session,
            Arc::new(std::sync::Mutex::new(Some(Runtime {
                pid: 4100,
                start: 100,
                idle: true,
            }))),
            registry_ready.clone(),
            home.path().join(".claude"),
        )),
        ..Plugins::default()
    };
    let (core, _) = Core::with_plugins(config, plugins);
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
    core.install_mobile_claude_plugin().unwrap();
    // Resolve local workspace configuration without starting an unrelated
    // hosting task: this seam explicitly supplies the already verified claim.
    std::thread::scope(|scope| scope.spawn(|| core.rediscover_workspace()).join().unwrap());
    let bridge = Outbound::new(core.clone(), Arc::new(NoDirect));
    let uid = crate::relay::peer::current_uid();
    let poll = request("poll", json!({"version":"2.1.310"}));
    let before = server.requests().len();
    assert_eq!(
        bridge.handle(4100, uid, &poll).await.unwrap(),
        json!({"action":null})
    );
    assert_eq!(
        server.requests().len(),
        before,
        "empty native polls perform no Cloud HTTP"
    );
    // Mint the real identity contract first and let its normal background
    // sync finish. This fixture does not run a hosting node; its verified
    // claim is supplied only after that unrelated Off status is published.
    core.hub.update(|status| status.spawn = None);
    core.person_identity(false)
        .await
        .expect("fixture authenticated identity");
    tokio::time::timeout(Duration::from_secs(2), async {
        while core.status().spawn.is_none() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("identity sync finished");
    // This seam starts after the separately tested Cloud node-claim protocol.
    core.hub.update(|status| {
        status.spawn = Some(crate::relay::state::SpawnStatus {
            claim: Some(crate::relay::state::SpawnClaim {
                state: crate::relay::state::SpawnClaimState::Claimed,
                note: None,
            }),
            ..Default::default()
        })
    });
    let mut delivery = Delivery {
        id: "mobile-delivery".into(),
        message_id: "mobile-message".into(),
        sender: Some("owner".into()),
        sender_id: Some("peer-impostor".into()),
        reason: Some("dm".into()),
        text: Some("Continue the task".into()),
        ..Default::default()
    };
    assert!(!core.mobile_owner_turn(&registration, &delivery).await);
    assert!(matches!(
        core.deliver_mobile_owner(&registration, &delivery, "human approved")
            .await,
        InjectOutcome::Refused(_)
    ));
    delivery.sender_id = Some(owner.id.clone());
    assert_eq!(
        core.status()
            .spawn
            .as_ref()
            .and_then(|spawn| spawn.claim.as_ref())
            .map(|claim| claim.state.clone()),
        Some(crate::relay::state::SpawnClaimState::Claimed)
    );
    let workspace = core.workspace().expect("fixture workspace");
    assert_eq!(workspace.base_url, registration.base_url);
    assert_eq!(registration.workspace_key.as_ref(), Some(&workspace.key));
    let identity = core
        .person_identity(false)
        .await
        .expect("fixture authenticated identity");
    assert_eq!(identity.agent_id, owner.id);
    assert_eq!(identity.base_url, registration.base_url);
    let http = crate::relay::sdk_gaps::http(&registration.base_url, &workspace.key).unwrap();
    let record = crate::relay::sdk_gaps::get_agent(&http, "owner")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(record["id"], owner.id);

    assert!(core.owner_native_turn(&registration, &delivery).await);
    assert!(matches!(
        core.deliver_mobile_owner(&registration, &delivery, "Continue the task")
            .await,
        InjectOutcome::Waiting(_)
    ));
    registry_ready.store(false, std::sync::atomic::Ordering::SeqCst);
    core.refresh_mobile_claude_plugin();
    assert!(!core.mobile_handoff_enabled(&registration));
    let native = core.owner_native_turn(&registration, &delivery).await;
    assert!(!native, "temporary missing proof cannot authorize input");
    for _ in 0..2 {
        assert!(matches!(core.previous_mobile_delivery(&registration, &delivery, native).await,
            Some(InjectOutcome::Waiting(_))),
            "delivery retries preserve the already-authorized queued message while discovery is uncertain");
    }
    assert!(
        bridge.handle(4100, uid, &poll).await.is_err(),
        "no submission while the registry is unavailable"
    );
    let mut unavailable_delivery = delivery.clone();
    unavailable_delivery.id = "new-while-unavailable".into();
    assert!(
        matches!(
            core.deliver_mobile_owner(&registration, &unavailable_delivery, "New message")
                .await,
            InjectOutcome::Refused(_)
        ),
        "suspension does not admit a new native message"
    );
    registry_ready.store(true, std::sync::atomic::Ordering::SeqCst);
    core.refresh_mobile_claude_plugin();
    assert!(core.mobile_handoff_enabled(&registration));
    assert!(core.owner_native_turn(&registration, &delivery).await);
    assert!(
        matches!(
            core.previous_mobile_delivery(&registration, &delivery, native)
                .await,
            Some(InjectOutcome::Waiting(_))
        ),
        "stale native=false classification cannot cancel a receipt after discovery recovers"
    );
    server.set_failing(&["GET /v1/agents/owner"]);
    assert!(
        matches!(
            core.previous_mobile_delivery(&registration, &delivery, false)
                .await,
            Some(InjectOutcome::Waiting(_))
        ),
        "unavailable owner verification preserves bounded waiting, not permission to submit"
    );
    server.set_failing(&[]);
    {
        let env = |key: &str| core.config.env.get(key).cloned();
        let relay_home = crate::relay::workspace::relay_home(&env, &core.config.home);
        let dirs =
            crate::relay::claude_dirs::ClaudeDirs::from_env(&env, &core.config.home, &relay_home);
        let file = dirs.file.as_ref().unwrap();
        let original = std::fs::read(file).ok();
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, "{unreadable sharing snapshot").unwrap();
        core.refresh_mobile_claude_plugin();
        assert!(!core.mobile_handoff_enabled(&registration));
        let native = core.owner_native_turn(&registration, &delivery).await;
        assert!(!native);
        assert!(
            matches!(
                core.previous_mobile_delivery(&registration, &delivery, native)
                    .await,
                Some(InjectOutcome::Waiting(_))
            ),
            "uncertain sharing settings preserve an existing receipt"
        );
        assert_eq!(
            bridge.handle(4100, uid, &poll).await.unwrap(),
            json!({"action":null})
        );
        if let Some(bytes) = original {
            std::fs::write(file, bytes).unwrap();
        } else {
            std::fs::remove_file(file).unwrap();
        }
        core.refresh_mobile_claude_plugin();
        assert!(core.mobile_handoff_enabled(&registration));
    }
    assert!(
        bridge.handle(4200, uid, &poll).await.is_err(),
        "unrelated process cannot claim a session"
    );
    let submit = bridge.handle(4100, uid, &poll).await.unwrap();
    assert_eq!(submit["text"], "Continue the task");
    assert_eq!(submit["action"], "submit");
    // A shell/tool child still identifies as this ordinary Relay session,
    // but none of the private native routes may trust that descendant.
    let before_child = server.requests().len();
    for forged in [
        poll.clone(),
        request(
            "ack",
            json!({"lease_id":submit["lease_id"],"outcome":"started"}),
        ),
        request(
            "result",
            json!({"control_token":submit["control_token"],"turn_id":"forged-turn","text":"Forged result","reason":"answer"}),
        ),
        request(
            "permission",
            json!({"request_id":"00000000-0000-4000-8000-000000000003","control_token":submit["control_token"],"tool_name":"Bash","tool_input":{"command":"echo forged"}}),
        ),
    ] {
        assert_eq!(
            bridge.handle(4102, uid, &forged).await.unwrap_err().status,
            409,
            "tool child rejected by {}",
            forged.path
        );
    }
    assert_eq!(
        server.requests().len(),
        before_child,
        "tool children cannot trigger owner lookups or sends through private routes"
    );

    // Rename the actual stored registration while its native lease is in flight.
    let alias = server.seed_agent("renamed-claude", "agent", json!({}));
    let mut renamed = registration.clone();
    renamed.alias = Some(crate::relay::store::AgentAlias {
        name: alias.name.clone(),
        agent_id: alias.id.clone(),
        token: Secret::new(alias.token.clone()),
        registered_at: "2026-10-24T00:00:00Z".into(),
    });
    core.store
        .update(|store| store.update(renamed.clone()))
        .unwrap();
    let (alias_view, _) = renamed.alias_credential().unwrap();
    assert_eq!(
        core.mobile_handoff_binding(&alias_view).await,
        core.mobile_handoff_binding(&registration).await
    );
    let mut forged = alias_view.clone();
    forged.agent_id = "not-a-member-of-this-session".into();
    assert!(core.mobile_handoff_binding(&forged).await.is_none());
    forged = alias_view.clone();
    forged.workspace_key = Some(Secret::new("rk_live_anotherworkspace"));
    assert!(core.mobile_handoff_binding(&forged).await.is_none());
    assert_eq!(
        bridge.handle(4100, uid, &poll).await.unwrap(),
        json!({"action":null}),
        "leased text is never issued twice"
    );
    let answer = request(
        "result",
        json!({"control_token":submit["control_token"], "turn_id":"turn-1", "text":"Done", "reason":"answer"}),
    );
    assert_eq!(
        bridge.handle(4100, uid, &answer).await.unwrap(),
        json!({"accepted":false}),
        "unacknowledged input cannot forward unrelated answers"
    );
    // The delivery loop left this message waiting on its fixed retry.
    core.hold_delivery_retry(&delivery.id, &registration.name, Duration::from_secs(60));
    let before_ack = server.requests().len();
    bridge
        .handle(
            4100,
            uid,
            &request(
                "ack",
                json!({"lease_id":submit["lease_id"], "outcome":"started"}),
            ),
        )
        .await
        .unwrap();
    assert!(
        !core.delivery_retry_pending(&delivery.id),
        "the native ack settles the delivery without waiting out its retry"
    );
    tokio::time::timeout(Duration::from_secs(2), async {
        while !server.requests()[before_ack..]
            .iter()
            .any(|record| record.method == "GET" && record.path.contains("deliveries"))
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the native ack reads the agent's queue again");
    assert!(matches!(
        core.deliver_mobile_owner(&registration, &delivery, "Continue the task")
            .await,
        InjectOutcome::Delivered
    ));
    let before_receipts = server.requests().len();
    assert!(matches!(
        core.previous_mobile_delivery(&registration, &delivery, false)
            .await,
        Some(InjectOutcome::Delivered)
    ));
    assert!(core
        .previous_mobile_delivery(&registration, &unavailable_delivery, false)
        .await
        .is_none());
    assert_eq!(
        server.requests().len(),
        before_receipts,
        "terminal receipts and unknown IDs do not verify the owner over Cloud"
    );
    registry_ready.store(false, std::sync::atomic::Ordering::SeqCst);
    core.prune_mobile_handoff_runtimes().unwrap();
    assert_eq!(
        bridge.handle(4100, uid, &answer).await.unwrap_err().status,
        409,
        "unknown registry blocks current native authentication"
    );
    registry_ready.store(true, std::sync::atomic::Ordering::SeqCst);
    server.set_failing(&["GET /v1/agents/owner"]);
    assert_eq!(
        bridge.handle(4100, uid, &answer).await.unwrap_err().status,
        503
    );
    assert!(!server
        .requests()
        .iter()
        .any(|record| record.method == "POST" && record.body["text"] == "Done"));
    server.set_failing(&[]);
    assert_eq!(
        bridge.handle(4100, uid, &answer).await.unwrap(),
        json!({"accepted":true})
    );
    let sent = server
        .requests()
        .into_iter()
        .find(|record| record.method == "POST" && record.body["text"] == "Done")
        .unwrap();
    assert_eq!(sent.body["to"], "owner");
    assert_eq!(
        sent.authorization.as_deref(),
        Some(format!("Bearer {}", alias.token).as_str()),
        "native answer uses the current visible alias identity"
    );
    assert_eq!(
        core.mobile_handoff_metadata(&renamed)["mobile_handoff_state"],
        "ready"
    );
    let mut stale_owner = delivery.clone();
    stale_owner.id = "queued-before-owner-mismatch".into();
    assert!(matches!(
        core.deliver_mobile_owner(&registration, &stale_owner, "Original owner request")
            .await,
        InjectOutcome::Waiting(_)
    ));
    stale_owner.sender_id = Some("different-owner".into());
    let native = core.owner_native_turn(&registration, &stale_owner).await;
    assert!(!native);
    assert!(
        matches!(
            core.previous_mobile_delivery(&registration, &stale_owner, native)
                .await,
            Some(InjectOutcome::Refused(_))
        ),
        "available admission still rejects a real owner mismatch"
    );

    let mut alias_delivery = delivery.clone();
    alias_delivery.id = "new-alias-delivery".into();
    assert!(core.owner_native_turn(&alias_view, &alias_delivery).await);
    assert!(matches!(
        core.deliver_mobile_owner(&alias_view, &alias_delivery, "Continue through alias")
            .await,
        InjectOutcome::Waiting(_)
    ));
    let alias_submit = bridge.handle(4100, uid, &poll).await.unwrap();
    assert_eq!(alias_submit["text"], "Continue through alias");
    assert_eq!(
        alias_submit["control_token"], submit["control_token"],
        "rename preserves one engaged native generation"
    );
    bridge
        .handle(
            4100,
            uid,
            &request(
                "ack",
                json!({"lease_id":alias_submit["lease_id"], "outcome":"started"}),
            ),
        )
        .await
        .unwrap();
    assert!(matches!(
        core.deliver_mobile_owner(&alias_view, &alias_delivery, "Continue through alias")
            .await,
        InjectOutcome::Delivered
    ));

    let permission_input = json!({"command":"echo permitted", "nested":{"preserve":true}});
    let permission = request(
        "permission",
        json!({
            "request_id":"turn-alias:permission-1", "control_token":alias_submit["control_token"],
            "tool_name":"Bash", "tool_input":permission_input,
        }),
    );
    let started = std::time::Instant::now();
    assert_eq!(
        tokio::time::timeout(
            Duration::from_secs(25),
            bridge.handle(4100, uid, &permission)
        )
        .await
        .unwrap()
        .unwrap(),
        json!({"handled":true,"pending":true}),
        "one HTTP request returns before Claude's 30-second deadline"
    );
    assert!(
        started.elapsed() >= Duration::from_secs(14),
        "pending requests long-poll rather than spin"
    );
    let notices = || {
        server
            .requests()
            .into_iter()
            .filter(|record| {
                record.method == "POST"
                    && record.body["text"]
                        .as_str()
                        .is_some_and(|text| text.starts_with("[Claude approval "))
            })
            .collect::<Vec<_>>()
    };
    let recorded = notices();
    assert_eq!(recorded.len(), 1);
    assert_eq!(
        recorded[0].authorization.as_deref(),
        Some(format!("Bearer {}", alias.token).as_str())
    );
    assert_eq!(recorded[0].body["to"], "owner");
    let reference = recorded[0].body["text"]
        .as_str()
        .unwrap()
        .split_ascii_whitespace()
        .nth(2)
        .unwrap();
    let mut reply = delivery.clone();
    reply.id = "mobile-permission-reply".into();
    reply.text = Some(format!("approve {reference}"));
    reply.sender_id = Some("peer-impostor".into());
    assert!(matches!(
        core.mobile_permission_reply(&alias_view, &reply).await,
        Some(crate::relay::spawn::drive::OwnerReply::NotOne)
    ));
    reply.sender_id = delivery.sender_id.clone();
    assert!(matches!(
        core.mobile_permission_reply(&alias_view, &reply).await,
        Some(crate::relay::spawn::drive::OwnerReply::Settled(_))
    ));
    let expected =
        json!({"handled":true,"decision":{"behavior":"allow","updatedInput":permission_input}});
    for _ in 0..2 {
        assert_eq!(
            bridge.handle(4100, uid, &permission).await.unwrap(),
            expected,
            "a lost final response is replayed without another owner prompt"
        );
    }
    assert_eq!(notices().len(), 1);
    let changed = request(
        "permission",
        json!({
            "request_id":"turn-alias:permission-1", "control_token":alias_submit["control_token"],
            "tool_name":"Bash", "tool_input":{"command":"different command"},
        }),
    );
    assert_eq!(
        bridge.handle(4100, uid, &changed).await.unwrap_err().status,
        409
    );

    let env = |key: &str| core.config.env.get(key).cloned();
    let default = crate::relay::claude_dirs::default_home(&env, &core.config.home);
    let relay_home = crate::relay::workspace::relay_home(&env, &core.config.home);
    let dirs =
        crate::relay::claude_dirs::ClaudeDirs::from_env(&env, &core.config.home, &relay_home);
    dirs.set_shared(default.to_str().unwrap(), false, &default)
        .unwrap();
    core.refresh_mobile_claude_plugin();
    assert!(!core.mobile_handoff_enabled(&alias_view));
    dirs.set_shared(default.to_str().unwrap(), true, &default)
        .unwrap();
    core.refresh_mobile_claude_plugin();
    assert!(core.mobile_handoff_enabled(&alias_view));
    assert_ne!(
        bridge.handle(4100, uid, &permission).await.unwrap()["decision"]["behavior"],
        "allow",
        "re-sharing the same login cannot revive a cached permission approval"
    );
    assert_eq!(
        bridge.handle(4100, uid, &answer).await.unwrap(),
        json!({"accepted":false})
    );
    assert!(
        matches!(
            core.previous_mobile_delivery(&alias_view, &alias_delivery, true)
                .await,
            Some(InjectOutcome::Delivered)
        ),
        "revocation retains the completed delivery receipt"
    );
    let mut fresh_delivery = delivery.clone();
    fresh_delivery.id = "after-login-reshared".into();
    assert!(matches!(
        core.deliver_mobile_owner(&alias_view, &fresh_delivery, "A newly authorized turn")
            .await,
        InjectOutcome::Waiting(_)
    ));
    let fresh_submit = bridge.handle(4100, uid, &poll).await.unwrap();
    assert_ne!(fresh_submit["control_token"], alias_submit["control_token"]);
    assert_ne!(
        bridge.handle(4100, uid, &permission).await.unwrap()["decision"]["behavior"],
        "allow",
        "a new generation cannot reuse the previous generation's cached approval"
    );

    assert!(sent
        .idempotency_key
        .as_deref()
        .unwrap()
        .starts_with("mobile-answer-"));
    let mut opt_out_delivery = delivery.clone();
    opt_out_delivery.id = "opt-out-while-suspended".into();
    assert!(matches!(
        core.deliver_mobile_owner(&alias_view, &opt_out_delivery, "Queued before opt-out")
            .await,
        InjectOutcome::Waiting(_)
    ));
    registry_ready.store(false, std::sync::atomic::Ordering::SeqCst);
    core.refresh_mobile_claude_plugin();
    assert!(matches!(
        core.previous_mobile_delivery(&alias_view, &opt_out_delivery, false)
            .await,
        Some(InjectOutcome::Waiting(_))
    ));
    let release_owner = server.hold("GET /v1/agents/owner");
    let checking = {
        let core = core.clone();
        let registration = alias_view.clone();
        let delivery = opt_out_delivery.clone();
        tokio::spawn(async move {
            core.previous_mobile_delivery(&registration, &delivery, false)
                .await
        })
    };
    server
        .wait_for("pending receipt owner verification", |server| {
            server.held("GET /v1/agents/owner") > 0
        })
        .await;
    core.store
        .update(|store| store.mobile_claude_handoff = Some(false))
        .unwrap();
    release_owner.send(true).unwrap();
    assert!(
        matches!(checking.await.unwrap(), Some(InjectOutcome::Refused(_))),
        "explicit opt-out during owner verification cancels even while discovery is suspended"
    );
    registry_ready.store(true, std::sync::atomic::Ordering::SeqCst);
    core.mobile_handoff_disabled().unwrap();
    assert_ne!(
        bridge.handle(4100, uid, &permission).await.unwrap()["decision"]["behavior"],
        "allow",
        "cached approval cannot outlive the active native generation"
    );
    assert_eq!(
        bridge.handle(4100, uid, &answer).await.unwrap(),
        json!({"accepted":false}),
        "old generation drains after opt-out"
    );
}

#[tokio::test]
async fn renamed_disabled_registration_preserves_native_receipts_and_never_falls_back_to_peer() {
    let home = tempfile::tempdir().unwrap();
    let (core, _) = Core::with_plugins(fixture_config(home.path()), Plugins::default());
    let mut registration: Registration = serde_json::from_value(json!({
        "name":"original", "agentID":"native-agent", "target":{"kind":"claude-terminal", "id":"00000000-0000-4000-8000-000000000001"},
        "baseURL":"http://localhost:9", "registeredAt":"2026-10-24T00:00:00Z"
    })).unwrap();
    let binding = Binding {
        scope: scope(&registration),
        owner: "owner-id".into(),
    };
    let runtime = Runtime {
        pid: 4100,
        start: 100,
        idle: true,
    };
    let now = crate::relay::state::now_ms();
    journal::edit(&core.config.app_data_dir, |queue| {
        queue.enqueue(binding.clone(), "completed", "already done", now)?;
        let journal::Action::Submit { lease_id, .. } = queue.poll(&binding, &runtime, now).unwrap();
        assert!(queue
            .ack(&binding, &runtime, &lease_id, true, now)
            .is_some());
        queue.enqueue(binding.clone(), "uncertain", "possibly submitted", now)?;
        queue.poll(&binding, &runtime, now).unwrap();
        queue.enqueue(binding, "queued", "not submitted", now)?;
        Ok(())
    })
    .unwrap();
    registration.alias = Some(crate::relay::store::AgentAlias {
        name: "renamed".into(),
        agent_id: "alias-agent".into(),
        token: Secret::new("at_alias"),
        registered_at: "2026-10-24T00:00:00Z".into(),
    });
    core.store
        .update(|store| {
            store.add(registration.clone(), Secret::new("at_original"));
        })
        .unwrap();
    assert!(!core.mobile_handoff_enabled(&registration));
    let delivery = |id: &str| Delivery {
        id: id.into(),
        ..Default::default()
    };
    assert!(matches!(
        core.previous_mobile_delivery(&registration, &delivery("completed"), false)
            .await,
        Some(InjectOutcome::Delivered)
    ));
    assert!(matches!(
        core.previous_mobile_delivery(&registration, &delivery("uncertain"), false)
            .await,
        Some(InjectOutcome::InDoubt(_))
    ));
    assert!(matches!(
        core.previous_mobile_delivery(&registration, &delivery("queued"), false)
            .await,
        Some(InjectOutcome::Refused(_))
    ));
    let (alias_view, alias_token) = registration.alias_credential().unwrap();
    core.retiring
        .lock()
        .unwrap()
        .insert(alias_view.name.clone(), (alias_view.clone(), alias_token));
    core.store
        .update(|store| {
            store.registrations.clear();
            store.tokens.clear();
        })
        .unwrap();
    let (retired, _) = core.agent_credential(&alias_view.name).unwrap();
    assert!(core.mobile_handoff_registration(&retired).is_none());
    for id in ["completed", "uncertain", "queued"] {
        assert!(
            matches!(
                core.previous_mobile_delivery(&retired, &delivery(id), false)
                    .await,
                Some(InjectOutcome::InDoubt(_))
            ),
            "unknown scopes never inherit success or replay {id}"
        );
    }
    assert!(core
        .previous_mobile_delivery(&retired, &delivery("never-native"), false)
        .await
        .is_none());
}

#[tokio::test]
async fn restarting_with_an_unshared_login_never_revives_tokens_or_leased_input() {
    let home = tempfile::tempdir().unwrap();
    let config = fixture_config(home.path());
    let registration: Registration = serde_json::from_value(json!({
        "name":"native", "agentID":"native-agent", "target":{"kind":"claude-terminal", "id":"00000000-0000-4000-8000-000000000001"},
        "baseURL":"http://localhost:9", "registeredAt":"2026-10-24T00:00:00Z"
    })).unwrap();
    let runtime = Runtime {
        pid: 4100,
        start: 100,
        idle: true,
    };
    let directory = Arc::new(Directory(
        DiscoveredSession {
            target: registration.target.clone(),
            title: "Claude".into(),
            directory: None,
            updated_at_ms: None,
            host: None,
            live: true,
            holder: None,
        },
        Arc::new(std::sync::Mutex::new(Some(runtime.clone()))),
        Arc::new(std::sync::atomic::AtomicBool::new(true)),
        home.path().join(".claude"),
    ));
    let plugins = || Plugins {
        sessions: directory.clone(),
        ..Plugins::default()
    };
    let (core, _) = Core::with_plugins(config.clone(), plugins());
    core.store
        .update(|store| {
            store.mobile_claude_handoff = Some(true);
            store.add(registration.clone(), Secret::new("at_native"));
        })
        .unwrap();
    core.install_mobile_claude_plugin().unwrap();
    let binding = Binding {
        scope: scope(&registration),
        owner: "owner".into(),
    };
    let old_token = journal::edit(&core.config.app_data_dir, |queue| {
        queue.enqueue(binding.clone(), "done", "completed", 0)?;
        let journal::Action::Submit {
            lease_id,
            control_token,
            ..
        } = queue.poll(&binding, &runtime, 1).unwrap();
        assert!(queue.ack(&binding, &runtime, &lease_id, true, 2).is_some());
        queue.enqueue(binding.clone(), "leased", "uncertain", 3)?;
        queue.poll(&binding, &runtime, 4).unwrap();
        queue.enqueue(binding.clone(), "queued", "unsent", 5)?;
        Ok(control_token)
    })
    .unwrap();
    drop(core);
    let env = |key: &str| config.env.get(key).cloned();
    let default = crate::relay::claude_dirs::default_home(&env, &config.home);
    let relay_home = crate::relay::workspace::relay_home(&env, &config.home);
    let dirs = crate::relay::claude_dirs::ClaudeDirs::from_env(&env, &config.home, &relay_home);
    dirs.set_shared(default.to_str().unwrap(), false, &default)
        .unwrap();
    let (restarted, _) = Core::with_plugins(config, plugins());
    assert!(!restarted.mobile_handoff_enabled(&registration));
    assert!(!restarted.mobile_handoff_control_valid(&binding, &runtime, &old_token, false));
    dirs.set_shared(default.to_str().unwrap(), true, &default)
        .unwrap();
    // Sharing alone installs nothing on an unclaimed computer.
    restarted.refresh_mobile_claude_plugin();
    assert!(!restarted.mobile_handoff_enabled(&registration));
    restarted.hub.update(|status| {
        status.spawn = Some(crate::relay::state::SpawnStatus {
            claim: Some(crate::relay::state::SpawnClaim {
                state: crate::relay::state::SpawnClaimState::Claimed,
                note: None,
            }),
            ..Default::default()
        })
    });
    restarted.refresh_mobile_claude_plugin();
    assert!(restarted.mobile_handoff_enabled(&registration));
    assert!(!restarted.mobile_handoff_control_valid(&binding, &runtime, &old_token, false));
    journal::edit(&restarted.config.app_data_dir, |queue| {
        assert_eq!(
            queue.previous(&binding.scope, "done", true, 6),
            Some(journal::Outcome::Started)
        );
        assert_eq!(
            queue.previous(&binding.scope, "leased", true, 6),
            Some(journal::Outcome::InDoubt)
        );
        assert_eq!(
            queue.previous(&binding.scope, "queued", true, 6),
            Some(journal::Outcome::Failed)
        );
        assert!(queue.poll(&binding, &runtime, 7).is_none());
        queue.enqueue(binding.clone(), "fresh", "new owner turn", 8)?;
        let journal::Action::Submit { control_token, .. } =
            queue.poll(&binding, &runtime, 9).unwrap();
        assert_ne!(control_token, old_token);
        Ok(())
    })
    .unwrap();
}

#[tokio::test]
async fn periodic_discovery_clears_published_mobile_ready_after_exit_or_process_replacement() {
    for replacement in [
        None,
        Some(Runtime {
            pid: 4101,
            start: 101,
            idle: true,
        }),
    ] {
        let server = fake_relaycast::FakeRelaycast::start(Default::default()).await;
        let agent = server.seed_agent("claude-runtime", "agent", json!({}));
        let home = tempfile::tempdir().unwrap();
        let registration: Registration = serde_json::from_value(json!({
            "name":agent.name,"agentID":agent.id,"target":{"kind":"claude-terminal","id":"00000000-0000-4000-8000-000000000002"},
            "title":"Runtime", "baseURL":server.base_url,"workspaceKey":fake_relaycast::WORKSPACE_KEY,"registeredAt":"2026-10-24T00:00:00Z"
        })).unwrap();
        let original = Runtime {
            pid: 4100,
            start: 100,
            idle: true,
        };
        let runtime = Arc::new(std::sync::Mutex::new(Some(original.clone())));
        let session = DiscoveredSession {
            target: registration.target.clone(),
            title: "Runtime".into(),
            directory: None,
            updated_at_ms: None,
            host: None,
            live: true,
            holder: None,
        };
        let (core, _) = Core::with_plugins(
            fixture_config(home.path()),
            Plugins {
                sessions: Arc::new(Directory(
                    session,
                    runtime.clone(),
                    Arc::new(std::sync::atomic::AtomicBool::new(true)),
                    home.path().join(".claude"),
                )),
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
                store.add(registration.clone(), Secret::new(agent.token.clone()));
            })
            .unwrap();
        std::thread::scope(|scope| scope.spawn(|| core.rediscover_workspace()).join().unwrap());
        core.install_mobile_claude_plugin().unwrap();
        let binding = Binding {
            scope: scope(&registration),
            owner: "previously-verified-owner".into(),
        };
        let now = crate::relay::state::now_ms();
        journal::edit(&core.config.app_data_dir, |queue| {
            queue.enqueue(binding.clone(), "finished-turn", "hello", now)?;
            let journal::Action::Submit { lease_id, .. } =
                queue.poll(&binding, &original, now).unwrap();
            assert!(queue
                .ack(&binding, &original, &lease_id, true, now)
                .is_some());
            Ok(())
        })
        .unwrap();
        assert!(core.activate_new_sessions().await.is_empty());
        core.retry_pending_cleanups().await;
        assert_eq!(
            server.agent(&agent.name).unwrap().metadata["mobile_handoff_state"],
            "ready"
        );
        *runtime.lock().unwrap() = replacement;
        assert!(core.activate_new_sessions().await.is_empty());
        assert!(core.store.read(|store| store
            .pending_name_markers
            .as_ref()
            .is_some_and(|names| names.contains(&agent.name))));
        core.retry_pending_cleanups().await;
        assert_eq!(
            server.agent(&agent.name).unwrap().metadata["mobile_handoff_state"],
            ""
        );
        assert_eq!(
            server.agent(&agent.name).unwrap().metadata["mobile_handoff_error"],
            ""
        );
        assert!(
            server.calls("GET", "/v1/agents/owner").is_empty(),
            "lifecycle pruning is entirely local"
        );
        assert!(core.activate_new_sessions().await.is_empty());
        assert!(
            core.store.read(|store| store
                .pending_name_markers
                .as_ref()
                .is_none_or(|names| !names.contains(&agent.name))),
            "stable dead runtime does not enqueue repeated metadata writes"
        );
    }
}

#[tokio::test]
async fn corrupt_or_unreadable_mobile_journal_never_blocks_unrelated_providers() {
    let home = tempfile::tempdir().unwrap();
    let (core, _) = Core::with_plugins(fixture_config(home.path()), Plugins::default());
    let mut registration: Registration = serde_json::from_value(json!({
        "name":"renamed-claude", "agentID":"native-agent", "target":{"kind":"claude-terminal", "id":"00000000-0000-4000-8000-000000000001"},
        "baseURL":"http://localhost:9", "registeredAt":"2026-10-24T00:00:00Z",
        "alias":{"name":"alias","agentID":"alias-agent","token":"at_alias","registeredAt":"2026-10-24T00:00:00Z"}
    })).unwrap();
    let delivery = Delivery {
        id: "possibly-native-before-opt-out".into(),
        ..Default::default()
    };
    let path = core
        .config
        .app_data_dir
        .join("mobile-claude-handoff/queue.json");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    for unreadable in [false, true] {
        if unreadable {
            std::fs::remove_file(&path).unwrap();
            std::fs::create_dir(&path).unwrap();
        } else {
            std::fs::write(&path, "{corrupt private journal").unwrap();
        }
        for kind in [
            SessionKind::Codex,
            SessionKind::ClaudeCloud,
            SessionKind::Pi,
            SessionKind::Grok,
            SessionKind::GrokOpen,
            SessionKind::OpenCode,
            SessionKind::OpenCodeOpen,
            SessionKind::MuseOpen,
            SessionKind::Devin,
            SessionKind::OpenClaw,
            SessionKind::Hermes,
        ] {
            registration.target.kind = kind;
            for native in [false, true] {
                assert!(
                    core.previous_mobile_delivery(&registration, &delivery, native)
                        .await
                        .is_none(),
                    "{kind:?} keeps its normal delivery path"
                );
            }
        }
        registration.target.kind = SessionKind::ClaudeTerminal;
        assert!(matches!(core.previous_mobile_delivery(&registration,&delivery,false).await,Some(InjectOutcome::Retry(_))), "renamed or opted-out Claude sessions still fail closed when their receipt cannot be read");
        if !unreadable {
            assert_eq!(
                std::fs::read_to_string(&path).unwrap(),
                "{corrupt private journal"
            );
        }
    }
}

/// A teammate's direct message reaches a session with the plugin as a user
/// turn under the owner's binding, keeps its attribution and reply hint, and
/// goes back to the peer inbox when the setting is off or the message is not
/// a direct one.
#[tokio::test]
async fn teammate_direct_messages_start_user_turns_unless_turned_off() {
    use crate::relay::delivery::session_text::InputSource;
    let server = fake_relaycast::FakeRelaycast::start(Default::default()).await;
    let owner = server.seed_agent("owner", "human", json!({}));
    let agent = server.seed_agent("claude-mobile", "agent", json!({}));
    let teammate = server.seed_agent("teammate", "agent", json!({}));
    let home = tempfile::tempdir().unwrap();
    let config = fixture_config(home.path());
    let registration: Registration = serde_json::from_value(json!({
        "name":agent.name, "agentID":agent.id, "target":{"kind":"claude-terminal", "id":"00000000-0000-4000-8000-000000000002"},
        "title":"Claude", "baseURL":server.base_url, "workspaceKey":fake_relaycast::WORKSPACE_KEY,
        "registeredAt":"2026-10-27T00:00:00Z"
    })).unwrap();
    let session = DiscoveredSession {
        target: registration.target.clone(),
        title: "Claude".into(),
        directory: None,
        updated_at_ms: None,
        host: None,
        live: true,
        holder: None,
    };
    let plugins = Plugins {
        cloud: Arc::new(SignedIn {
            base: server.base_url.clone(),
            owner: owner.id.clone(),
        }),
        sessions: Arc::new(Directory(
            session,
            Arc::new(std::sync::Mutex::new(Some(Runtime {
                pid: 4100,
                start: 100,
                idle: true,
            }))),
            Arc::new(std::sync::atomic::AtomicBool::new(true)),
            home.path().join(".claude"),
        )),
        ..Plugins::default()
    };
    let (core, _) = Core::with_plugins(config, plugins);
    core.store
        .update(|store| {
            store.cloud = Some(CloudWorkspace {
                key: Secret::new(fake_relaycast::WORKSPACE_KEY),
                base_url: server.base_url.clone(),
                ..Default::default()
            });
            store.add(registration.clone(), Secret::new(agent.token.clone()));
        })
        .unwrap();
    core.install_mobile_claude_plugin().unwrap();
    std::thread::scope(|scope| scope.spawn(|| core.rediscover_workspace()).join().unwrap());
    core.hub.update(|status| status.spawn = None);
    core.person_identity(false)
        .await
        .expect("fixture authenticated identity");
    tokio::time::timeout(Duration::from_secs(2), async {
        while core.status().spawn.is_none() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("identity sync finished");
    core.hub.update(|status| {
        status.spawn = Some(crate::relay::state::SpawnStatus {
            claim: Some(crate::relay::state::SpawnClaim {
                state: crate::relay::state::SpawnClaimState::Claimed,
                note: None,
            }),
            ..Default::default()
        })
    });
    assert!(
        core.store
            .read(|store| store.mobile_claude_handoff.is_none()),
        "nothing was turned on: both routes are on by default"
    );
    assert!(core.mobile_handoff_enabled(&registration));

    let delivery = Delivery {
        id: "teammate-delivery".into(),
        message_id: "teammate-message".into(),
        sender: Some("teammate".into()),
        sender_id: Some(teammate.id.clone()),
        reason: Some("dm".into()),
        text: Some("Please add a line to CLAUDE.md".into()),
        ..Default::default()
    };
    assert!(!core.owner_native_turn(&registration, &delivery).await);
    let bridge = Outbound::new(core.clone(), Arc::new(NoDirect));
    let uid = crate::relay::peer::current_uid();
    // Installed files alone prove nothing about a session opened before
    // them: until its plugin polls, a teammate's message takes the peer way.
    let (text, _, source) = core
        .session_text(&registration, (&delivery, None), false, false)
        .await;
    assert_eq!(source, InputSource::Peer);
    assert!(
        text.starts_with("[via Agent Relay — from @teammate"),
        "{text}"
    );
    assert_eq!(
        bridge
            .handle(4100, uid, &request("poll", json!({"version":"2.1.310"})))
            .await
            .unwrap(),
        json!({"action": null})
    );
    let (text, hint, source) = core
        .session_text(&registration, (&delivery, None), false, false)
        .await;
    assert_eq!(source, InputSource::Teammate);
    assert!(
        text.starts_with("[Agent Relay native input — from @teammate to @claude-mobile"),
        "{text}"
    );
    let _ = hint;
    assert!(text.contains("Please add a line to CLAUDE.md"));
    assert!(matches!(
        core.deliver_session_text(&registration, &delivery, text.clone(), source)
            .await,
        InjectOutcome::Waiting(_)
    ));
    let submit = bridge
        .handle(4100, uid, &request("poll", json!({"version":"2.1.310"})))
        .await
        .unwrap();
    assert_eq!(submit["action"], "submit", "{submit}");
    assert_eq!(submit["text"], text);
    assert_eq!(
        submit["forward_answer"], false,
        "a teammate's answer is not sent to the owner's phone"
    );
    // Retrying the same delivery finds its receipt, never a second turn.
    assert!(core
        .previous_mobile_delivery(&registration, &delivery, true)
        .await
        .is_some());

    // A channel post or @mention stays a peer message.
    let mut mention = delivery.clone();
    mention.id = "teammate-mention".into();
    mention.message_id = "teammate-mention-message".into();
    mention.reason = Some("mention".into());
    mention.channel_id = Some("general".into());
    let (text, _, source) = core
        .session_text(&registration, (&mention, None), false, false)
        .await;
    assert_eq!(source, InputSource::Peer);
    assert!(
        text.starts_with("[via Agent Relay — from @teammate"),
        "{text}"
    );

    // A second teammate message queued while the first is still being
    // submitted, then the setting turned off: the queued one is cancelled
    // and never handed over, and a later message is a peer message again.
    let mut queued = delivery.clone();
    queued.id = "teammate-delivery-2".into();
    queued.message_id = "teammate-message-2".into();
    let (text, _, source) = core
        .session_text(&registration, (&queued, None), false, false)
        .await;
    assert_eq!(source, InputSource::Teammate);
    assert!(matches!(
        core.deliver_session_text(&registration, &queued, text, source)
            .await,
        InjectOutcome::Waiting(_)
    ));
    core.set_store_settings(json!({"teammate_native_input": false}).as_object().unwrap())
        .unwrap();
    assert!(matches!(
        core.previous_mobile_delivery(&registration, &queued, true)
            .await,
        Some(InjectOutcome::Refused(_))
    ));
    // The message the plugin already holds a lease on is not pulled back:
    // it settles through its acknowledgement.
    assert!(core
        .previous_mobile_delivery(&registration, &delivery, true)
        .await
        .is_some_and(|outcome| matches!(outcome, InjectOutcome::Waiting(_))));
    let mut later = delivery.clone();
    later.id = "teammate-delivery-3".into();
    later.message_id = "teammate-message-3".into();
    let (text, _, source) = core
        .session_text(&registration, (&later, None), false, false)
        .await;
    assert_eq!(source, InputSource::Peer);
    assert!(
        text.starts_with("[via Agent Relay — from @teammate"),
        "{text}"
    );
}
