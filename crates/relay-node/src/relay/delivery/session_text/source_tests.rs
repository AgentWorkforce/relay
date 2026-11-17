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
        SessionKind::Grok => "grok",
        SessionKind::Devin => "devin",
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

// The owner's message to a spawned OpenCode is native either way: with
// mobile continuation on it is the plain owner turn that route takes; off,
// it is native input through the spawn route, reply context kept, never a
// peer message.
#[tokio::test]
async fn spawned_opencode_owner_is_native_with_or_without_mobile_continuation() {
    for mobile in [false, true] {
        let f = fixture(SessionKind::OpenCode, mobile).await;
        let (source, text) = deliver(&f, &f.owner).await;
        assert_eq!(
            source,
            if mobile {
                InputSource::Owner
            } else {
                InputSource::Requester
            }
        );
        assert_eq!(f.routes.owner.lock().unwrap().len(), usize::from(mobile));
        assert_eq!(
            f.routes.requester.lock().unwrap().len(),
            usize::from(!mobile)
        );
        assert!(f.routes.peer.lock().unwrap().is_empty());
        if mobile {
            assert_eq!(text, f.owner.text.clone().unwrap());
        } else {
            assert!(text.starts_with("[Agent Relay native input — from @owner"));
        }
    }
}

// The owner's direct message, from the desktop or a phone, reaches every
// spawned harness that takes native input over its own input, never as a
// peer message: a plain user turn in Codex and Claude, native input that
// keeps the reply context in the others. A reply in a thread of the DM, or
// a DM read from the delivery queue, is the same.
#[tokio::test]
async fn owner_messages_to_every_spawned_harness_are_native() {
    for kind in [
        SessionKind::Grok,
        SessionKind::Devin,
        SessionKind::OpenCode,
        SessionKind::Codex,
        SessionKind::ClaudeTerminal,
    ] {
        let threaded = |f: &Fixture| Delivery {
            id: "delivery-owner-thread".into(),
            message_id: "message-owner-thread".into(),
            reason: Some("thread-reply".into()),
            channel_id: Some("dmch_pair".into()),
            thread_id: Some("message-child".into()),
            ..f.owner.clone()
        };
        let f = fixture(kind, false).await;
        for message in [f.owner.clone(), threaded(&f)] {
            let (source, text) = deliver(&f, &message).await;
            assert_ne!(source, InputSource::Peer, "{kind:?}: {text}");
            assert!(!text.starts_with("[via Agent Relay"), "{kind:?}: {text}");
        }
        assert!(f.routes.peer.lock().unwrap().is_empty(), "{kind:?}");
    }
}

// A requester or owner of a spawned agent the person took over is a peer
// again, like everyone else.
#[tokio::test]
async fn a_taken_over_spawn_takes_no_native_input_from_the_owner_route() {
    let mut f = fixture(SessionKind::Grok, false).await;
    f.registration.spawn.as_mut().unwrap().taken_over_at = Some("2026-11-12T00:00:00Z".into());
    assert_eq!(deliver(&f, &f.owner).await.0, InputSource::Peer);
    assert_eq!(f.routes.peer.lock().unwrap().len(), 1);
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

// Cloud invokes a spawn for a person's chat through a launcher: a direct
// message from either immutable id is the requester's, and a name alone is
// neither.
#[tokio::test]
async fn the_launcher_and_the_desktop_requester_both_count_as_the_requester() {
    use crate::relay::delivery::policy::owner_framed;
    let mut f = fixture(SessionKind::Codex, false).await;
    f.registration.spawn.as_mut().unwrap().launcher = Some(crate::relay::store::SpawnRequester {
        name: "launcher-person".into(),
        agent_id: "agent_launcher".into(),
    });
    let registration = f.registration.clone();
    f.core
        .store
        .update(|store| {
            for saved in store
                .registrations
                .iter_mut()
                .filter(|saved| saved.agent_id == registration.agent_id)
            {
                *saved = registration.clone();
            }
        })
        .unwrap();
    let message = |id: &str, name: &str, sender_id: &str| Delivery {
        id: format!("delivery-{id}"),
        message_id: format!("message-{id}"),
        sender: Some(name.into()),
        sender_id: Some(sender_id.into()),
        ..f.requester.clone()
    };
    let launcher = message("launcher", "launcher-person", "agent_launcher");
    let requester = f.requester.clone();
    assert_eq!(deliver(&f, &launcher).await.0, InputSource::Requester);
    assert_eq!(deliver(&f, &requester).await.0, InputSource::Requester);
    assert_eq!(f.routes.requester.lock().unwrap().len(), 2);

    // Without native input, both carry the owner line as peers.
    f.core
        .store
        .update(|store| store.extras.spawn_native_input = Some(false))
        .unwrap();
    for (id, from) in [("launcher-2", &launcher), ("requester-2", &requester)] {
        let again = message(
            id,
            from.sender.as_deref().unwrap(),
            from.sender_id.as_deref().unwrap(),
        );
        let (source, text) = deliver(&f, &again).await;
        assert_eq!(source, InputSource::Peer, "{text}");
        assert!(owner_framed(&text), "{text}");
    }
    // The launcher's name with another id is a peer, with no owner line.
    let impostor = message("impostor", "launcher-person", "agent_impostor");
    let (source, text) = deliver(&f, &impostor).await;
    assert_eq!(source, InputSource::Peer);
    assert!(!owner_framed(&text), "{text}");
    assert_eq!(f.routes.requester.lock().unwrap().len(), 2);
}

/// Seeds a leader agent `@lead` that the workspace lists as `gtmgrok`, and
/// a direct message from it.
fn leader(f: &Fixture) -> Delivery {
    let lead = f._server.seed_agent("lead", "agent", json!({}));
    f._server.set_leaders(Some(json!({
        "leaders":[{"name":"gtmgrok","agent_id":lead.id}],
        "patterns":["*grok","admin"]
    })));
    Delivery {
        id: "delivery-lead".into(),
        message_id: "message-lead".into(),
        sender: Some("lead".into()),
        sender_id: Some(lead.id),
        reason: Some("dm".into()),
        text: Some("Ship the fix".into()),
        ..Default::default()
    }
}

fn again(delivery: &Delivery, id: &str) -> Delivery {
    Delivery {
        id: format!("delivery-{id}"),
        message_id: format!("message-{id}"),
        ..delivery.clone()
    }
}

/// `f`'s session as the person started it: no spawn record.
fn person_started(f: &mut Fixture) {
    f.registration.spawn = None;
    let registration = f.registration.clone();
    f.core
        .store
        .update(|store| {
            for saved in store
                .registrations
                .iter_mut()
                .filter(|saved| saved.agent_id == registration.agent_id)
            {
                *saved = registration.clone();
            }
        })
        .unwrap();
}

fn leads(text: &str) -> bool {
    text.split('\n').nth(1) == Some(super::super::policy::leader_line("gtmgrok").as_str())
}

// A leader's direct message to a spawned agent is native input on the
// spawn route, whatever `spawn_native_input` says, with the leader line
// naming it as the leaders list does (not as the message does). It answers
// no approval.
#[tokio::test]
async fn a_leaders_dm_to_a_spawned_agent_is_native_input_naming_the_leader() {
    for kind in [
        SessionKind::OpenCode,
        SessionKind::Codex,
        SessionKind::ClaudeTerminal,
    ] {
        let f = fixture(kind, false).await;
        f.core
            .store
            .update(|store| store.extras.spawn_native_input = Some(false))
            .unwrap();
        let lead = leader(&f);
        let (source, text) = deliver(&f, &lead).await;
        assert_eq!(source, InputSource::Leader, "{kind:?}: {text}");
        assert!(
            text.starts_with("[Agent Relay native input — from @lead"),
            "{text}"
        );
        assert!(leads(&text), "{text}");
        assert!(
            text.contains("\n[leader: @gtmgrok leads this work; "),
            "{text}"
        );
        assert!(!crate::relay::delivery::policy::owner_framed(&text));
        assert!(text.contains("\n\nShip the fix\n"), "{text}");
        assert_eq!(f.routes.requester.lock().unwrap().len(), 1, "{kind:?}");
        assert!(f.routes.peer.lock().unwrap().is_empty());
        assert!(f.routes.owner.lock().unwrap().is_empty());
        for reply in [
            "approve 0123456789abcdef",
            "deny 0123456789abcdef",
            "approve cxm-0123456789abcdef",
            "choose 2 0123456789abcdef",
        ] {
            let mut approval = again(&lead, "lead-approval");
            approval.text = Some(reply.into());
            assert!(
                matches!(
                    f.core.owner_reply(&f.registration, &approval).await,
                    OwnerReply::NotOne
                ),
                "a leader never answers an approval: {reply}"
            );
        }
    }
}

// A session the person started, or a spawn the person took over, takes a
// leader's direct message as native input too, on its usual route.
#[tokio::test]
async fn a_session_the_person_started_takes_a_leaders_dm_as_native_input() {
    for kind in [SessionKind::Codex, SessionKind::ClaudeTerminal] {
        let mut f = fixture(kind, false).await;
        person_started(&mut f);
        let lead = leader(&f);
        let (source, text) = deliver(&f, &lead).await;
        assert_eq!(source, InputSource::Leader, "{kind:?}: {text}");
        assert!(leads(&text), "{text}");
        assert_eq!(f.routes.peer.lock().unwrap().as_slice(), [text]);
        assert!(f.routes.requester.lock().unwrap().is_empty());
    }
    let mut f = fixture(SessionKind::Grok, false).await;
    f.registration.spawn.as_mut().unwrap().taken_over_at = Some("2026-11-12T00:00:00Z".into());
    let (source, text) = deliver(&f, &leader(&f)).await;
    assert_eq!(source, InputSource::Leader);
    assert!(leads(&text), "{text}");
}

// Leaders are matched by agent id alone: another agent with a leader's
// name, or with its name in the list, is a peer. A leader's channel post or
// mention stays a peer message.
#[tokio::test]
async fn only_a_leaders_own_direct_message_is_a_leaders() {
    let mut f = fixture(SessionKind::Codex, false).await;
    person_started(&mut f);
    let lead = leader(&f);
    for name in ["gtmgrok", "lead"] {
        let mut impostor = again(&lead, &format!("impostor-{name}"));
        impostor.sender = Some(name.into());
        impostor.sender_id = Some("agent_impostor".into());
        let (source, text) = deliver(&f, &impostor).await;
        assert_eq!(source, InputSource::Peer, "{text}");
        assert!(text.starts_with("[via Agent Relay"), "{text}");
        assert!(!text.contains("leads this work"), "{text}");
    }
    for (reason, channel) in [("mention", "chan_general"), ("dm", "group_three")] {
        let mut post = again(&lead, &format!("post-{reason}"));
        post.reason = Some(reason.into());
        post.channel_id = Some(channel.into());
        let (source, text) = deliver(&f, &post).await;
        assert_eq!(source, InputSource::Peer, "{text}");
        assert!(!text.contains("leads this work"), "{text}");
    }
    // A reply in the thread of the direct message is the leader's.
    let mut threaded = again(&lead, "lead-thread");
    threaded.reason = Some("thread-reply".into());
    threaded.channel_id = Some("dmch_pair".into());
    threaded.thread_id = Some("message-child".into());
    assert_eq!(deliver(&f, &threaded).await.0, InputSource::Leader);
}

// The list is read once and used while fresh; a stale one is read again on
// the next lookup, and a read that fails keeps the last list. `settings`
// shows it, read only.
#[tokio::test]
async fn the_leaders_list_is_cached_refreshed_and_kept_through_a_failed_read() {
    let mut f = fixture(SessionKind::Codex, false).await;
    person_started(&mut f);
    let reads = |f: &Fixture| f._server.calls("GET", "/v1/workspace/leaders").len();
    let lead = leader(&f);
    assert_eq!(deliver(&f, &lead).await.0, InputSource::Leader);
    assert_eq!(
        deliver(&f, &again(&lead, "two")).await.0,
        InputSource::Leader
    );
    assert_eq!(reads(&f), 1, "a fresh list is not read again");
    let shown = f.core.settings()["workspace_leaders"].clone();
    assert_eq!(shown["leaders"][0]["name"], "gtmgrok");
    assert_eq!(shown["patterns"], json!(["*grok", "admin"]));
    assert_eq!(reads(&f), 1);

    f.core.leaders.age(crate::relay::leaders::REFRESH_AFTER);
    f._server.set_failing(&["GET /v1/workspace/leaders"]);
    assert_eq!(
        deliver(&f, &again(&lead, "three")).await.0,
        InputSource::Leader
    );
    // The SDK retries a 503, so a failed read can be several requests.
    let failed = reads(&f);
    assert!(failed > 1, "a stale list is read again");
    assert_eq!(f.core.settings()["workspace_leaders"], shown);
    assert_eq!(reads(&f), failed, "a failed read counts as a read");

    f._server.set_failing(&[]);
    f._server
        .set_leaders(Some(json!({"leaders":[],"patterns":[]})));
    f.core.leaders.age(crate::relay::leaders::REFRESH_AFTER);
    assert_eq!(
        deliver(&f, &again(&lead, "four")).await.0,
        InputSource::Peer
    );
    assert_eq!(reads(&f), failed + 1);
    assert_eq!(
        f.core.settings()["workspace_leaders"],
        json!({"leaders":[],"patterns":[]})
    );
}
