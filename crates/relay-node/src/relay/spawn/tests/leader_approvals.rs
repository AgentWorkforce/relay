//! With **Approvals from workspace leaders** on (`spawn_leader_approvals`,
//! off unless the machine owner turns it on) and native input from spawning
//! agents on, a workspace leader may approve or deny a spawned session's open
//! permission request by direct message, though it did not spawn the
//! session, as the machine owner could rather than as the requester: neither
//! `spawn_requester_approvals` nor the spawn's approval profile (`interactive`
//! included) limits it. Leaders are matched by agent id in a list read successfully within
//! `leaders::REFRESH_AFTER`; the kept list of failed reads never serves.
//! Choices, forms, input and local verification stay with the machine owner.
//! The leader is never recorded as the machine owner.

use super::*;
use crate::relay::codex::app_server::drive as codex_drive;
use crate::relay::contract::agents::WorkspaceLeader;
use crate::relay::delivery::policy::{Delivery, MessageRef};
use crate::relay::harness::claude::requests;
use crate::relay::spawn::drive::{audit_line, Approver, OwnerReply};
use crate::relay::spawn::launch::SpawnedProcess;
use crate::relay::spawn::wire::ApprovalProfile;
use crate::relay::store::{CloudWorkspace, SpawnRequester};
use crate::relay::workspace::Secret;
use futures_util::future::BoxFuture;

#[path = "../../../../tests/support/fake_relaycast.rs"]
mod fake_relaycast;

use fake_relaycast::{FakeRelaycast, WORKSPACE_KEY};

struct SignedIn {
    base: String,
    owner: String,
}

impl crate::relay::cloud_session::CloudAccess for SignedIn {
    fn account(&self) -> Option<crate::relay::cloud_session::CloudAccount> {
        Some(crate::relay::cloud_session::CloudAccount {
            site_url: self.base.clone(),
            workspace_id: "cloud-workspace".into(),
            user_id: Some("person".into()),
        })
    }
    fn agent_owner(&self) -> Option<crate::relay::cloud_session::AgentOwner> {
        Some(crate::relay::cloud_session::AgentOwner {
            user_id: "person".into(),
            workspace_id: Some("cloud-workspace".into()),
        })
    }
    fn request(
        &self,
        _: &'static str,
        path: String,
        _: Option<Value>,
    ) -> BoxFuture<'_, Result<Value, crate::relay::cloud_session::CloudError>> {
        Box::pin(async move {
            Ok(if path.ends_with("/messaging/identity/credential") {
                json!({"identity":{"name":"owner","agentId":self.owner,"token":"at_owner","relaycastUrl":self.base}})
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
    spawner: Arc<FakeSpawner>,
    owner: fake_relaycast::Agent,
    requester: fake_relaycast::Agent,
    lead: fake_relaycast::Agent,
    child: fake_relaycast::Agent,
}

/// A signed-in core with an account whose computer is claimed by the
/// person, with `lead` the workspace's one leader. `dead` makes every
/// spawned session it is asked about one that has ended.
async fn fixture_with(dead: bool, account: bool) -> Fixture {
    let server = FakeRelaycast::start(Default::default()).await;
    let owner = server.seed_agent("owner", "human", json!({}));
    let requester = server.seed_agent("grokbot", "agent", json!({}));
    let lead = server.seed_agent("lead", "agent", json!({}));
    let child = server.seed_agent("c1", "agent", json!({}));
    // Their 1:1 conversation, with just the two of them.
    server.seed_conversation("lead", "c1");
    server.set_leaders(Some(json!({
        "leaders": [{"name": "lead", "agent_id": lead.id}],
        "patterns": []
    })));
    let home = tempfile::tempdir().unwrap();
    let spawner = Arc::new(FakeSpawner {
        native: true,
        dead,
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
    let (core, _signals) = Core::with_plugins(
        config,
        crate::relay::daemon::Plugins {
            account: account.then(|| crate::relay::test_account::TestAccount::new().into_plugin()),
            cloud: Arc::new(SignedIn {
                base: server.base_url.clone(),
                owner: owner.id.clone(),
            }),
            spawner: spawner.clone(),
            ..crate::relay::daemon::Plugins::default()
        },
    );
    core.store
        .update(|store| {
            store.cloud = Some(CloudWorkspace {
                key: Secret::new(WORKSPACE_KEY),
                base_url: server.base_url.clone(),
                workspace_id: Some("rw_leaders".into()),
                ..Default::default()
            });
            // No spawn node runs, so nothing changes the claim set below.
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
    // Claimed by the person. The rest of the status stays as the core set
    // it, so a later reconciliation finds nothing to change.
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
        spawner,
        owner,
        requester,
        lead,
        child,
    }
}

async fn fixture() -> Fixture {
    fixture_with(false, true).await
}

impl Fixture {
    /// Approvals from workspace leaders, from the spawning agent, and
    /// native input from it, as the machine owner set them.
    fn set(&self, leaders: Option<bool>, requester: Option<bool>, native: Option<bool>) {
        self.core
            .store
            .update(|store| {
                store.extras.spawn_leader_approvals = leaders;
                store.extras.spawn_requester_approvals = requester;
                store.extras.spawn_native_input = native;
            })
            .unwrap();
    }

    /// `c1`, spawned here by `grokbot` with `harness` on `session`, and saved.
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

    fn leaders(&self, leaders: Value) {
        self.server
            .set_leaders(Some(json!({"leaders": leaders, "patterns": []})));
        self.core.leaders.age(crate::relay::leaders::REFRESH_AFTER);
    }

    /// The approval DMs sent so far: (recipient, text, idempotency key).
    fn approval_dms(&self) -> Vec<(String, String, String)> {
        self.server
            .calls("POST", "/v1/dm")
            .into_iter()
            .map(|call| {
                (
                    call.body["to"].as_str().unwrap_or_default().to_string(),
                    call.body["text"].as_str().unwrap_or_default().to_string(),
                    call.idempotency_key.unwrap_or_default(),
                )
            })
            .collect()
    }
}

fn dm(id: &str, sender: &fake_relaycast::Agent, text: &str) -> Delivery {
    dm_from(id, &sender.name, &sender.id, text)
}

fn dm_from(id: &str, name: &str, sender_id: &str, text: &str) -> Delivery {
    Delivery {
        id: format!("d-{id}"),
        message_id: format!("m-{id}"),
        sender: Some(name.into()),
        sender_id: Some(sender_id.into()),
        reason: Some("dm".into()),
        text: Some(text.into()),
        ..Delivery::default()
    }
}

fn claude_request(session: &str, request_id: &str) -> requests::Notice {
    let request = json!({"type": "control_request", "request_id": request_id, "request": {
        "subtype": "can_use_tool", "tool_name": "Bash", "input": {"command": "ls"}}});
    claude_registered(session, &request)
}

/// The notice of `request`, just registered for `session`: not one of those
/// already open.
fn claude_registered(session: &str, request: &Value) -> requests::Notice {
    let before: Vec<String> = requests::unforwarded(session)
        .into_iter()
        .map(|notice| notice.reference)
        .collect();
    assert_eq!(requests::register(session, request), None);
    requests::unforwarded(session)
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

/// The notice of `request`, just opened on `thread`: not one of those
/// already open.
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

fn by_leader(f: &Fixture) -> String {
    format!("the workspace leader @lead ({})", f.lead.id)
}

#[tokio::test]
async fn a_leader_that_did_not_spawn_the_session_approves_and_denies_codex_and_claude() {
    let f = fixture().await;
    f.set(Some(true), None, None);

    // Codex: approve one request, deny another.
    const THREAD: &str = "01a1235e-70e1-7cb1-8619-e2c8bf3bd001";
    let codex = f.spawned("codex", THREAD);
    let first = codex_request(THREAD, 301);
    let approve = dm(
        "codex-approve",
        &f.lead,
        &format!("approve {}", first.reference),
    );
    let detail = settled(f.core.owner_reply(&codex, &approve).await);
    assert_eq!(
        detail,
        format!("Codex approval reply from {}: Answered", by_leader(&f))
    );
    assert!(!detail.contains("machine owner"), "{detail}");
    assert!(f
        .core
        .store
        .read(|store| store.injected_delivery_ids.contains(&approve.id)));
    let answer = codex_drive::recorded_answer(&first.reference).unwrap();
    assert_eq!(answer["decision"], "accept", "{answer}");
    let second = codex_request(THREAD, 302);
    let deny = dm("codex-deny", &f.lead, &format!("deny {}", second.reference));
    assert_eq!(
        settled(f.core.owner_reply(&codex, &deny).await),
        format!("Codex approval reply from {}: Answered", by_leader(&f))
    );
    let answer = codex_drive::recorded_answer(&second.reference).unwrap();
    assert_eq!(answer["decision"], "decline", "{answer}");

    // Claude: approve, and deny.
    const SESSION: &str = "a1d0c2e4-0000-4000-8000-00000000d001";
    let claude = f.spawned("claude", SESSION);
    let first = claude_request(SESSION, "l1");
    let approve = dm(
        "claude-approve",
        &f.lead,
        &format!("approve {}", first.reference),
    );
    assert_eq!(
        settled(f.core.owner_reply(&claude, &approve).await),
        format!("Claude approval reply from {}: Answered", by_leader(&f))
    );
    let second = claude_request(SESSION, "l2");
    let deny = dm(
        "claude-deny",
        &f.lead,
        &format!("deny {}", second.reference),
    );
    assert_eq!(
        settled(f.core.owner_reply(&claude, &deny).await),
        format!("Claude approval reply from {}: Answered", by_leader(&f))
    );
    let due = requests::due(SESSION);
    assert_eq!(due.len(), 2);
    assert!(due
        .iter()
        .any(|(_, line)| line.contains(r#""behavior":"allow""#)));
    assert!(due
        .iter()
        .any(|(_, line)| line.contains(r#""behavior":"deny""#)));
    requests::forget(SESSION);
}

#[tokio::test]
async fn the_first_answer_counts_between_owner_requester_and_leader() {
    let f = fixture().await;
    f.set(Some(true), Some(true), None);
    const THREAD: &str = "01a1235e-70e1-7cb1-8619-e2c8bf3bd002";
    let registration = f.spawned("codex", THREAD);

    // The leader first: the requester's and the owner's later answers find
    // it answered.
    let notice = codex_request(THREAD, 311);
    let text = format!("approve {}", notice.reference);
    assert!(settled(
        f.core
            .owner_reply(&registration, &dm("l-first", &f.lead, &text))
            .await
    )
    .ends_with("Answered"));
    assert!(not_one(
        f.core
            .owner_reply(&registration, &dm("r-second", &f.requester, &text))
            .await
    ));
    assert_eq!(
        settled(
            f.core
                .owner_reply(&registration, &dm("o-third", &f.owner, &text))
                .await
        ),
        "Codex approval reply from the machine owner: Unknown"
    );

    // The owner first: the leader's later answer is a message.
    let notice = codex_request(THREAD, 312);
    let text = format!("deny {}", notice.reference);
    assert_eq!(
        settled(
            f.core
                .owner_reply(&registration, &dm("o-first", &f.owner, &text))
                .await
        ),
        "Codex approval reply from the machine owner: Answered"
    );
    assert!(not_one(
        f.core
            .owner_reply(&registration, &dm("l-second", &f.lead, &text))
            .await
    ));

    // The requester first: the leader's later answer is a message.
    let notice = codex_request(THREAD, 313);
    let text = format!("approve {}", notice.reference);
    assert!(settled(
        f.core
            .owner_reply(&registration, &dm("r-first", &f.requester, &text))
            .await
    )
    .contains("the spawning agent @grokbot"));
    assert!(not_one(
        f.core
            .owner_reply(&registration, &dm("l-third", &f.lead, &text))
            .await
    ));
}

#[test]
fn the_audit_line_and_record_name_the_leader_never_the_owner() {
    let leader = Approver::Leader(WorkspaceLeader {
        name: "lead".into(),
        agent_id: "agent_lead".into(),
    });
    assert_eq!(leader.id(), "agent_lead");
    assert_eq!(leader.describe(), "the workspace leader @lead (agent_lead)");
    let line = audit_line(
        "Codex",
        "c1",
        "0123456789abcdef",
        &leader,
        codex_drive::ReplyResult::Answered,
    );
    assert_eq!(
        line,
        "relay: Codex approval 0123456789abcdef for @c1: Answered, answered by the workspace leader @lead (agent_lead)"
    );
    assert!(!line.contains("machine owner"));
}

#[tokio::test]
async fn with_the_setting_off_as_it_is_by_default_a_leaders_reply_is_a_message() {
    let f = fixture().await;
    f.set(None, None, None);
    assert!(!f
        .core
        .store
        .read(crate::relay::spawn::settings::leader_approvals));
    const THREAD: &str = "01a1235e-70e1-7cb1-8619-e2c8bf3bd003";
    let registration = f.spawned("codex", THREAD);
    let notice = codex_request(THREAD, 321);
    for verb in ["approve", "deny"] {
        let reply = dm(verb, &f.lead, &format!("{verb} {}", notice.reference));
        assert!(not_one(f.core.owner_reply(&registration, &reply).await));
    }
    f.set(Some(false), None, None);
    let reply = dm("off", &f.lead, &format!("approve {}", notice.reference));
    assert!(not_one(f.core.owner_reply(&registration, &reply).await));
    assert!(codex_drive::has_pending(THREAD, &notice.reference));
    assert!(f
        .core
        .store
        .read(|store| store.injected_delivery_ids.is_empty()));
}

// The leader approves or denies as the owner could: approvals from the
// spawning agent off, or a profile that keeps the requester out
// (`interactive` included), does not stop it. Native input from spawning
// agents off, a core without an account, and a session taken over do.
#[tokio::test]
async fn a_leaders_standing_is_the_owners_within_the_machine_owners_limits() {
    let f = fixture().await;
    const THREAD: &str = "01a1235e-70e1-7cb1-8619-e2c8bf3bd004";
    let mut registration = f.spawned("codex", THREAD);

    f.set(Some(true), Some(false), None);
    let notice = codex_request(THREAD, 331);
    let text = format!("approve {}", notice.reference);
    assert!(settled(
        f.core
            .owner_reply(&registration, &dm("requester-off", &f.lead, &text))
            .await
    )
    .ends_with("Answered"));

    f.set(Some(true), Some(true), None);
    for (index, profile) in [ApprovalProfile::Interactive, ApprovalProfile::FullAccess]
        .into_iter()
        .enumerate()
    {
        registration.spawn.as_mut().unwrap().approval_profile = Some(profile);
        assert!(f.core.approving_requester(&registration).is_none());
        let notice = codex_request(THREAD, 332 + index as u64);
        let text = format!("deny {}", notice.reference);
        assert!(settled(
            f.core
                .owner_reply(
                    &registration,
                    &dm(&format!("profile-{index}"), &f.lead, &text)
                )
                .await
        )
        .ends_with("Answered"));
    }
    registration.spawn.as_mut().unwrap().approval_profile = None;

    f.set(Some(true), Some(true), Some(false));
    let notice = codex_request(THREAD, 334);
    let text = format!("approve {}", notice.reference);
    assert!(not_one(
        f.core
            .owner_reply(&registration, &dm("native-off", &f.lead, &text))
            .await
    ));

    f.set(Some(true), None, None);
    let mut taken_over = registration.clone();
    taken_over.spawn.as_mut().unwrap().taken_over_at = Some("2026-10-28T01:00:00Z".into());
    assert!(not_one(
        f.core
            .owner_reply(&taken_over, &dm("taken-over", &f.lead, &text))
            .await
    ));
    assert!(codex_drive::has_pending(THREAD, &notice.reference));
}

#[tokio::test]
async fn a_core_without_an_account_never_lets_a_leader_answer() {
    let f = fixture_with(false, false).await;
    f.set(Some(true), None, None);
    const THREAD: &str = "01a1235e-70e1-7cb1-8619-e2c8bf3bd005";
    let registration = f.spawned("codex", THREAD);
    let notice = codex_request(THREAD, 341);
    let text = format!("approve {}", notice.reference);
    assert!(not_one(
        f.core
            .owner_reply(&registration, &dm("public", &f.lead, &text))
            .await
    ));
    assert!(codex_drive::has_pending(THREAD, &notice.reference));
}

// By id only: a leader's name with another id is not a leader; a leader's id
// in another workspace is not one here; a removed leader is not one once the
// list is read again.
#[tokio::test]
async fn impostors_other_workspaces_and_removed_leaders_never_answer() {
    let f = fixture().await;
    f.set(Some(true), None, None);
    const THREAD: &str = "01a1235e-70e1-7cb1-8619-e2c8bf3bd006";
    let registration = f.spawned("codex", THREAD);
    let notice = codex_request(THREAD, 351);
    let text = format!("approve {}", notice.reference);

    let impostor = dm_from("impostor", "lead", "agent_impostor", &text);
    assert!(not_one(f.core.owner_reply(&registration, &impostor).await));

    let mut elsewhere = registration.clone();
    elsewhere.workspace_key = Some(Secret::new("rk_live_elsewhere"));
    assert!(not_one(
        f.core
            .owner_reply(&elsewhere, &dm("elsewhere", &f.lead, &text))
            .await
    ));

    // The leader answers one request; removed, it answers no other once
    // the list is read again.
    let answered = codex_request(THREAD, 352);
    assert!(settled(
        f.core
            .owner_reply(
                &registration,
                &dm("listed", &f.lead, &format!("deny {}", answered.reference))
            )
            .await
    )
    .ends_with("Answered"));
    f.leaders(json!([]));
    assert!(not_one(
        f.core
            .owner_reply(&registration, &dm("removed", &f.lead, &text))
            .await
    ));
    assert!(codex_drive::has_pending(THREAD, &notice.reference));
    let saved = f
        .core
        .store
        .read(|store| store.injected_delivery_ids.clone());
    assert_eq!(saved.len(), 1, "only the listed leader's answer: {saved:?}");
}

// Only a list read successfully within `REFRESH_AFTER` serves. The last list
// failed reads keep (for `KEEP_FOR`) still makes the leader's messages native
// input, as before, but never an approval.
#[tokio::test]
async fn a_stale_or_refused_list_never_makes_an_approver() {
    use crate::relay::leaders::{REFRESH_AFTER, REREAD_AFTER};
    let f = fixture().await;
    f.set(Some(true), None, None);
    const THREAD: &str = "01a1235e-70e1-7cb1-8619-e2c8bf3bd007";
    let registration = f.spawned("codex", THREAD);
    let fresh = codex_request(THREAD, 361);
    assert!(settled(
        f.core
            .owner_reply(
                &registration,
                &dm("fresh", &f.lead, &format!("approve {}", fresh.reference))
            )
            .await
    )
    .ends_with("Answered"));

    // Aged past `REFRESH_AFTER`, and the read fails.
    f.server.set_failing(&["GET /v1/workspace/leaders"]);
    f.core.leaders.age(REFRESH_AFTER);
    let notice = codex_request(THREAD, 362);
    let text = format!("approve {}", notice.reference);
    assert!(not_one(
        f.core
            .owner_reply(&registration, &dm("stale", &f.lead, &text))
            .await
    ));
    // The kept list still names the leader for native input.
    assert!(f
        .core
        .workspace_leader(&registration, &f.lead.id)
        .await
        .is_some());
    // A lookup for native input read again and failed: the list it keeps is
    // fresh for native input, but no read has succeeded since.
    f.core.leaders.age(REFRESH_AFTER);
    assert!(f
        .core
        .workspace_leader(&registration, &f.lead.id)
        .await
        .is_some());
    assert!(not_one(
        f.core
            .owner_reply(&registration, &dm("kept", &f.lead, &text))
            .await
    ));
    assert!(codex_drive::has_pending(THREAD, &notice.reference));

    // Once a read succeeds again, the leader answers.
    f.server.set_failing(&[]);
    f.core.leaders.age(REREAD_AFTER);
    assert!(settled(
        f.core
            .owner_reply(&registration, &dm("recovered", &f.lead, &text))
            .await
    )
    .ends_with("Answered"));

    // A refused read drops it at once.
    let notice = codex_request(THREAD, 363);
    let text = format!("approve {}", notice.reference);
    f.server
        .set_api_error("GET /v1/workspace/leaders", Some((403, "forbidden")));
    f.core.leaders.age(REFRESH_AFTER);
    assert!(not_one(
        f.core
            .owner_reply(&registration, &dm("refused", &f.lead, &text))
            .await
    ));
    assert!(codex_drive::has_pending(THREAD, &notice.reference));
}

#[tokio::test]
async fn a_leaders_channel_post_group_message_or_mention_never_answers() {
    let f = fixture().await;
    f.set(Some(true), None, None);
    const THREAD: &str = "01a1235e-70e1-7cb1-8619-e2c8bf3bd008";
    let registration = f.spawned("codex", THREAD);
    let notice = codex_request(THREAD, 371);
    let text = format!("approve {}", notice.reference);
    let mut channel = dm("channel", &f.lead, &text);
    channel.channel_id = Some("general".into());
    let mut group = dm("group", &f.lead, &text);
    group.channel_id = Some("group_three".into());
    let mut mention = dm("mention", &f.lead, &text);
    mention.reason = Some("mention".into());
    let mut thread = dm("thread", &f.lead, &text);
    thread.reason = Some("thread-reply".into());
    thread.channel_id = Some("chan_general".into());
    for delivery in [channel, group, mention, thread] {
        assert!(not_one(f.core.owner_reply(&registration, &delivery).await));
    }
    assert!(codex_drive::has_pending(THREAD, &notice.reference));
}

#[tokio::test]
async fn a_leaders_reply_to_an_ended_claude_says_it_ended_and_never_resumes_it() {
    let f = fixture_with(true, true).await;
    f.set(Some(true), None, None);
    const SESSION: &str = "a1d0c2e4-0000-4000-8000-00000000d009";
    let registration = f.spawned("claude", SESSION);
    let notice = claude_request(SESSION, "l9");
    let approval = dm("ended", &f.lead, &format!("approve {}", notice.reference));
    assert!(not_one(f.core.owner_reply(&registration, &approval).await));
    assert_eq!(
        settled(f.core.ended_claude(&registration, &approval).await),
        "Spawned Claude has ended; not delivered"
    );
    assert!(
        f.spawner.launched.lock().unwrap().is_empty(),
        "never resumed"
    );
    requests::forget(SESSION);
}

#[tokio::test]
async fn a_leaders_reply_to_an_answered_expired_or_unknown_reference_is_a_message() {
    let f = fixture().await;
    f.set(Some(true), None, None);
    const THREAD: &str = "01a1235e-70e1-7cb1-8619-e2c8bf3bd010";
    let registration = f.spawned("codex", THREAD);
    let answered = codex_request(THREAD, 381);
    assert_eq!(
        codex_drive::answer(
            THREAD,
            &answered.reference,
            Some(&f.owner.id),
            Some(&f.owner.id),
            true
        ),
        codex_drive::ReplyResult::Answered
    );
    let expired = codex_request(THREAD, 382);
    codex_drive::expire(&expired.reference);
    for (id, reference) in [
        ("answered", answered.reference.as_str()),
        ("expired", expired.reference.as_str()),
        ("unknown", "0123456789abcdef"),
    ] {
        let reply = dm(id, &f.lead, &format!("deny {reference}"));
        assert!(
            not_one(f.core.owner_reply(&registration, &reply).await),
            "{id}"
        );
    }
    // Another session's open reference is not this one's.
    let other = codex_request("01a1235e-70e1-7cb1-8619-e2c8bf3bd0ff", 383);
    let reply = dm("other", &f.lead, &format!("approve {}", other.reference));
    assert!(not_one(f.core.owner_reply(&registration, &reply).await));
}

#[tokio::test]
async fn a_leader_cannot_choose_or_answer_a_request_that_is_not_approvable() {
    let f = fixture().await;
    f.set(Some(true), None, None);
    const THREAD: &str = "01a1235e-70e1-7cb1-8619-e2c8bf3bd011";
    let registration = f.spawned("codex", THREAD);
    let question = codex_opened(
        THREAD,
        json!({"id": 391, "method": "item/tool/requestUserInput", "params": {
            "threadId": THREAD,
            "questions": [{"id": "decision", "header": "Confirm", "question": "Install?",
                "options": [{"label": "Install", "description": "Proceed"},
                    {"label": "Cancel", "description": "Stop"}]}]
        }}),
    );
    assert!(!question.approvable);
    for (id, text) in [
        ("choose", format!("choose {} 1", question.reference)),
        ("deny", format!("deny {}", question.reference)),
        ("approve", format!("approve {}", question.reference)),
    ] {
        let reply = dm(id, &f.lead, &text);
        assert!(
            not_one(f.core.owner_reply(&registration, &reply).await),
            "{id}"
        );
    }
    assert!(codex_drive::has_pending(THREAD, &question.reference));
    assert_eq!(codex_drive::recorded_answer(&question.reference), None);

    // A Claude dialog that needs local input, the same.
    const SESSION: &str = "a1d0c2e4-0000-4000-8000-00000000d011";
    let claude = f.spawned("claude", SESSION);
    let dialog = json!({"type": "control_request", "request_id": "dialog", "request": {
        "subtype": "request_user_dialog"}});
    let notice = claude_registered(SESSION, &dialog);
    assert!(!notice.approvable);
    let reply = dm(
        "dialog-deny",
        &f.lead,
        &format!("deny {}", notice.reference),
    );
    assert!(not_one(f.core.owner_reply(&claude, &reply).await));
    assert!(requests::has_pending(SESSION, &notice.reference));
    assert!(f
        .core
        .store
        .read(|store| store.injected_delivery_ids.is_empty()));
    requests::forget(SESSION);
}

#[tokio::test]
async fn a_leader_that_is_the_session_never_answers_its_own_request() {
    let f = fixture().await;
    f.set(Some(true), None, None);
    f.leaders(json!([
        {"name": "lead", "agent_id": f.lead.id},
        {"name": "c1", "agent_id": f.child.id}
    ]));
    const THREAD: &str = "01a1235e-70e1-7cb1-8619-e2c8bf3bd012";
    let registration = f.spawned("codex", THREAD);
    let notice = codex_request(THREAD, 401);
    let own = dm("self", &f.child, &format!("approve {}", notice.reference));
    assert!(not_one(f.core.owner_reply(&registration, &own).await));
    assert!(codex_drive::has_pending(THREAD, &notice.reference));
}

// The spawning agent keeps the requester rules though it is a leader too:
// with approvals from it off it cannot answer, and with them on it answers
// as the spawning agent.
#[tokio::test]
async fn a_leader_that_is_the_requester_follows_the_requester_rules() {
    let f = fixture().await;
    f.leaders(json!([
        {"name": "lead", "agent_id": f.lead.id},
        {"name": "grokbot", "agent_id": f.requester.id}
    ]));
    const THREAD: &str = "01a1235e-70e1-7cb1-8619-e2c8bf3bd013";
    let registration = f.spawned("codex", THREAD);
    let notice = codex_request(THREAD, 411);
    let text = format!("approve {}", notice.reference);

    f.set(Some(true), Some(false), None);
    assert!(not_one(
        f.core
            .owner_reply(&registration, &dm("off", &f.requester, &text))
            .await
    ));
    let mut interactive = registration.clone();
    interactive.spawn.as_mut().unwrap().approval_profile = Some(ApprovalProfile::Interactive);
    f.set(Some(true), Some(true), None);
    assert!(not_one(
        f.core
            .owner_reply(&interactive, &dm("interactive", &f.requester, &text))
            .await
    ));
    assert!(codex_drive::has_pending(THREAD, &notice.reference));

    assert_eq!(
        settled(
            f.core
                .owner_reply(&registration, &dm("on", &f.requester, &text))
                .await
        ),
        format!(
            "Codex approval reply from the spawning agent @grokbot ({}): Answered",
            f.requester.id
        )
    );
}

// With the setting off nothing about a notice changes: the same text, the
// same two recipients, the same keys.
#[tokio::test]
async fn with_the_setting_off_notices_are_unchanged_byte_for_byte() {
    let f = fixture().await;
    f.set(None, None, None);
    const THREAD: &str = "01a1235e-70e1-7cb1-8619-e2c8bf3bd014";
    let registration = f.spawned("codex", THREAD);
    let notice = codex_request(THREAD, 421);
    f.core
        .forward_to_owner(&registration, &f.token(), &notice)
        .await;
    let reference = &notice.reference;
    let expected = format!(
        "[Codex approval {reference} for @c1]\n\
         Status: `waiting_for_approval`. Unanswered requests expire as an explicit denial after 15 minutes.\n\
         {}\n\
         Reply `approve {reference}` or `deny {reference}` within 15 minutes. \
         The signed-in machine owner or @grokbot, the agent that spawned this session, \
         may answer; the first answer counts.",
        notice.description
    );
    let key = |id: &str| format!("spawn-approval-{reference}-{}", MessageRef::of(id));
    assert_eq!(
        f.approval_dms(),
        vec![
            ("owner".into(), expected.clone(), key(&f.owner.id)),
            ("grokbot".into(), expected, key(&f.requester.id)),
        ]
    );
    assert!(codex_drive::unforwarded(THREAD).is_empty());

    // A Claude's too.
    const SESSION: &str = "a1d0c2e4-0000-4000-8000-00000000d014";
    let claude = f.spawned("claude", SESSION);
    let notice = claude_request(SESSION, "n14");
    f.core.forward_request(&claude, &f.token(), &notice).await;
    let reference = &notice.reference;
    let expected = format!(
        "[Claude approval {reference} for @c1]\n{}\n\
         Reply `approve {reference}` or `deny {reference}` within five minutes. \
         The signed-in machine owner or @grokbot, the agent that spawned this session, \
         may answer; the first answer counts.",
        notice.description
    );
    let key = |id: &str| format!("spawn-approval-{reference}-{}", MessageRef::of(id));
    assert_eq!(
        f.approval_dms()[2..].to_vec(),
        vec![
            ("owner".into(), expected.clone(), key(&f.owner.id)),
            ("grokbot".into(), expected, key(&f.requester.id)),
        ]
    );
    requests::forget(SESSION);
}

// The notice says a workspace leader may answer, in a fixed sentence: it
// never names them, so it never waits for the list or changes with it.
#[tokio::test]
async fn with_the_setting_on_each_listed_leader_gets_the_notice_which_says_leaders_may_answer() {
    let f = fixture().await;
    f.set(Some(true), None, None);
    let taken = f.server.seed_agent("lead2", "agent", json!({}));
    f.leaders(json!([
        {"name": "lead", "agent_id": f.lead.id},
        // Relaycast gives `lead2` another id now: no copy, and not named.
        {"name": "lead2", "agent_id": "agent_lead2_before"},
        // The session and its requester are never sent a leader's copy.
        {"name": "c1", "agent_id": f.child.id},
        {"name": "grokbot", "agent_id": f.requester.id}
    ]));
    const THREAD: &str = "01a1235e-70e1-7cb1-8619-e2c8bf3bd015";
    let registration = f.spawned("codex", THREAD);
    let notice = codex_request(THREAD, 431);
    f.core
        .forward_to_owner(&registration, &f.token(), &notice)
        .await;
    let reference = &notice.reference;
    let expected = format!(
        "[Codex approval {reference} for @c1]\n\
         Status: `waiting_for_approval`. Unanswered requests expire as an explicit denial after 15 minutes.\n\
         {}\n\
         Reply `approve {reference}` or `deny {reference}` within 15 minutes. \
         The signed-in machine owner, @grokbot (the agent that spawned this session) \
         or a workspace leader may answer; the first answer counts.",
        notice.description
    );
    let key = |id: &str| format!("spawn-approval-{reference}-{}", MessageRef::of(id));
    // The leaders' copies go out apart from the owner's and requester's.
    f.server
        .wait_for("the leader's copy", |server| {
            server.calls("POST", "/v1/dm").len() >= 3
        })
        .await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let mut dms = f.approval_dms();
    dms.sort();
    assert_eq!(
        dms,
        vec![
            ("grokbot".into(), expected.clone(), key(&f.requester.id)),
            ("lead".into(), expected.clone(), key(&f.lead.id)),
            ("owner".into(), expected, key(&f.owner.id)),
        ]
    );
    assert!(!f.approval_dms().iter().any(|(to, _, _)| to == &taken.name));
    assert!(codex_drive::unforwarded(THREAD).is_empty());
}

// A leader's copy that fails to send neither holds the notice back nor sends
// the owner's twice.
#[tokio::test]
async fn a_leaders_copy_that_fails_never_blocks_or_repeats_the_owners() {
    let f = fixture().await;
    f.set(Some(true), Some(false), None);
    f.server
        .set_api_error("POST /v1/dm to=lead", Some((500, "unavailable")));
    const THREAD: &str = "01a1235e-70e1-7cb1-8619-e2c8bf3bd016";
    let registration = f.spawned("codex", THREAD);
    let notice = codex_request(THREAD, 441);
    f.core
        .forward_to_owner(&registration, &f.token(), &notice)
        .await;
    assert!(codex_drive::unforwarded(THREAD).is_empty(), "forwarded");
    f.server
        .wait_for("the leader's copy", |server| {
            server
                .calls("POST", "/v1/dm")
                .iter()
                .any(|call| call.body["to"] == "lead")
        })
        .await;
    let to: Vec<String> = f.approval_dms().into_iter().map(|(to, _, _)| to).collect();
    assert_eq!(to.iter().filter(|to| *to == "owner").count(), 1);
    assert!(to.iter().all(|to| to == "owner" || to == "lead"), "{to:?}");
    let text = &f.approval_dms()[0].1;
    assert!(
        text.ends_with(
            "The signed-in machine owner or a workspace leader may answer; \
             the first answer counts."
        ),
        "{text}"
    );
}

// A request a leader cannot answer is not sent to it, and its notice is as
// it is with the setting off.
#[tokio::test]
async fn a_request_that_is_not_approvable_is_never_sent_to_a_leader() {
    let f = fixture().await;
    f.set(Some(true), None, None);
    const SESSION: &str = "a1d0c2e4-0000-4000-8000-00000000d017";
    let claude = f.spawned("claude", SESSION);
    let dialog = json!({"type": "control_request", "request_id": "dialog17", "request": {
        "subtype": "request_user_dialog"}});
    let notice = claude_registered(SESSION, &dialog);
    f.core.forward_request(&claude, &f.token(), &notice).await;
    let dms = f.approval_dms();
    let to: Vec<&str> = dms.iter().map(|(to, _, _)| to.as_str()).collect();
    assert_eq!(to, ["owner", "grokbot"]);
    assert_eq!(
        dms[0].1,
        crate::relay::spawn::drive::claude::approval_text_for("c1", &notice, Some("grokbot"))
    );
    assert!(!dms[0].1.contains("leader"));
    requests::forget(SESSION);
}

// The notice never names the leaders: one fixed sentence says a workspace
// leader may answer, and without leaders it is as it is with the setting off.
#[test]
fn the_notice_says_a_workspace_leader_may_answer_in_a_fixed_sentence() {
    use crate::relay::spawn::drive::{who_may_answer, who_may_answer_with, Leaders};
    assert_eq!(
        who_may_answer_with(None, Leaders::Listed),
        "The signed-in machine owner or a workspace leader may answer; the first answer counts."
    );
    assert_eq!(
        who_may_answer_with(Some("grokbot"), Leaders::Listed),
        "The signed-in machine owner, @grokbot (the agent that spawned this session) \
         or a workspace leader may answer; the first answer counts."
    );
    // While the organization holds, only a leader that is one of its admins.
    assert_eq!(
        who_may_answer_with(None, Leaders::Admins),
        "The signed-in machine owner or a workspace leader that is one of the \
         organization's admins may answer; the first answer counts."
    );
    assert_eq!(
        who_may_answer_with(Some("grokbot"), Leaders::Admins),
        "The signed-in machine owner, @grokbot (the agent that spawned this session) \
         or a workspace leader that is one of the organization's admins may answer; \
         the first answer counts."
    );
    assert_eq!(
        who_may_answer_with(Some("grokbot"), Leaders::Not),
        who_may_answer(Some("grokbot"))
    );
    assert_eq!(
        who_may_answer_with(None, Leaders::Not),
        who_may_answer(None)
    );
}

/// The fixture with no verified owner: the computer is not claimed by the
/// signed-in person.
fn unclaimed(f: &Fixture) {
    f.core.hub.update(|status| {
        status.spawn.as_mut().unwrap().claim = None;
    });
}

/// The copies of an approval DM sent to `to`: (text, idempotency key).
fn copies_to(f: &Fixture, to: &str) -> Vec<(String, String)> {
    f.approval_dms()
        .into_iter()
        .filter(|(recipient, _, _)| recipient == to)
        .map(|(_, text, key)| (text, key))
        .collect()
}

// With no verified owner and no requester, nothing marks the notice
// forwarded, so the watcher tries it again every second. The leaders are
// looked up once and each sent one copy, however often it is tried.
#[tokio::test]
async fn with_no_owner_and_no_requester_each_leader_gets_one_copy_not_one_per_tick() {
    let f = fixture().await;
    f.set(Some(true), Some(false), None);
    unclaimed(&f);
    let second = f.server.seed_agent("lead2", "agent", json!({}));
    f.server.seed_conversation("lead2", "c1");
    f.leaders(json!([
        {"name": "lead", "agent_id": f.lead.id},
        {"name": "lead2", "agent_id": second.id}
    ]));
    const THREAD: &str = "01a1235e-70e1-7cb1-8619-e2c8bf3bd020";
    let registration = f.spawned("codex", THREAD);
    let notice = codex_request(THREAD, 501);
    let reads = || f.server.calls("GET", "/v1/workspace/leaders").len();
    let before = reads();
    for _ in 0..5 {
        f.core
            .forward_to_owner(&registration, &f.token(), &notice)
            .await;
    }
    f.server
        .wait_for("both leaders' copies", |server| {
            let dms = server.calls("POST", "/v1/dm");
            ["lead", "lead2"]
                .iter()
                .all(|to| dms.iter().any(|call| call.body["to"] == *to))
        })
        .await;
    for _ in 0..3 {
        f.core
            .forward_to_owner(&registration, &f.token(), &notice)
            .await;
    }
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(copies_to(&f, "lead").len(), 1, "{:?}", f.approval_dms());
    assert_eq!(copies_to(&f, "lead2").len(), 1, "{:?}", f.approval_dms());
    assert!(copies_to(&f, "owner").is_empty());
    assert!(reads() - before <= 1, "{} list reads", reads() - before);
    assert_eq!(f.server.calls("GET", "/v1/agents/lead").len(), 1);
    assert_eq!(f.server.calls("GET", "/v1/agents/lead2").len(), 1);
    // Still not forwarded: a leader's copy never counts.
    assert_eq!(codex_drive::unforwarded(THREAD).len(), 1);
}

// A leader's copy that fails is sent again a few times, never once per tick,
// and always with the same text under the same key.
#[tokio::test]
async fn a_failed_leader_copy_is_retried_a_bounded_number_of_times_with_the_same_body() {
    let f = fixture().await;
    f.set(Some(true), Some(false), None);
    unclaimed(&f);
    f.server
        .set_api_error("POST /v1/dm to=lead", Some((500, "unavailable")));
    const THREAD: &str = "01a1235e-70e1-7cb1-8619-e2c8bf3bd021";
    let registration = f.spawned("codex", THREAD);
    let notice = codex_request(THREAD, 511);
    for _ in 0..3 {
        f.core
            .forward_to_owner(&registration, &f.token(), &notice)
            .await;
    }
    // The client tries each send three times itself on a 5xx: one send
    // is three POSTs.
    let sends = crate::relay::spawn::drive::LEADER_SENDS as usize * 3;
    f.server
        .wait_for("every send of the leader's copy", |server| {
            server
                .calls("POST", "/v1/dm")
                .iter()
                .filter(|call| call.body["to"] == "lead")
                .count()
                >= sends
        })
        .await;
    for _ in 0..3 {
        f.core
            .forward_to_owner(&registration, &f.token(), &notice)
            .await;
    }
    tokio::time::sleep(Duration::from_millis(1500)).await;
    let copies = copies_to(&f, "lead");
    assert_eq!(copies.len(), sends);
    let first = copies[0].clone();
    assert!(copies.iter().all(|copy| *copy == first), "{copies:?}");
    assert_eq!(
        first.1,
        format!(
            "spawn-approval-{}-{}",
            notice.reference,
            MessageRef::of(&f.lead.id)
        )
    );
    // Relaycast is asked again, just before each send, whom the name is.
    assert_eq!(
        f.server.calls("GET", "/v1/agents/lead").len(),
        crate::relay::spawn::drive::LEADER_SENDS as usize
    );
}

// The text sent under one key never changes, though the setting or the list
// changes between tries.
#[tokio::test]
async fn the_owners_copy_keeps_its_text_when_the_setting_changes_between_tries() {
    let f = fixture().await;
    f.set(Some(true), Some(false), None);
    f.server
        .set_api_error("POST /v1/dm to=owner", Some((500, "unavailable")));
    const THREAD: &str = "01a1235e-70e1-7cb1-8619-e2c8bf3bd022";
    let registration = f.spawned("codex", THREAD);
    let notice = codex_request(THREAD, 521);
    f.core
        .forward_to_owner(&registration, &f.token(), &notice)
        .await;
    f.set(Some(false), Some(false), None);
    f.leaders(json!([]));
    f.server.set_api_error("POST /v1/dm to=owner", None);
    f.core
        .forward_to_owner(&registration, &f.token(), &notice)
        .await;
    assert!(codex_drive::unforwarded(THREAD).is_empty(), "forwarded");
    let copies = copies_to(&f, "owner");
    assert!(copies.len() >= 2, "{copies:?}");
    assert!(copies.iter().all(|copy| *copy == copies[0]), "{copies:?}");
    assert!(copies[0].0.contains("or a workspace leader may answer"));
}

// The owner's copy never waits for the leaders: a list read held (or failing),
// or a leader's name check held, leaves it to go at once.
#[tokio::test]
async fn the_owners_copy_is_never_held_by_a_slow_or_failing_leader_lookup() {
    let f = fixture().await;
    f.set(Some(true), Some(false), None);
    const THREAD: &str = "01a1235e-70e1-7cb1-8619-e2c8bf3bd023";
    let registration = f.spawned("codex", THREAD);

    // The list read held.
    f.core.leaders.age(crate::relay::leaders::REFRESH_AFTER);
    let release = f.server.hold("GET /v1/workspace/leaders");
    let notice = codex_request(THREAD, 531);
    tokio::time::timeout(
        Duration::from_secs(1),
        f.core.forward_to_owner(&registration, &f.token(), &notice),
    )
    .await
    .expect("the owner's copy waited for the list");
    assert_eq!(copies_to(&f, "owner").len(), 1);
    assert!(codex_drive::unforwarded(THREAD).is_empty(), "forwarded");
    f.server
        .wait_for("the held list read", |server| {
            server.held("GET /v1/workspace/leaders") >= 1
        })
        .await;
    assert!(copies_to(&f, "lead").is_empty());
    release.send(true).unwrap();
    f.server
        .wait_for("the leader's copy once the list came", |server| {
            server
                .calls("POST", "/v1/dm")
                .iter()
                .any(|call| call.body["to"] == "lead")
        })
        .await;

    // The leader's name check held.
    let release = f.server.hold("GET /v1/agents/lead");
    let notice = codex_request(THREAD, 532);
    tokio::time::timeout(
        Duration::from_secs(1),
        f.core.forward_to_owner(&registration, &f.token(), &notice),
    )
    .await
    .expect("the owner's copy waited for the leader's name check");
    assert_eq!(copies_to(&f, "owner").len(), 2);
    assert!(codex_drive::unforwarded(THREAD).is_empty(), "forwarded");
    release.send(true).unwrap();

    // The list read failing.
    f.server.set_failing(&["GET /v1/workspace/leaders"]);
    f.core.leaders.age(crate::relay::leaders::REFRESH_AFTER);
    let notice = codex_request(THREAD, 533);
    tokio::time::timeout(
        Duration::from_secs(1),
        f.core.forward_to_owner(&registration, &f.token(), &notice),
    )
    .await
    .expect("the owner's copy waited for a failing list");
    assert_eq!(copies_to(&f, "owner").len(), 3);
    assert!(codex_drive::unforwarded(THREAD).is_empty(), "forwarded");
}

// A Claude's notice too: the leaders are looked up once, each gets one copy.
#[tokio::test]
async fn a_claude_notice_reaches_each_leader_once_with_no_owner_and_no_requester() {
    let f = fixture().await;
    f.set(Some(true), Some(false), None);
    unclaimed(&f);
    const SESSION: &str = "a1d0c2e4-0000-4000-8000-00000000d024";
    let claude = f.spawned("claude", SESSION);
    let notice = claude_request(SESSION, "n24");
    for _ in 0..5 {
        f.core.forward_request(&claude, &f.token(), &notice).await;
    }
    f.server
        .wait_for("the leader's copy", |server| {
            server
                .calls("POST", "/v1/dm")
                .iter()
                .any(|call| call.body["to"] == "lead")
        })
        .await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let copies = copies_to(&f, "lead");
    assert_eq!(copies.len(), 1, "{copies:?}");
    assert!(copies[0].0.ends_with(
        "The signed-in machine owner or a workspace leader may answer; the first answer counts."
    ));
    assert_eq!(f.server.calls("GET", "/v1/agents/lead").len(), 1);
    requests::forget(SESSION);
}

// Answers are checked again once the list comes back: the setting turned off,
// or the session taken over, while it was read makes no approver.
#[tokio::test]
async fn the_setting_and_takeover_are_checked_again_after_the_list_is_read() {
    let f = fixture().await;
    f.set(Some(true), None, None);
    const THREAD: &str = "01a1235e-70e1-7cb1-8619-e2c8bf3bd025";
    let registration = f.spawned("codex", THREAD);
    for (index, change) in ["setting off", "taken over"].into_iter().enumerate() {
        f.set(Some(true), None, None);
        let notice = codex_request(THREAD, 541 + index as u64);
        f.core.leaders.age(crate::relay::leaders::REFRESH_AFTER);
        let held = f.server.held("GET /v1/workspace/leaders");
        let release = f.server.hold("GET /v1/workspace/leaders");
        let reply = dm(
            &format!("recheck-{index}"),
            &f.lead,
            &format!("approve {}", notice.reference),
        );
        let answering = {
            let (core, registration) = (f.core.clone(), registration.clone());
            tokio::spawn(async move { core.owner_reply(&registration, &reply).await })
        };
        f.server
            .wait_for("the held list read", |server| {
                server.held("GET /v1/workspace/leaders") > held
            })
            .await;
        if change == "setting off" {
            f.set(Some(false), None, None);
        } else {
            f.core
                .store
                .update(|store| {
                    let saved = store
                        .registrations
                        .iter_mut()
                        .find(|saved| saved.agent_id == registration.agent_id)
                        .unwrap();
                    saved.spawn.as_mut().unwrap().taken_over_at =
                        Some("2026-10-28T01:00:00Z".into());
                })
                .unwrap();
        }
        release.send(true).unwrap();
        assert!(not_one(answering.await.unwrap()), "{change}");
        assert!(
            codex_drive::has_pending(THREAD, &notice.reference),
            "{change}"
        );
        assert_eq!(codex_drive::recorded_answer(&notice.reference), None);
    }
}

// A list read that times out (`report_back::REQUESTER_WAIT`) makes no
// approver.
#[tokio::test]
async fn a_list_read_that_times_out_makes_no_approver() {
    let f = fixture().await;
    f.set(Some(true), None, None);
    const THREAD: &str = "01a1235e-70e1-7cb1-8619-e2c8bf3bd026";
    let registration = f.spawned("codex", THREAD);
    let notice = codex_request(THREAD, 551);
    f.core.leaders.age(crate::relay::leaders::REFRESH_AFTER);
    let release = f.server.hold("GET /v1/workspace/leaders");
    let reply = dm("timeout", &f.lead, &format!("approve {}", notice.reference));
    assert!(not_one(f.core.owner_reply(&registration, &reply).await));
    assert!(f.server.held("GET /v1/workspace/leaders") >= 1);
    assert!(codex_drive::has_pending(THREAD, &notice.reference));
    release.send(true).unwrap();
}

// With the setting off the leaders are never looked up: no list read and no
// name check for a leader, for a notice or for a leader's reply.
#[tokio::test]
async fn with_the_setting_off_the_leaders_are_never_looked_up() {
    let f = fixture().await;
    f.set(None, Some(true), None);
    f.core.leaders.age(crate::relay::leaders::REFRESH_AFTER);
    let reads = || f.server.calls("GET", "/v1/workspace/leaders").len();
    let before = reads();
    const THREAD: &str = "01a1235e-70e1-7cb1-8619-e2c8bf3bd027";
    let registration = f.spawned("codex", THREAD);
    let notice = codex_request(THREAD, 561);
    f.core
        .forward_to_owner(&registration, &f.token(), &notice)
        .await;
    let reply = dm(
        "off-lookup",
        &f.lead,
        &format!("approve {}", notice.reference),
    );
    assert!(not_one(f.core.owner_reply(&registration, &reply).await));
    const SESSION: &str = "a1d0c2e4-0000-4000-8000-00000000d027";
    let claude = f.spawned("claude", SESSION);
    let request = claude_request(SESSION, "n27");
    f.core.forward_request(&claude, &f.token(), &request).await;
    let reply = dm(
        "off-lookup-claude",
        &f.lead,
        &format!("approve {}", request.reference),
    );
    assert!(not_one(f.core.owner_reply(&claude, &reply).await));
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(reads(), before, "the list was read");
    assert!(f.server.calls("GET", "/v1/agents/lead").is_empty());
    assert!(copies_to(&f, "lead").is_empty());
    requests::forget(SESSION);
}

// Claude: a leader approves and denies an MCP tool's request and leaving plan
// mode.
#[tokio::test]
async fn a_leader_approves_and_denies_a_claude_mcp_tool_and_exit_plan_mode() {
    let f = fixture().await;
    f.set(Some(true), None, None);
    const SESSION: &str = "a1d0c2e4-0000-4000-8000-00000000d028";
    let claude = f.spawned("claude", SESSION);
    let tool = |id: &str, name: &str| {
        json!({"type": "control_request", "request_id": id, "request": {
            "subtype": "can_use_tool", "tool_name": name, "input": {}}})
    };
    for (id, name, verb, behavior) in [
        (
            "mcp-approve",
            "mcp__github__create_issue",
            "approve",
            "allow",
        ),
        ("mcp-deny", "mcp__github__create_issue", "deny", "deny"),
        ("plan-approve", "ExitPlanMode", "approve", "allow"),
        ("plan-deny", "ExitPlanMode", "deny", "deny"),
    ] {
        let notice = claude_registered(SESSION, &tool(id, name));
        assert!(notice.approvable, "{id}");
        let reply = dm(id, &f.lead, &format!("{verb} {}", notice.reference));
        assert_eq!(
            settled(f.core.owner_reply(&claude, &reply).await),
            format!("Claude approval reply from {}: Answered", by_leader(&f)),
            "{id}"
        );
        let due = requests::due(SESSION);
        let (_, line) = due
            .iter()
            .find(|(reference, _)| *reference == notice.reference)
            .unwrap_or_else(|| panic!("{id}: no answer due"));
        assert!(
            line.contains(&format!(r#""behavior":"{behavior}""#)),
            "{id}: {line}"
        );
    }
    requests::forget(SESSION);
}

// With no verified owner (the computer not claimed by the signed-in person),
// a leader still answers. This is the current behaviour; a later decision
// to require a verified owner changes this test.
#[tokio::test]
async fn with_no_verified_owner_a_leader_still_answers() {
    let f = fixture().await;
    f.set(Some(true), None, None);
    unclaimed(&f);
    const THREAD: &str = "01a1235e-70e1-7cb1-8619-e2c8bf3bd029";
    let registration = f.spawned("codex", THREAD);
    assert!(f.core.verified_owner(&registration).await.is_none());
    let notice = codex_request(THREAD, 571);
    let reply = dm(
        "no-owner",
        &f.lead,
        &format!("approve {}", notice.reference),
    );
    assert_eq!(
        settled(f.core.owner_reply(&registration, &reply).await),
        format!("Codex approval reply from {}: Answered", by_leader(&f))
    );
    let answer = codex_drive::recorded_answer(&notice.reference).unwrap();
    assert_eq!(answer["decision"], "accept", "{answer}");
}

// While the organization holds messages from senders who are not its
// admins (`claude_delivery_policy`), a leader's reply answers a request only
// when the delivery policy would deliver it: the leader is one of the
// organization's admins, by authenticated address or by name.

use crate::relay::claude_delivery_policy::Decision as Consent;

/// `delivery` with the authenticated sender address Relaycast gives it.
fn addressed(mut delivery: Delivery, address: &str) -> Delivery {
    delivery.sender_address = Some(address.into());
    delivery
}

/// Holds every sender's messages but `admins`' (names or addresses).
fn organization_holds(f: &Fixture, admins: &[&str]) {
    f.core
        .claude_delivery
        .set_organization_hold(Some(admins.iter().map(|admin| admin.to_string()).collect()));
}

#[tokio::test]
async fn under_an_organization_hold_a_leader_that_is_not_an_admin_never_answers() {
    let f = fixture().await;
    f.set(Some(true), None, None);
    organization_holds(&f, &["someone-else", "someone@else"]);
    const THREAD: &str = "01a1235e-70e1-7cb1-8619-e2c8bf3bd101";
    let registration = f.spawned("codex", THREAD);
    let notice = codex_request(THREAD, 901);
    let reply = addressed(
        dm(
            "hold-not-admin",
            &f.lead,
            &format!("approve {}", notice.reference),
        ),
        "lead@desk",
    );
    assert!(not_one(f.core.owner_reply(&registration, &reply).await));
    // Nothing answered or recorded; the request is still open.
    assert!(codex_drive::has_pending(THREAD, &notice.reference));
    assert_eq!(codex_drive::recorded_answer(&notice.reference), None);
    assert!(!f
        .core
        .store
        .read(|store| store.injected_delivery_ids.contains(&reply.id)));
    // The ordinary path then holds the message for the person.
    assert_eq!(
        f.core.claude_delivery.decide(&registration, &reply),
        Consent::Hold
    );
    // A Claude session too.
    const SESSION: &str = "a1d0c2e4-0000-4000-8000-00000000d101";
    let claude = f.spawned("claude", SESSION);
    let request = claude_request(SESSION, "h1");
    let reply = addressed(
        dm(
            "hold-not-admin-claude",
            &f.lead,
            &format!("approve {}", request.reference),
        ),
        "lead@desk",
    );
    assert!(not_one(f.core.owner_reply(&claude, &reply).await));
    assert!(requests::due(SESSION).is_empty());
    requests::forget(SESSION);
}

#[tokio::test]
async fn under_an_organization_hold_an_admin_leader_answers_by_address_or_by_name() {
    let f = fixture().await;
    f.set(Some(true), None, None);
    const THREAD: &str = "01a1235e-70e1-7cb1-8619-e2c8bf3bd102";
    let registration = f.spawned("codex", THREAD);
    for (index, admins) in [["lead@desk", "other"], ["lead", "other"]]
        .iter()
        .enumerate()
    {
        organization_holds(&f, admins);
        let notice = codex_request(THREAD, 911 + index as u64);
        let reply = addressed(
            dm(
                &format!("hold-admin-{index}"),
                &f.lead,
                &format!("approve {}", notice.reference),
            ),
            "lead@desk",
        );
        assert_eq!(
            settled(f.core.owner_reply(&registration, &reply).await),
            format!("Codex approval reply from {}: Answered", by_leader(&f)),
            "{admins:?}"
        );
        let answer = codex_drive::recorded_answer(&notice.reference).unwrap();
        assert_eq!(answer["decision"], "accept", "{answer}");
    }
}

// Only an authenticated address proves who sent a message: without one the
// policy reads the queue first, and no leader answers meanwhile.
#[tokio::test]
async fn under_an_organization_hold_a_reply_without_a_sender_address_never_answers() {
    let f = fixture().await;
    f.set(Some(true), None, None);
    organization_holds(&f, &["lead"]);
    const THREAD: &str = "01a1235e-70e1-7cb1-8619-e2c8bf3bd103";
    let registration = f.spawned("codex", THREAD);
    let notice = codex_request(THREAD, 921);
    let reply = dm(
        "hold-no-address",
        &f.lead,
        &format!("approve {}", notice.reference),
    );
    assert_eq!(
        f.core.claude_delivery.decide(&registration, &reply),
        Consent::ReadQueue
    );
    assert!(not_one(f.core.owner_reply(&registration, &reply).await));
    assert!(codex_drive::has_pending(THREAD, &notice.reference));
    assert_eq!(codex_drive::recorded_answer(&notice.reference), None);
}

#[tokio::test]
async fn a_hold_that_begins_after_the_notice_wins_and_one_lifted_lets_leaders_answer_again() {
    let f = fixture().await;
    f.set(Some(true), None, None);
    const THREAD: &str = "01a1235e-70e1-7cb1-8619-e2c8bf3bd104";
    let registration = f.spawned("codex", THREAD);
    let notice = codex_request(THREAD, 931);
    // Noticed with no hold: any listed leader may answer, it said.
    f.core
        .forward_to_owner(&registration, &f.token(), &notice)
        .await;
    f.server
        .wait_for("the leader's copy", |server| {
            server
                .calls("POST", "/v1/dm")
                .iter()
                .any(|call| call.body["to"] == "lead")
        })
        .await;
    organization_holds(&f, &["someone-else"]);
    let approve = format!("approve {}", notice.reference);
    let reply = addressed(dm("hold-begun", &f.lead, &approve), "lead@desk");
    assert!(not_one(f.core.owner_reply(&registration, &reply).await));
    assert!(codex_drive::has_pending(THREAD, &notice.reference));
    assert_eq!(codex_drive::recorded_answer(&notice.reference), None);
    // Lifted: the same leader answers again.
    f.core.claude_delivery.set_organization_hold(None);
    let reply = addressed(dm("hold-lifted", &f.lead, &approve), "lead@desk");
    assert_eq!(
        settled(f.core.owner_reply(&registration, &reply).await),
        format!("Codex approval reply from {}: Answered", by_leader(&f))
    );
}

// A hold that begins while the leader list is read wins.
#[tokio::test]
async fn a_hold_that_begins_during_the_list_read_makes_no_approver() {
    let f = fixture().await;
    f.set(Some(true), None, None);
    const THREAD: &str = "01a1235e-70e1-7cb1-8619-e2c8bf3bd105";
    let registration = f.spawned("codex", THREAD);
    let notice = codex_request(THREAD, 941);
    f.core.leaders.age(crate::relay::leaders::REFRESH_AFTER);
    let held = f.server.held("GET /v1/workspace/leaders");
    let release = f.server.hold("GET /v1/workspace/leaders");
    let reply = addressed(
        dm(
            "hold-during-read",
            &f.lead,
            &format!("approve {}", notice.reference),
        ),
        "lead@desk",
    );
    let answering = {
        let (core, registration) = (f.core.clone(), registration.clone());
        tokio::spawn(async move { core.owner_reply(&registration, &reply).await })
    };
    f.server
        .wait_for("the held list read", |server| {
            server.held("GET /v1/workspace/leaders") > held
        })
        .await;
    organization_holds(&f, &["someone-else"]);
    release.send(true).unwrap();
    assert!(not_one(answering.await.unwrap()));
    assert!(codex_drive::has_pending(THREAD, &notice.reference));
    assert_eq!(codex_drive::recorded_answer(&notice.reference), None);
}

// Under a hold the notice goes only to a leader whose verified name is one
// of the organization's admins (they are listed by name and address; the
// leader list gives names), and says so.
#[tokio::test]
async fn under_an_organization_hold_notices_go_only_to_leaders_named_among_the_admins() {
    let f = fixture().await;
    f.set(Some(true), Some(false), None);
    unclaimed(&f);
    let second = f.server.seed_agent("lead2", "agent", json!({}));
    f.leaders(json!([
        {"name": "lead", "agent_id": f.lead.id},
        {"name": "lead2", "agent_id": second.id}
    ]));
    // lead2 is an admin by address only: it gets no notice.
    organization_holds(&f, &["lead", "lead2@desk"]);
    const THREAD: &str = "01a1235e-70e1-7cb1-8619-e2c8bf3bd106";
    let registration = f.spawned("codex", THREAD);
    let notice = codex_request(THREAD, 951);
    f.core
        .forward_to_owner(&registration, &f.token(), &notice)
        .await;
    f.server
        .wait_for("the admin leader's copy", |server| {
            server
                .calls("POST", "/v1/dm")
                .iter()
                .any(|call| call.body["to"] == "lead")
        })
        .await;
    tokio::time::sleep(Duration::from_millis(400)).await;
    let copies = copies_to(&f, "lead");
    assert_eq!(copies.len(), 1, "{:?}", f.approval_dms());
    assert!(
        copies[0]
            .0
            .ends_with("a workspace leader that is one of the organization's admins may answer; the first answer counts."),
        "{}",
        copies[0].0
    );
    assert!(copies_to(&f, "lead2").is_empty(), "{:?}", f.approval_dms());
}

// Each try at a leader's copy checks again, just before it sends, that the
// request is open, leaders may answer, the leader is still listed, and
// Relaycast gives its name its id. The first send fails; `change` is made
// while it is in flight, and no copy is sent again.
async fn no_resend_after(thread: &str, id: u64, change: impl FnOnce(&Fixture)) -> Fixture {
    let f = fixture().await;
    f.set(Some(true), Some(false), None);
    unclaimed(&f);
    let registration = f.spawned("codex", thread);
    let notice = codex_request(thread, id);
    f.server
        .set_api_error("POST /v1/dm to=lead", Some((500, "unavailable")));
    let release = f.server.hold("POST /v1/dm");
    f.core
        .forward_to_owner(&registration, &f.token(), &notice)
        .await;
    f.server
        .wait_for("the first send", |server| server.held("POST /v1/dm") >= 1)
        .await;
    change(&f);
    release.send(true).unwrap();
    // The client tries one send three times itself on a 5xx.
    f.server
        .wait_for("the failed first send", |server| {
            server
                .calls("POST", "/v1/dm")
                .iter()
                .filter(|call| call.body["to"] == "lead")
                .count()
                >= 3
        })
        .await;
    f.server.set_api_error("POST /v1/dm to=lead", None);
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert_eq!(copies_to(&f, "lead").len(), 3, "{:?}", f.approval_dms());
    f
}

#[tokio::test]
async fn a_leaders_name_taken_by_another_agent_after_a_failed_send_gets_no_resend() {
    let f = no_resend_after("01a1235e-70e1-7cb1-8619-e2c8bf3bd107", 961, |f| {
        f.server.forget_agent("lead");
        f.server.seed_agent("lead", "agent", json!({}));
    })
    .await;
    // Asked once per try: the second answered with another id.
    assert_eq!(f.server.calls("GET", "/v1/agents/lead").len(), 2);
}

#[tokio::test]
async fn a_setting_turned_off_between_tries_stops_the_resend() {
    no_resend_after("01a1235e-70e1-7cb1-8619-e2c8bf3bd108", 971, |f| {
        f.set(Some(false), Some(false), None)
    })
    .await;
}

#[tokio::test]
async fn a_leader_dropped_from_the_list_between_tries_gets_no_resend() {
    no_resend_after("01a1235e-70e1-7cb1-8619-e2c8bf3bd109", 981, |f| {
        f.leaders(json!([]))
    })
    .await;
}

// A try on which Relaycast cannot be asked whom the name is sends nothing
// and counts as a try; a later try that is told the name is the leader's
// sends.
#[tokio::test]
async fn a_try_whose_name_check_cannot_be_made_sends_nothing_and_a_later_one_sends() {
    let f = fixture().await;
    f.set(Some(true), Some(false), None);
    unclaimed(&f);
    const THREAD: &str = "01a1235e-70e1-7cb1-8619-e2c8bf3bd110";
    let registration = f.spawned("codex", THREAD);
    let notice = codex_request(THREAD, 991);
    f.server
        .set_api_error("GET /v1/agents/lead", Some((400, "bad_request")));
    f.core
        .forward_to_owner(&registration, &f.token(), &notice)
        .await;
    f.server
        .wait_for("the first name check", |server| {
            !server.calls("GET", "/v1/agents/lead").is_empty()
        })
        .await;
    let release = f.server.hold("GET /v1/agents/lead");
    f.server
        .wait_for("the second try's name check", |server| {
            server.held("GET /v1/agents/lead") >= 1
        })
        .await;
    assert!(copies_to(&f, "lead").is_empty(), "{:?}", f.approval_dms());
    f.server.set_api_error("GET /v1/agents/lead", None);
    release.send(true).unwrap();
    f.server
        .wait_for("the leader's copy", |server| {
            server
                .calls("POST", "/v1/dm")
                .iter()
                .any(|call| call.body["to"] == "lead")
        })
        .await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(copies_to(&f, "lead").len(), 1, "{:?}", f.approval_dms());
}

// On a gate-only install the leader list cannot be read and a session's
// workspace cannot be checked: the setting is listed unavailable with why,
// turning it on is refused, and no leader is sent a notice or answers.
#[tokio::test]
async fn on_a_gate_only_install_leader_approvals_are_unavailable_and_say_why() {
    let f = fixture().await;
    // With a workspace key, listed and available as before.
    let keyed = f.core.settings();
    assert_eq!(keyed[crate::relay::leaders::SETTING], false);
    let entry = crate::relay::settings_registry::describe(&keyed)
        .into_iter()
        .find(|entry| entry["key"] == crate::relay::leaders::SETTING)
        .unwrap();
    assert_eq!(
        (&entry["available"], &entry["writable"]),
        (&json!(true), &json!(true))
    );
    assert!(entry.get("unavailable").is_none());
    // `settings` reads a due list in the background: let it finish.
    let workspace = f.core.workspace().unwrap();
    f.server
        .wait_for("the keyed list read", |_| !f.core.leaders.due(&workspace))
        .await;
    f.core
        .store
        .update(|store| {
            store.cloud = Some(CloudWorkspace {
                key: Secret::default(),
                base_url: f.server.base_url.clone(),
                gate_url: Some(f.server.base_url.clone()),
                ..Default::default()
            });
        })
        .unwrap();
    std::thread::scope(|scope| {
        scope
            .spawn(|| f.core.rediscover_workspace())
            .join()
            .unwrap()
    });
    assert!(f.core.workspace().unwrap().is_gate_only());

    let values = f.core.settings();
    assert!(!values.contains_key(crate::relay::leaders::SETTING));
    let listed = crate::relay::settings_registry::describe(&values);
    let entry = listed
        .iter()
        .find(|entry| entry["key"] == crate::relay::leaders::SETTING)
        .unwrap();
    assert_eq!(entry["available"], false);
    assert_eq!(entry["writable"], false);
    assert_eq!(entry["unavailable"], crate::relay::leaders::GATE_ONLY);
    let on = json!({"spawn_leader_approvals": true});
    let refused = f.core.set_settings(on.as_object().unwrap()).unwrap_err();
    assert_eq!(refused.message, crate::relay::leaders::GATE_ONLY);
    assert_eq!(
        f.core
            .store
            .read(|store| store.extras.spawn_leader_approvals),
        None
    );
    let off = json!({"spawn_leader_approvals": false});
    f.core.set_settings(off.as_object().unwrap()).unwrap();

    // Even set on as the store saves it, and with a session whose saved key
    // is the gate workspace's (empty) one, leaders may not answer: the
    // notice says only the owner may, and the list is never read.
    f.set(Some(true), Some(false), None);
    const THREAD: &str = "01a1235e-70e1-7cb1-8619-e2c8bf3bd111";
    let mut registration = f.spawned("codex", THREAD);
    f.core
        .store
        .update(|store| {
            let saved = store
                .registrations
                .iter_mut()
                .find(|saved| saved.agent_id == registration.agent_id)
                .unwrap();
            saved.workspace_key = Some(Secret::default());
            registration = saved.clone();
        })
        .unwrap();
    let reads = f.server.calls("GET", "/v1/workspace/leaders").len();
    // By the explicit check, not a failed read: the text is fixed before
    // any list is read.
    let plan = f.core.approval_plan(
        &registration,
        &f.token(),
        "00000000000000a1",
        true,
        |leaders| format!("{leaders:?}"),
    );
    assert_eq!(plan, "Not");
    let notice = codex_request(THREAD, 995);
    f.core
        .forward_to_owner(&registration, &f.token(), &notice)
        .await;
    let reply = dm(
        "gate-only",
        &f.lead,
        &format!("approve {}", notice.reference),
    );
    assert!(not_one(f.core.owner_reply(&registration, &reply).await));
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(copies_to(&f, "lead").is_empty(), "{:?}", f.approval_dms());
    assert!(f
        .approval_dms()
        .iter()
        .all(|(_, text, _)| !text.contains("workspace leader")));
    assert_eq!(f.server.calls("GET", "/v1/workspace/leaders").len(), reads);
    assert!(codex_drive::has_pending(THREAD, &notice.reference));
}

/// Relaycast lets a participant add a third agent to a 1:1 conversation
/// without changing its type: a leader's reply there is not a 1:1 direct
/// message, and no notice is sent into it.
#[tokio::test]
async fn a_conversation_with_a_third_participant_is_not_one_to_one() {
    let f = fixture().await;
    f.set(Some(true), Some(false), None);
    unclaimed(&f);
    f.server.seed_agent("outsider", "agent", json!({}));
    f.server.add_dm_participant("lead", "c1", "outsider");
    const THREAD: &str = "01a1235e-70e1-7cb1-8619-e2c8bf3bd201";
    let registration = f.spawned("codex", THREAD);
    let notice = codex_request(THREAD, 1201);
    let reply = dm("shared", &f.lead, &format!("approve {}", notice.reference));
    assert!(not_one(f.core.owner_reply(&registration, &reply).await));
    assert!(codex_drive::has_pending(THREAD, &notice.reference));
    f.core
        .forward_to_owner(&registration, &f.token(), &notice)
        .await;
    copies_settled(&f.core, 1).await;
    assert!(copies_to(&f, "lead").is_empty(), "{:?}", f.approval_dms());

    // A leader added to another agent's conversation with the session is
    // not in a 1:1 conversation with it either.
    let f = fixture().await;
    f.set(Some(true), None, None);
    f.server.seed_agent("other", "agent", json!({}));
    f.server.seed_conversation("other", "c1");
    f.server.add_dm_participant("other", "c1", "lead");
    const THREAD2: &str = "01a1235e-70e1-7cb1-8619-e2c8bf3bd202";
    let registration = f.spawned("codex", THREAD2);
    let notice = codex_request(THREAD2, 1202);
    let reply = dm(
        "elsewhere",
        &f.lead,
        &format!("approve {}", notice.reference),
    );
    assert!(not_one(f.core.owner_reply(&registration, &reply).await));
}

/// A conversation Relaycast does not list to the session (it never existed,
/// or the session left it) is not safe for a notice: its members cannot be
/// seen, so the leader gets no copy there.
#[tokio::test]
async fn no_notice_goes_to_a_leader_without_a_listed_private_conversation() {
    let f = fixture().await;
    f.set(Some(true), Some(false), None);
    unclaimed(&f);
    let unlisted = f.server.seed_agent("lead3", "agent", json!({}));
    f.leaders(json!([
        {"name": "lead", "agent_id": f.lead.id},
        {"name": "lead3", "agent_id": unlisted.id}
    ]));
    const THREAD: &str = "01a1235e-70e1-7cb1-8619-e2c8bf3bd203";
    let registration = f.spawned("codex", THREAD);
    let notice = codex_request(THREAD, 1203);
    f.core
        .forward_to_owner(&registration, &f.token(), &notice)
        .await;
    f.server
        .wait_for("the listed leader's copy", |server| {
            server
                .calls("POST", "/v1/dm")
                .iter()
                .any(|call| call.body["to"] == "lead")
        })
        .await;
    copies_settled(&f.core, 2).await;
    assert!(copies_to(&f, "lead3").is_empty(), "{:?}", f.approval_dms());
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

/// Only the conversation that carried the reply decides: a reply in the
/// private DM answers even though the leader is also in another agent's
/// conversation with the session, and a reply in that one does not.
#[tokio::test]
async fn the_conversation_that_carried_the_reply_decides() {
    let f = fixture().await;
    f.set(Some(true), None, None);
    f.server.seed_agent("other", "agent", json!({}));
    f.server.seed_conversation("other", "c1");
    f.server.add_dm_participant("other", "c1", "lead");
    const THREAD: &str = "01a1235e-70e1-7cb1-8619-e2c8bf3bd204";
    let registration = f.spawned("codex", THREAD);
    let first = codex_request(THREAD, 1204);
    let mut elsewhere = dm(
        "elsewhere",
        &f.lead,
        &format!("approve {}", first.reference),
    );
    elsewhere.channel_id = Some("dmch_c1_other".into());
    assert!(not_one(f.core.owner_reply(&registration, &elsewhere).await));
    let mut private = dm("private", &f.lead, &format!("approve {}", first.reference));
    private.channel_id = Some("dmch_c1_lead".into());
    assert!(settled(f.core.owner_reply(&registration, &private).await).ends_with("Answered"));
}
