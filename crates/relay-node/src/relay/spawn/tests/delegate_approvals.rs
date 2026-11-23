//! With **Approvals from the owner's delegates** on (`spawn_delegate_approvals`,
//! on unless the person turns it off) and `delegated_approvals_from` not
//! `off`, a delegate of the machine owner answers a spawned session's open
//! approvable request with `approve <ref>` / `deny <ref>` when Agent Relay
//! Cloud attests its owner approval as exactly one `prompt_approval` of that
//! session and request, with the owner's own standing. Modelled on
//! `leader_approvals.rs`; Cloud is mocked (its PR is parallel).

use super::*;
use crate::relay::codex::app_server::drive as codex_drive;
use crate::relay::delegation::test_support::Signer;
use crate::relay::delivery::policy::{Delivery, MessageRef};
use crate::relay::harness::claude::requests;
use crate::relay::spawn::drive::OwnerReply;
use crate::relay::spawn::launch::SpawnedProcess;
use crate::relay::store::{CloudWorkspace, SpawnRequester};
use crate::relay::workspace::Secret;
use futures_util::future::BoxFuture;

#[path = "../../../../tests/support/fake_relaycast.rs"]
mod fake_relaycast;

use fake_relaycast::{FakeRelaycast, WORKSPACE_KEY};

const KID: &str = "k-test";
const WS: &str = "cloud-workspace";

/// Agent Relay Cloud, signed in: it attests with `signer` the claims the
/// test sets, names the delegates the test sets, and records every call.
struct Cloud {
    base: String,
    owner: String,
    signer: Signer,
    claims: Mutex<Option<Value>>,
    /// The signed-in person's Cloud human id; `None` when unknown.
    user_id: Mutex<Option<String>>,
    delegates: Mutex<Value>,
    calls: Mutex<Vec<(String, Value)>>,
    /// How many of the next `prompt-delegates` calls fail.
    discovery_failures: std::sync::atomic::AtomicUsize,
    /// `prompt-delegates` calls so far, and those answered.
    discoveries: std::sync::atomic::AtomicUsize,
    answered: std::sync::atomic::AtomicUsize,
    /// Holds the `prompt-delegates` call with this number (1-based): it
    /// signals `reached`, then waits for `release`.
    gate: Mutex<Option<(usize, Arc<tokio::sync::Notify>, Arc<tokio::sync::Notify>)>>,
}

impl crate::relay::cloud_session::CloudAccess for Cloud {
    fn account(&self) -> Option<crate::relay::cloud_session::CloudAccount> {
        Some(crate::relay::cloud_session::CloudAccount {
            site_url: self.base.clone(),
            workspace_id: WS.into(),
            user_id: self.user_id.lock().unwrap().clone(),
        })
    }
    fn agent_owner(&self) -> Option<crate::relay::cloud_session::AgentOwner> {
        Some(crate::relay::cloud_session::AgentOwner {
            user_id: "person".into(),
            workspace_id: Some(WS.into()),
        })
    }
    fn request(
        &self,
        _: &'static str,
        path: String,
        body: Option<Value>,
    ) -> BoxFuture<'_, Result<Value, crate::relay::cloud_session::CloudError>> {
        let body = body.unwrap_or_default();
        self.calls
            .lock()
            .unwrap()
            .push((path.clone(), body.clone()));
        Box::pin(async move {
            use std::sync::atomic::Ordering::SeqCst;
            if path.ends_with("/messaging/delegation/prompt-delegates") {
                let call = self.discoveries.fetch_add(1, SeqCst) + 1;
                let gate = self.gate.lock().unwrap().clone();
                if let Some((at, reached, release)) = gate.filter(|(at, ..)| *at == call) {
                    let _ = at;
                    reached.notify_one();
                    release.notified().await;
                }
                let failing = self
                    .discovery_failures
                    .fetch_update(SeqCst, SeqCst, |n| n.checked_sub(1))
                    .is_ok();
                let answer = self.delegates.lock().unwrap().clone();
                self.answered.fetch_add(1, SeqCst);
                return match failing {
                    true => Err(crate::relay::cloud_session::CloudError::Unreachable),
                    false => Ok(answer),
                };
            }
            Ok(if path.ends_with("/messaging/identity/credential") {
                json!({"identity":{"name":"owner","agentId":self.owner,"token":"at_owner","relaycastUrl":self.base}})
            } else if path.ends_with("/messaging/delegation") {
                match self.claims.lock().unwrap().clone() {
                    Some(mut claims) => {
                        // Bound to the message asked about, as Cloud binds it.
                        if claims["message_id"].is_null() {
                            claims["message_id"] = body["message_id"].clone();
                        }
                        json!({"verdict": "delegate", "attestation": self.signer.sign(KID, &claims)})
                    }
                    None => json!({"verdict": "none", "reason": "not_delegate"}),
                }
            } else if path.ends_with("/messaging/delegation/prompt-delegates") {
                self.delegates.lock().unwrap().clone()
            } else {
                Value::Null
            })
        })
    }
}

struct Fixture {
    _home: tempfile::TempDir,
    server: FakeRelaycast,
    core: Arc<Core>,
    cloud: Arc<Cloud>,
    owner: fake_relaycast::Agent,
    requester: fake_relaycast::Agent,
    delegate: fake_relaycast::Agent,
    child: fake_relaycast::Agent,
}

async fn fixture() -> Fixture {
    let server = FakeRelaycast::start(Default::default()).await;
    let owner = server.seed_agent("owner", "human", json!({}));
    let requester = server.seed_agent("spawner", "agent", json!({}));
    let delegate = server.seed_agent("assistant", "agent", json!({}));
    let child = server.seed_agent("c1", "agent", json!({}));
    // Their 1:1 conversation, with just the two of them.
    server.seed_conversation("assistant", "c1");
    let home = tempfile::tempdir().unwrap();
    let spawner = Arc::new(FakeSpawner {
        native: true,
        ..FakeSpawner::default()
    });
    let config = crate::relay::daemon::Config {
        paths: crate::relay::paths::CorePaths::for_socket(home.path().join("core.sock")).unwrap(),
        home: home.path().into(),
        app_data_dir: home.path().join("app-data"),
        env: Default::default(),
        version: "0.0.0-test".into(),
        host_name: "Test Desk.local".into(),
        rediscover_every: Duration::from_secs(3600),
        push_timing: Default::default(),
        delivery_timing: Default::default(),
    };
    let cloud = Arc::new(Cloud {
        base: server.base_url.clone(),
        owner: owner.id.clone(),
        signer: Signer::new(),
        claims: Mutex::new(None),
        user_id: Mutex::new(Some("hum_owner".into())),
        delegates: Mutex::new(json!({"delegates": []})),
        calls: Mutex::new(Vec::new()),
        discovery_failures: Default::default(),
        discoveries: Default::default(),
        answered: Default::default(),
        gate: Mutex::new(None),
    });
    let (core, _signals) = Core::with_plugins(
        config,
        crate::relay::daemon::Plugins {
            account: Some(crate::relay::test_account::TestAccount::new().into_plugin()),
            cloud: cloud.clone(),
            spawner: spawner.clone(),
            ..crate::relay::daemon::Plugins::default()
        },
    );
    let jwks = json!({"keys": [cloud.signer.jwk(KID)]});
    core.delegation_keys.set_fetch(Arc::new(move || {
        let jwks = jwks.clone();
        Box::pin(async move { Some(jwks) })
    }));
    core.store
        .update(|store| {
            store.cloud = Some(CloudWorkspace {
                key: Secret::new(WORKSPACE_KEY),
                base_url: server.base_url.clone(),
                workspace_id: Some("rw_delegates".into()),
                ..Default::default()
            });
            store.accept_spawns = Some(false);
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
        status.spawn.as_mut().unwrap().claim = Some(crate::relay::state::SpawnClaim {
            state: crate::relay::state::SpawnClaimState::Claimed,
            note: None,
        })
    });
    Fixture {
        _home: home,
        server,
        core,
        cloud,
        owner,
        requester,
        delegate,
        child,
    }
}

impl Fixture {
    /// `c1`, spawned here by `spawner` with `harness` on `session`, and saved.
    fn spawned(&self, harness: &str, session: &str) -> Registration {
        let kind = if harness == "claude" {
            "claude-terminal"
        } else {
            "codex"
        };
        let mut registration: Registration = serde_json::from_value(json!({
            "name": self.child.name, "agentID": self.child.id,
            "target": {"kind": kind, "id": session},
            "title": "c1", "baseURL": self.server.base_url, "workspaceKey": WORKSPACE_KEY,
            "registeredAt": "2026-10-28T00:00:00Z",
            "spawn": {"nodeID": "node-1", "nodeName": "desk", "invocationID": "inv_c1", "harness": harness}
        }))
        .unwrap();
        let spawn = registration.spawn.as_mut().unwrap();
        spawn.requester = Some(SpawnRequester {
            name: self.requester.name.clone(),
            agent_id: self.requester.id.clone(),
        });
        spawn.process = Some(SpawnedProcess {
            pid: 4242,
            start: 7,
        });
        let token = Secret::new(self.child.token.clone());
        self.core
            .store
            .update(|store| store.add(registration.clone(), token))
            .unwrap();
        registration
    }

    fn token(&self) -> Secret {
        Secret::new(self.child.token.clone())
    }

    /// Cloud attests, from now on, a `prompt_approval` with `target`.
    fn attests(&self, target: &str) {
        self.attests_claims(self.claims(target));
    }

    fn attests_claims(&self, claims: Value) {
        *self.cloud.claims.lock().unwrap() = Some(claims);
    }

    fn claims(&self, target: &str) -> Value {
        let now = crate::relay::state::now_ms() / 1000;
        json!({
            "v": 1, "ws": WS, "owner_id": "hum_owner", "owner_display": "Ada Owner",
            "delegate_agent_id": self.delegate.id, "grant_id": "grt_1",
            "message_id": null, "recipient_agent_id": self.child.id,
            "approval_id": "apv_7Q2abcdEF", "tier": "D",
            "actions": [{"class": "prompt_approval", "target": target}],
            "standing": "own_owner", "single_use": false,
            "iat": now, "exp": now + 300, "jti": "jti_1"
        })
    }

    fn attestation_calls(&self) -> usize {
        self.cloud
            .calls
            .lock()
            .unwrap()
            .iter()
            .filter(|(path, _)| path.ends_with("/messaging/delegation"))
            .count()
    }

    fn set(&self, delegates: Option<bool>, from: Option<&str>) {
        self.core
            .store
            .update(|store| {
                store.extras.spawn_delegate_approvals = delegates;
                store.extras.delegated_approvals_from = from.map(str::to_string);
            })
            .unwrap();
    }

    fn by_delegate(&self) -> String {
        format!(
            "the delegate @assistant ({}) of Ada Owner, grant grt_1",
            self.delegate.id
        )
    }
}

/// `sender`'s 1:1 DM `text`, carrying an owner approval.
fn approval_dm(id: &str, sender: &fake_relaycast::Agent, text: &str) -> Delivery {
    Delivery {
        id: format!("d-{id}"),
        message_id: format!("m-{id}"),
        sender: Some(sender.name.clone()),
        sender_id: Some(sender.id.clone()),
        reason: Some("dm".into()),
        text: Some(text.into()),
        has_owner_approval: true,
        ..Delivery::default()
    }
}

fn codex_opened(thread: &str, request: Value) -> codex_drive::Notice {
    let before: Vec<String> = codex_drive::unforwarded(thread)
        .into_iter()
        .map(|notice| notice.reference)
        .collect();
    codex_drive::open_request(thread, request);
    codex_drive::unforwarded(thread)
        .into_iter()
        .find(|notice| !before.contains(&notice.reference))
        .unwrap()
}

fn codex_request(thread: &str, id: u64) -> codex_drive::Notice {
    codex_opened(
        thread,
        json!({"id": id, "method": "item/commandExecution/requestApproval",
            "params": {"threadId": thread, "command": "cargo test"}}),
    )
}

fn claude_request(session: &str, request_id: &str) -> requests::Notice {
    let request = json!({"type": "control_request", "request_id": request_id, "request": {
        "subtype": "can_use_tool", "tool_name": "Bash", "input": {"command": "ls"}}});
    let before: Vec<String> = requests::unforwarded(session)
        .into_iter()
        .map(|notice| notice.reference)
        .collect();
    assert_eq!(requests::register(session, &request), None);
    requests::unforwarded(session)
        .into_iter()
        .find(|notice| !before.contains(&notice.reference))
        .unwrap()
}

fn settled(reply: OwnerReply) -> String {
    match reply {
        OwnerReply::Settled(detail) => detail,
        OwnerReply::NotOne => panic!("not taken as a reply"),
        OwnerReply::Unsaved => panic!("not saved"),
    }
}

fn not_one(reply: OwnerReply) -> bool {
    matches!(reply, OwnerReply::NotOne)
}

#[tokio::test]
async fn a_delegate_approves_and_denies_codex_and_claude_by_default() {
    let f = fixture().await;
    const THREAD: &str = "01a1235e-70e1-7cb1-8619-e2c8bf3be001";
    let codex = f.spawned("codex", THREAD);
    let first = codex_request(THREAD, 901);
    f.attests(&format!("{}:{}:approve", f.child.id, first.reference));
    let approve = approval_dm(
        "approve",
        &f.delegate,
        &format!("approve {}", first.reference),
    );
    let detail = settled(f.core.owner_reply(&codex, &approve).await);
    assert_eq!(
        detail,
        format!("Codex approval reply from {}: Answered", f.by_delegate())
    );
    assert!(!detail.contains("machine owner"), "{detail}");
    let answer = codex_drive::recorded_answer(&first.reference).unwrap();
    assert_eq!(answer["decision"], "accept", "{answer}");
    let (_, body) = f.cloud.calls.lock().unwrap()[1].clone();
    assert_eq!(body["recipient_agent_id"], f.child.id.as_str());
    assert_eq!(body["message_id"], "m-approve");
    assert_eq!(body["accept"], "code_owners");

    let second = codex_request(THREAD, 902);
    f.attests(&format!("{}:{}:deny", f.child.id, second.reference));
    let deny = approval_dm("deny", &f.delegate, &format!("deny {}", second.reference));
    assert!(settled(f.core.owner_reply(&codex, &deny).await).ends_with("Answered"));
    let answer = codex_drive::recorded_answer(&second.reference).unwrap();
    assert_eq!(answer["decision"], "decline", "{answer}");

    const SESSION: &str = "a1d0c2e4-0000-4000-8000-00000000e001";
    let claude = f.spawned("claude", SESSION);
    let notice = claude_request(SESSION, "d1");
    f.attests(&format!("{}:{}:approve", f.child.id, notice.reference));
    let approve = approval_dm(
        "claude",
        &f.delegate,
        &format!("approve {}", notice.reference),
    );
    assert_eq!(
        settled(f.core.owner_reply(&claude, &approve).await),
        format!("Claude approval reply from {}: Answered", f.by_delegate())
    );
    assert!(requests::due(SESSION)
        .iter()
        .any(|(_, line)| line.contains(r#""behavior":"allow""#)));
    requests::forget(SESSION);
}

#[tokio::test]
async fn an_attestation_for_anything_else_answers_nothing() {
    let f = fixture().await;
    const THREAD: &str = "01a1235e-70e1-7cb1-8619-e2c8bf3be002";
    let registration = f.spawned("codex", THREAD);
    let notice = codex_request(THREAD, 911);
    let other = codex_request(THREAD, 912);
    let text = format!("approve {}", notice.reference);
    let exact = format!("{}:{}:approve", f.child.id, notice.reference);
    let mut cases = vec![
        // Another request, another session, a wildcard.
        f.claims(&format!("{}:{}:approve", f.child.id, other.reference)),
        f.claims(&format!("agent_other:{}:approve", notice.reference)),
        f.claims(&format!("{}:*", f.child.id)),
    ];
    // A code owner's standing never answers a prompt.
    let mut code_owner = f.claims(&exact);
    code_owner["standing"] = json!("code_owner");
    cases.push(code_owner);
    // Another class, or a second action.
    let mut merge = f.claims(&exact);
    merge["actions"] = json!([{"class": "merge", "target": "o/r#1"}]);
    cases.push(merge);
    let mut two = f.claims(&exact);
    two["actions"] = json!([{"class": "prompt_approval", "target": exact},
        {"class": "prompt_approval", "target": format!("{}:{}:approve", f.child.id, other.reference)}]);
    cases.push(two);
    // A not_before that has not passed.
    let mut later = f.claims(&exact);
    later["actions"] = json!([{"class": "prompt_approval", "target": exact,
        "conditions": [{"type": "not_before", "at": "2999-01-01T00:00:00Z"}]}]);
    cases.push(later);
    for (index, claims) in cases.into_iter().enumerate() {
        f.attests_claims(claims);
        let reply = approval_dm(&format!("bad-{index}"), &f.delegate, &text);
        assert!(
            not_one(f.core.owner_reply(&registration, &reply).await),
            "{index}"
        );
    }
    // Cloud's refusal.
    *f.cloud.claims.lock().unwrap() = None;
    let reply = approval_dm("none", &f.delegate, &text);
    assert!(not_one(f.core.owner_reply(&registration, &reply).await));
    assert!(codex_drive::has_pending(THREAD, &notice.reference));
    // A prompt approval takes no conditions, not even one that has passed.
    let mut passed = f.claims(&exact);
    passed["actions"] = json!([{"class": "prompt_approval", "target": exact,
        "conditions": [{"type": "not_before", "at": "2020-01-01T00:00:00Z"}]}]);
    f.attests_claims(passed);
    let reply = approval_dm("passed", &f.delegate, &text);
    assert!(not_one(f.core.owner_reply(&registration, &reply).await));
    // The decision is bound in the target: an `approve` reply under a
    // `:deny` target answers nothing, and the reverse.
    f.attests(&format!("{}:{}:deny", f.child.id, notice.reference));
    let reply = approval_dm("mismatch", &f.delegate, &text);
    assert!(not_one(f.core.owner_reply(&registration, &reply).await));
    let deny = approval_dm(
        "mismatch-deny",
        &f.delegate,
        &format!("deny {}", notice.reference),
    );
    f.attests(&exact);
    assert!(not_one(f.core.owner_reply(&registration, &deny).await));
    // The bare `<agent>:<ref>` form of the earlier contract answers nothing.
    f.attests(&format!("{}:{}", f.child.id, notice.reference));
    assert!(not_one(
        f.core
            .owner_reply(&registration, &approval_dm("bare", &f.delegate, &text))
            .await
    ));
    assert!(codex_drive::has_pending(THREAD, &notice.reference));
    // The matching verb answers.
    f.attests(&format!("{}:{}:deny", f.child.id, notice.reference));
    assert!(settled(f.core.owner_reply(&registration, &deny).await).ends_with("Answered"));
}

#[tokio::test]
async fn without_an_owner_approval_or_with_a_setting_off_cloud_is_never_asked() {
    let f = fixture().await;
    const THREAD: &str = "01a1235e-70e1-7cb1-8619-e2c8bf3be003";
    let registration = f.spawned("codex", THREAD);
    let notice = codex_request(THREAD, 921);
    let text = format!("approve {}", notice.reference);
    f.attests(&format!("{}:{}:approve", f.child.id, notice.reference));
    let mut plain = approval_dm("plain", &f.delegate, &text);
    plain.has_owner_approval = false;
    assert!(not_one(f.core.owner_reply(&registration, &plain).await));
    for (index, (delegates, from)) in [(Some(false), None), (None, Some("off"))]
        .into_iter()
        .enumerate()
    {
        f.set(delegates, from);
        let reply = approval_dm(&format!("off-{index}"), &f.delegate, &text);
        assert!(not_one(f.core.owner_reply(&registration, &reply).await));
    }
    assert_eq!(f.attestation_calls(), 0);
    // Independent of leader approvals and native input from spawning agents.
    f.set(Some(true), Some("own_owner"));
    f.core
        .store
        .update(|store| {
            store.extras.spawn_native_input = Some(false);
            store.extras.spawn_leader_approvals = Some(false);
        })
        .unwrap();
    let reply = approval_dm("on", &f.delegate, &text);
    assert!(settled(f.core.owner_reply(&registration, &reply).await).ends_with("Answered"));
}

#[tokio::test]
async fn a_delegate_answers_extra_permissions_but_choices_and_dialogs_stay_with_the_owner() {
    let f = fixture().await;
    const THREAD: &str = "01a1235e-70e1-7cb1-8619-e2c8bf3be004";
    let registration = f.spawned("codex", THREAD);
    let permissions = codex_opened(
        THREAD,
        json!({"id": 931, "method": "item/permissions/requestApproval",
            "params": {"threadId": THREAD, "permissions": {"network": true}}}),
    );
    assert!(permissions.approvable);
    f.attests(&format!("{}:{}:approve", f.child.id, permissions.reference));
    let reply = approval_dm(
        "perm",
        &f.delegate,
        &format!("approve {}", permissions.reference),
    );
    // Permissions are delegable: a Codex extra-permission request is answered.
    assert_eq!(
        settled(f.core.owner_reply(&registration, &reply).await),
        format!("Codex approval reply from {}: Answered", f.by_delegate())
    );
    let answer = codex_drive::recorded_answer(&permissions.reference).unwrap();
    assert_eq!(answer["permissions"]["network"], true, "{answer}");

    let question = codex_opened(
        THREAD,
        json!({"id": 932, "method": "item/tool/requestUserInput", "params": {
            "threadId": THREAD,
            "questions": [{"id": "decision", "header": "Confirm", "question": "Install?",
                "options": [{"label": "Install", "description": "Proceed"},
                    {"label": "Cancel", "description": "Stop"}]}]
        }}),
    );
    f.attests(&format!("{}:{}:approve", f.child.id, question.reference));
    for (id, text) in [
        ("choose", format!("choose {} 1", question.reference)),
        ("approve-q", format!("approve {}", question.reference)),
    ] {
        let reply = approval_dm(id, &f.delegate, &text);
        assert!(
            not_one(f.core.owner_reply(&registration, &reply).await),
            "{id}"
        );
    }
    assert!(codex_drive::has_pending(THREAD, &question.reference));
}

#[tokio::test]
async fn never_the_session_its_spawner_or_a_session_taken_over() {
    let f = fixture().await;
    const THREAD: &str = "01a1235e-70e1-7cb1-8619-e2c8bf3be005";
    let registration = f.spawned("codex", THREAD);
    let notice = codex_request(THREAD, 941);
    let text = format!("approve {}", notice.reference);
    let mut own = f.claims(&format!("{}:{}:approve", f.child.id, notice.reference));
    own["delegate_agent_id"] = json!(f.child.id);
    f.attests_claims(own);
    assert!(not_one(
        f.core
            .owner_reply(&registration, &approval_dm("self", &f.child, &text))
            .await
    ));
    let mut spawner = f.claims(&format!("{}:{}:approve", f.child.id, notice.reference));
    spawner["delegate_agent_id"] = json!(f.requester.id);
    f.attests_claims(spawner);
    f.core
        .store
        .update(|store| store.extras.spawn_requester_approvals = Some(false))
        .unwrap();
    assert!(not_one(
        f.core
            .owner_reply(&registration, &approval_dm("spawner", &f.requester, &text))
            .await
    ));
    f.attests(&format!("{}:{}:approve", f.child.id, notice.reference));
    let mut taken_over = registration.clone();
    taken_over.spawn.as_mut().unwrap().taken_over_at = Some("2026-10-28T01:00:00Z".into());
    assert!(not_one(
        f.core
            .owner_reply(&taken_over, &approval_dm("taken", &f.delegate, &text))
            .await
    ));
    assert!(codex_drive::has_pending(THREAD, &notice.reference));
}

#[tokio::test]
async fn the_first_answer_counts_between_owner_and_delegate() {
    let f = fixture().await;
    const THREAD: &str = "01a1235e-70e1-7cb1-8619-e2c8bf3be006";
    let registration = f.spawned("codex", THREAD);
    let notice = codex_request(THREAD, 951);
    let text = format!("approve {}", notice.reference);
    f.attests(&format!("{}:{}:approve", f.child.id, notice.reference));
    assert!(settled(
        f.core
            .owner_reply(&registration, &approval_dm("first", &f.delegate, &text))
            .await
    )
    .ends_with("Answered"));
    let owner = Delivery {
        has_owner_approval: false,
        ..approval_dm("second", &f.owner, &text)
    };
    assert_eq!(
        settled(f.core.owner_reply(&registration, &owner).await),
        "Codex approval reply from the machine owner: Unknown"
    );
}

#[tokio::test]
async fn the_delegates_cloud_names_get_the_notice_with_how_to_answer() {
    let f = fixture().await;
    *f.cloud.delegates.lock().unwrap() = json!({"delegates": [
        {"agent_id": f.delegate.id, "grant_id": "grt_1"},
        // The session and its spawner never get a delegate's copy.
        {"agent_id": f.child.id, "grant_id": "grt_2"},
        {"agent_id": f.requester.id, "grant_id": "grt_3"},
        {"agent_id": "agent_gone", "grant_id": "grt_4"}
    ]});
    const THREAD: &str = "01a1235e-70e1-7cb1-8619-e2c8bf3be007";
    let registration = f.spawned("codex", THREAD);
    let notice = codex_request(THREAD, 961);
    f.core
        .forward_to_owner(&registration, &f.token(), &notice)
        .await;
    f.server
        .wait_for("the delegate's copy", |server| {
            server
                .calls("POST", "/v1/dm")
                .iter()
                .any(|call| call.body["to"] == "assistant")
        })
        .await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let dms = f.server.calls("POST", "/v1/dm");
    let to: Vec<&str> = dms
        .iter()
        .filter_map(|call| call.body["to"].as_str())
        .collect();
    assert_eq!(
        to.iter().filter(|to| **to == "assistant").count(),
        1,
        "{to:?}"
    );
    assert!(!to.contains(&"c1"), "{to:?}");
    let copy = dms
        .iter()
        .find(|call| call.body["to"] == "assistant")
        .unwrap();
    let text = copy.body["text"].as_str().unwrap();
    // A delegate-specific closing, never the owner-only sentence.
    assert!(
        !text.contains("Only the signed-in machine owner may answer"),
        "{text}"
    );
    assert!(
        text.contains("As a delegate of the machine owner you may answer too"),
        "{text}"
    );
    assert!(
        text.ends_with(&format!(
            "{{\"class\":\"prompt_approval\",\"target\":\"{0}:{1}:approve\"}} \
             (`{0}:{1}:deny` to deny), with no conditions.",
            f.child.id, notice.reference
        )),
        "{text}"
    );
    assert_eq!(
        copy.idempotency_key.as_deref(),
        Some(
            format!(
                "spawn-approval-delegate-{}-{}",
                notice.reference,
                MessageRef::of(&f.delegate.id)
            )
            .as_str()
        )
    );
    let asked = f
        .cloud
        .calls
        .lock()
        .unwrap()
        .iter()
        .find(|(path, _)| path.ends_with("/prompt-delegates"))
        .cloned()
        .unwrap();
    assert_eq!(
        asked.0,
        format!("/workspaces/{WS}/messaging/delegation/prompt-delegates")
    );
    assert_eq!(asked.1["session_agent_id"], f.child.id.as_str());
    assert_eq!(asked.1["session_token"], f.child.token.as_str());
}

#[tokio::test]
async fn with_the_setting_off_cloud_is_not_asked_for_delegates() {
    let f = fixture().await;
    f.set(Some(false), None);
    *f.cloud.delegates.lock().unwrap() =
        json!({"delegates": [{"agent_id": f.delegate.id, "grant_id": "grt_1"}]});
    const THREAD: &str = "01a1235e-70e1-7cb1-8619-e2c8bf3be008";
    let registration = f.spawned("codex", THREAD);
    let notice = codex_request(THREAD, 971);
    f.core
        .forward_to_owner(&registration, &f.token(), &notice)
        .await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!f
        .cloud
        .calls
        .lock()
        .unwrap()
        .iter()
        .any(|(path, _)| path.ends_with("/prompt-delegates")));
    assert!(!f
        .server
        .calls("POST", "/v1/dm")
        .iter()
        .any(|call| call.body["to"] == "assistant"));
}

#[tokio::test]
async fn a_failed_delegate_copy_is_tried_at_most_three_times() {
    let f = fixture().await;
    *f.cloud.delegates.lock().unwrap() =
        json!({"delegates": [{"agent_id": f.delegate.id, "grant_id": "grt_1"}]});
    f.server
        .set_api_error("POST /v1/dm to=assistant", Some((500, "unavailable")));
    const THREAD: &str = "01a1235e-70e1-7cb1-8619-e2c8bf3be009";
    let registration = f.spawned("codex", THREAD);
    let notice = codex_request(THREAD, 981);
    for _ in 0..3 {
        f.core
            .forward_to_owner(&registration, &f.token(), &notice)
            .await;
    }
    // The client tries each send three times itself on a 5xx.
    let sends = crate::relay::spawn::drive::LEADER_SENDS as usize * 3;
    f.server
        .wait_for("every send of the delegate's copy", |server| {
            server
                .calls("POST", "/v1/dm")
                .iter()
                .filter(|call| call.body["to"] == "assistant")
                .count()
                >= sends
        })
        .await;
    tokio::time::sleep(Duration::from_millis(800)).await;
    let copies = f
        .server
        .calls("POST", "/v1/dm")
        .iter()
        .filter(|call| call.body["to"] == "assistant")
        .count();
    assert_eq!(copies, sends);
}

#[tokio::test]
async fn under_an_organization_hold_only_an_admin_delegate_answers() {
    let f = fixture().await;
    const THREAD: &str = "01a1235e-70e1-7cb1-8619-e2c8bf3be010";
    let registration = f.spawned("codex", THREAD);
    let notice = codex_request(THREAD, 991);
    let text = format!("approve {}", notice.reference);
    f.attests(&format!("{}:{}:approve", f.child.id, notice.reference));
    let addressed = |id: &str| Delivery {
        sender_address: Some("assistant@desk".into()),
        ..approval_dm(id, &f.delegate, &text)
    };
    f.core
        .claude_delivery
        .set_organization_hold(Some(["someone-else".to_string()].into()));
    assert!(not_one(
        f.core.owner_reply(&registration, &addressed("held")).await
    ));
    assert_eq!(f.attestation_calls(), 0, "held before Cloud is asked");
    assert!(codex_drive::has_pending(THREAD, &notice.reference));
    f.core
        .claude_delivery
        .set_organization_hold(Some(["assistant@desk".to_string()].into()));
    assert!(
        settled(f.core.owner_reply(&registration, &addressed("admin")).await).ends_with("Answered")
    );
}

#[tokio::test]
async fn a_gate_only_install_never_lets_a_delegate_answer() {
    let f = fixture().await;
    const THREAD: &str = "01a1235e-70e1-7cb1-8619-e2c8bf3be011";
    let registration = f.spawned("codex", THREAD);
    let notice = codex_request(THREAD, 995);
    f.attests(&format!("{}:{}:approve", f.child.id, notice.reference));
    let mut workspace = f.core.workspace().unwrap();
    workspace.gate_url = Some(workspace.base_url.clone());
    *f.core.workspace.lock().unwrap() = Some(workspace);
    let reply = approval_dm(
        "gate",
        &f.delegate,
        &format!("approve {}", notice.reference),
    );
    assert!(not_one(f.core.owner_reply(&registration, &reply).await));
    assert_eq!(f.attestation_calls(), 0);
}

#[tokio::test]
async fn only_a_delegate_of_this_computers_signed_in_owner_answers() {
    let f = fixture().await;
    const THREAD: &str = "01a1235e-70e1-7cb1-8619-e2c8bf3be012";
    let registration = f.spawned("codex", THREAD);
    let notice = codex_request(THREAD, 997);
    let text = format!("approve {}", notice.reference);
    let exact = format!("{}:{}:approve", f.child.id, notice.reference);

    // A code owner's standing, though the owner is this computer's.
    let mut code_owner = f.claims(&exact);
    code_owner["standing"] = json!("code_owner");
    f.attests_claims(code_owner);
    assert!(not_one(
        f.core
            .owner_reply(
                &registration,
                &approval_dm("code-owner", &f.delegate, &text)
            )
            .await
    ));

    // Another person's delegate, with their own standing.
    let mut other = f.claims(&exact);
    other["owner_id"] = json!("hum_someone_else");
    f.attests_claims(other);
    assert!(not_one(
        f.core
            .owner_reply(
                &registration,
                &approval_dm("other-owner", &f.delegate, &text)
            )
            .await
    ));

    // This computer's signed-in owner is unknown.
    f.attests(&exact);
    *f.cloud.user_id.lock().unwrap() = None;
    assert!(not_one(
        f.core
            .owner_reply(
                &registration,
                &approval_dm("unknown-owner", &f.delegate, &text)
            )
            .await
    ));
    *f.cloud.user_id.lock().unwrap() = Some(String::new());
    assert!(not_one(
        f.core
            .owner_reply(
                &registration,
                &approval_dm("empty-owner", &f.delegate, &text)
            )
            .await
    ));
    assert!(codex_drive::has_pending(THREAD, &notice.reference));
    assert_eq!(codex_drive::recorded_answer(&notice.reference), None);

    // The signed-in owner's own delegate answers.
    *f.cloud.user_id.lock().unwrap() = Some("hum_owner".into());
    assert!(settled(
        f.core
            .owner_reply(&registration, &approval_dm("own", &f.delegate, &text))
            .await
    )
    .ends_with("Answered"));
}

/// A copy whose first send failed is not sent again once Cloud no longer
/// lists the delegate (its grant was revoked). The retry's `prompt-delegates`
/// call is held until the grant is gone, so the test never races it.
#[tokio::test]
async fn a_revoked_delegate_gets_no_retried_copy() {
    use std::sync::atomic::Ordering::SeqCst;
    let f = fixture().await;
    *f.cloud.delegates.lock().unwrap() =
        json!({"delegates": [{"agent_id": f.delegate.id, "grant_id": "grt_1"}]});
    let (reached, release) = (
        Arc::new(tokio::sync::Notify::new()),
        Arc::new(tokio::sync::Notify::new()),
    );
    // Call 1 is discovery, call 2 the first try's check, call 3 the first
    // retry's.
    *f.cloud.gate.lock().unwrap() = Some((3, reached.clone(), release.clone()));
    f.server
        .set_api_error("POST /v1/dm to=assistant", Some((500, "unavailable")));
    const THREAD: &str = "01a1235e-70e1-7cb1-8619-e2c8bf3be013";
    let registration = f.spawned("codex", THREAD);
    let notice = codex_request(THREAD, 998);
    f.core
        .forward_to_owner(&registration, &f.token(), &notice)
        .await;
    tokio::time::timeout(Duration::from_secs(10), reached.notified())
        .await
        .expect("the retry asks Cloud again");
    *f.cloud.delegates.lock().unwrap() = json!({"delegates": []});
    release.notify_one();
    tokio::time::timeout(Duration::from_secs(10), async {
        while f.cloud.answered.load(SeqCst) < 3 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    copies_settled(&f.core, 1).await;
    // One send is three POSTs: the client retries a 5xx itself.
    let copies = f
        .server
        .calls("POST", "/v1/dm")
        .iter()
        .filter(|call| call.body["to"] == "assistant")
        .count();
    assert_eq!(copies, 3, "no copy after the grant went away");
}

/// A failed discovery is not an empty list: it is tried again, a bounded
/// number of times, while the request is open.
#[tokio::test]
async fn delegate_discovery_is_tried_again_after_a_failure() {
    use std::sync::atomic::Ordering::SeqCst;
    let f = fixture().await;
    *f.cloud.delegates.lock().unwrap() =
        json!({"delegates": [{"agent_id": f.delegate.id, "grant_id": "grt_1"}]});
    f.cloud.discovery_failures.store(1, SeqCst);
    const THREAD: &str = "01a1235e-70e1-7cb1-8619-e2c8bf3be015";
    let registration = f.spawned("codex", THREAD);
    let notice = codex_request(THREAD, 1001);
    f.core
        .forward_to_owner(&registration, &f.token(), &notice)
        .await;
    f.server
        .wait_for("the delegate's copy after a failed discovery", |server| {
            server
                .calls("POST", "/v1/dm")
                .iter()
                .any(|call| call.body["to"] == "assistant")
        })
        .await;
    assert!(f.cloud.discoveries.load(SeqCst) >= 2);
}

/// An agent that is both a workspace leader and a delegate gets both
/// copies, under keys of their own kinds.
#[tokio::test]
async fn a_leader_that_is_also_a_delegate_gets_both_copies() {
    let f = fixture().await;
    f.server.set_leaders(Some(json!({
        "leaders": [{"name": "assistant", "agent_id": f.delegate.id}], "patterns": []
    })));
    f.core
        .store
        .update(|store| store.extras.spawn_leader_approvals = Some(true))
        .unwrap();
    *f.cloud.delegates.lock().unwrap() =
        json!({"delegates": [{"agent_id": f.delegate.id, "grant_id": "grt_1"}]});
    const THREAD: &str = "01a1235e-70e1-7cb1-8619-e2c8bf3be016";
    let registration = f.spawned("codex", THREAD);
    let notice = codex_request(THREAD, 1002);
    f.core
        .forward_to_owner(&registration, &f.token(), &notice)
        .await;
    f.server
        .wait_for("both copies", |server| {
            server
                .calls("POST", "/v1/dm")
                .iter()
                .filter(|call| call.body["to"] == "assistant")
                .count()
                >= 2
        })
        .await;
    let mut keys: Vec<String> = f
        .server
        .calls("POST", "/v1/dm")
        .into_iter()
        .filter(|call| call.body["to"] == "assistant")
        .filter_map(|call| call.idempotency_key)
        .collect();
    // A send the client repeated under load keeps its key.
    keys.sort();
    keys.dedup();
    let id = MessageRef::of(&f.delegate.id);
    let mut expected = vec![
        format!("spawn-approval-{}-{id}", notice.reference),
        format!("spawn-approval-delegate-{}-{id}", notice.reference),
    ];
    expected.sort();
    assert_eq!(keys, expected);
}

/// A delegate without a conversation Relaycast lists to the session (none
/// yet, or one the session left) gets no notice: its members are unseen.
#[tokio::test]
async fn no_notice_goes_to_a_delegate_without_a_listed_private_conversation() {
    let f = fixture().await;
    let unlisted = f.server.seed_agent("assistant2", "agent", json!({}));
    *f.cloud.delegates.lock().unwrap() =
        json!({"delegates": [{"agent_id": unlisted.id, "grant_id": "grt_2"}]});
    const THREAD: &str = "01a1235e-70e1-7cb1-8619-e2c8bf3be017";
    let registration = f.spawned("codex", THREAD);
    let notice = codex_request(THREAD, 1003);
    f.core
        .forward_to_owner(&registration, &f.token(), &notice)
        .await;
    copies_settled(&f.core, 1).await;
    assert!(!f
        .server
        .calls("POST", "/v1/dm")
        .iter()
        .any(|call| call.body["to"] == "assistant2"));
}

/// A reply in a 1:1 conversation that gained a third participant is not a
/// 1:1 direct message: Cloud is not even asked, and no notice goes there.
#[tokio::test]
async fn a_conversation_with_a_third_participant_is_not_one_to_one() {
    let f = fixture().await;
    f.server.seed_agent("outsider", "agent", json!({}));
    f.server.add_dm_participant("assistant", "c1", "outsider");
    *f.cloud.delegates.lock().unwrap() =
        json!({"delegates": [{"agent_id": f.delegate.id, "grant_id": "grt_1"}]});
    const THREAD: &str = "01a1235e-70e1-7cb1-8619-e2c8bf3be014";
    let registration = f.spawned("codex", THREAD);
    let notice = codex_request(THREAD, 999);
    f.attests(&format!("{}:{}:approve", f.child.id, notice.reference));
    let reply = approval_dm(
        "shared",
        &f.delegate,
        &format!("approve {}", notice.reference),
    );
    assert!(not_one(f.core.owner_reply(&registration, &reply).await));
    assert_eq!(f.attestation_calls(), 0);
    assert!(codex_drive::has_pending(THREAD, &notice.reference));
    f.core
        .forward_to_owner(&registration, &f.token(), &notice)
        .await;
    copies_settled(&f.core, 1).await;
    assert!(!f
        .server
        .calls("POST", "/v1/dm")
        .iter()
        .any(|call| call.body["to"] == "assistant"));
}

/// A participant added while Cloud attests the reply: the pair is checked
/// again after the attestation, right before the answer settles.
#[tokio::test]
async fn a_participant_added_during_attestation_stops_the_answer() {
    let f = fixture().await;
    f.server.seed_agent("outsider", "agent", json!({}));
    const THREAD: &str = "01a1235e-70e1-7cb1-8619-e2c8bf3be018";
    let registration = f.spawned("codex", THREAD);
    let notice = codex_request(THREAD, 1004);
    f.attests(&format!("{}:{}:approve", f.child.id, notice.reference));
    let add = f.server.participant_adder();
    let jwks = json!({"keys": [f.cloud.signer.jwk(KID)]});
    f.core.delegation_keys.set_fetch(Arc::new(move || {
        // The keys are read after Cloud answered: the pair stops being one.
        add("assistant", "c1", "outsider");
        let jwks = jwks.clone();
        Box::pin(async move { Some(jwks) })
    }));
    let reply = approval_dm(
        "added",
        &f.delegate,
        &format!("approve {}", notice.reference),
    );
    assert!(not_one(f.core.owner_reply(&registration, &reply).await));
    assert_eq!(f.attestation_calls(), 1, "Cloud was asked");
    assert!(codex_drive::has_pending(THREAD, &notice.reference));
}

/// Waits until `n` leaders' or delegates' notice copies have finished
/// their tries (sent, stopped or out of tries).
async fn copies_settled(core: &Core, n: usize) {
    tokio::time::timeout(Duration::from_secs(10), async {
        while core
            .notice_copies_settled
            .load(std::sync::atomic::Ordering::SeqCst)
            < n
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the notice copies finish");
}

/// Only the conversation that carried the reply decides, for delegates too.
#[tokio::test]
async fn the_conversation_that_carried_a_delegate_reply_decides() {
    let f = fixture().await;
    f.server.seed_agent("other", "agent", json!({}));
    f.server.seed_conversation("other", "c1");
    f.server.add_dm_participant("other", "c1", "assistant");
    const THREAD: &str = "01a1235e-70e1-7cb1-8619-e2c8bf3be019";
    let registration = f.spawned("codex", THREAD);
    let notice = codex_request(THREAD, 1005);
    f.attests(&format!("{}:{}:approve", f.child.id, notice.reference));
    let text = format!("approve {}", notice.reference);
    let elsewhere = Delivery {
        channel_id: Some("dmch_c1_other".into()),
        ..approval_dm("elsewhere", &f.delegate, &text)
    };
    assert!(not_one(f.core.owner_reply(&registration, &elsewhere).await));
    let private = Delivery {
        channel_id: Some("dmch_assistant_c1".into()),
        ..approval_dm("private", &f.delegate, &text)
    };
    assert!(settled(f.core.owner_reply(&registration, &private).await).ends_with("Answered"));
}
