//! With **Approvals from workspace leaders** on (`spawn_leader_approvals`,
//! off unless the machine owner turns it on) and native input from spawning
//! agents on, a workspace leader may approve or deny a spawned session's open
//! permission request by direct message, though it did not spawn the
//! session, with the machine owner's standing rather than the requester's:
//! neither `spawn_requester_approvals` nor the spawn's approval profile limits
//! it. Leaders are matched by agent id in a list read successfully within
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

// The leader has the owner's standing: approvals from the spawning agent off,
// or a profile that keeps the requester out, does not stop it. Native input
// from spawning agents off, a core without an account, and a session taken
// over do.
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

#[tokio::test]
async fn with_the_setting_on_each_listed_leader_gets_the_notice_and_is_named() {
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
         or a workspace leader (@lead) may answer; the first answer counts.",
        notice.description
    );
    let key = |id: &str| format!("spawn-approval-{reference}-{}", MessageRef::of(id));
    assert_eq!(
        f.approval_dms(),
        vec![
            ("owner".into(), expected.clone(), key(&f.owner.id)),
            ("grokbot".into(), expected.clone(), key(&f.requester.id)),
            ("lead".into(), expected, key(&f.lead.id)),
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
    let to: Vec<String> = f.approval_dms().into_iter().map(|(to, _, _)| to).collect();
    assert_eq!(to.iter().filter(|to| *to == "owner").count(), 1);
    assert!(to.iter().all(|to| to == "owner" || to == "lead"), "{to:?}");
    let text = &f.approval_dms()[0].1;
    assert!(
        text.ends_with(
            "The signed-in machine owner or a workspace leader (@lead) may answer; \
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

// A notice names at most a few leaders.
#[test]
fn the_notice_names_at_most_a_few_leaders() {
    use crate::relay::spawn::drive::who_may_answer_with;
    let names: Vec<String> = ["a", "b", "c", "d", "e"]
        .iter()
        .map(|name| name.to_string())
        .collect();
    assert_eq!(
        who_may_answer_with(None, &names[..1]),
        "The signed-in machine owner or a workspace leader (@a) may answer; the first answer counts."
    );
    assert_eq!(
        who_may_answer_with(None, &names),
        "The signed-in machine owner or a workspace leader (@a, @b, @c and 2 more) may answer; \
         the first answer counts."
    );
    assert_eq!(
        who_may_answer_with(Some("grokbot"), &names[..3]),
        "The signed-in machine owner, @grokbot (the agent that spawned this session) \
         or a workspace leader (@a, @b, @c) may answer; the first answer counts."
    );
    assert_eq!(
        who_may_answer_with(Some("grokbot"), &[]),
        crate::relay::spawn::drive::who_may_answer(Some("grokbot"))
    );
}
