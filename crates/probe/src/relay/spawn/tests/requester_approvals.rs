//! With **Approvals from the spawning agent** on (and native input from it),
//! the verified agent that spawned a session may answer that session's
//! permission and approval requests by direct message, as the machine owner
//! may; the first answer counts. No other agent, no channel post, no session
//! taken over, and no session that has ended.

use super::*;
use crate::relay::codex::app_server::drive as codex_drive;
use crate::relay::delivery::policy::Delivery;
use crate::relay::harness::claude::requests;
use crate::relay::spawn::drive::{approval_text, OwnerReply};
use crate::relay::spawn::launch::SpawnedProcess;
use crate::relay::store::SpawnRequester;

fn spawned(harness: &str, session: &str) -> Registration {
    let kind = if harness == "claude" {
        "claude-terminal"
    } else {
        "codex"
    };
    let mut registration: Registration = serde_json::from_value(json!({
        "name": "c1", "agentID": "agent_c1",
        "target": {"kind": kind, "id": session},
        "title": "c1", "baseURL": "http://localhost:9", "registeredAt": "2026-10-28T00:00:00Z",
        "spawn": {"nodeID": "node-1", "nodeName": "desk", "invocationID": "inv_c1", "harness": harness}
    }))
    .unwrap();
    let spawn = registration.spawn.as_mut().unwrap();
    spawn.requester = Some(SpawnRequester {
        name: "grokbot".into(),
        agent_id: "agent_grokbot".into(),
    });
    spawn.process = Some(SpawnedProcess {
        pid: 4242,
        start: 7,
    });
    registration
}

fn dm(sender: &str, sender_id: &str, text: &str) -> Delivery {
    Delivery {
        id: format!("d-{sender}"),
        message_id: format!("m-{sender}"),
        sender: Some(sender.into()),
        sender_id: Some(sender_id.into()),
        reason: Some("dm".into()),
        text: Some(text.into()),
        ..Delivery::default()
    }
}

fn spawner(dead: bool) -> Arc<FakeSpawner> {
    Arc::new(FakeSpawner {
        native: true,
        dead,
        ..FakeSpawner::default()
    })
}

fn set(core: &Core, native_input: Option<bool>, approvals: Option<bool>) {
    core.store
        .update(|store| {
            store.extras.spawn_native_input = native_input;
            store.extras.spawn_requester_approvals = approvals;
        })
        .unwrap();
}

fn claude_request(session: &str, request_id: &str) -> requests::Notice {
    let request = json!({"type": "control_request", "request_id": request_id, "request": {
        "subtype": "can_use_tool", "tool_name": "Bash", "input": {"command": "ls"}}});
    assert_eq!(requests::register(session, &request), None);
    requests::unforwarded(session).pop().unwrap()
}

fn settled(reply: OwnerReply) -> String {
    match reply {
        OwnerReply::Settled(detail) => detail,
        OwnerReply::NotOne => panic!("not taken as a reply"),
        OwnerReply::Unsaved => panic!("not saved"),
    }
}

#[tokio::test]
async fn the_spawning_agent_answers_its_claudes_request_and_the_first_answer_counts() {
    const SESSION: &str = "a1d0c2e4-0000-4000-8000-00000000c1a1";
    let home = tempfile::tempdir().unwrap();
    let core = core_with_account(home.path(), spawner(false));
    set(&core, None, Some(true));
    let registration = spawned("claude", SESSION);
    assert_eq!(
        core.approving_requester(&registration).map(|r| r.agent_id),
        Some("agent_grokbot".into())
    );
    let notice = claude_request(SESSION, "r1");

    let approval = dm(
        "grokbot",
        "agent_grokbot",
        &format!("approve {}", notice.reference),
    );
    assert_eq!(
        settled(core.owner_reply(&registration, &approval).await),
        "Claude approval reply from the spawning agent @grokbot (agent_grokbot): Answered"
    );
    assert!(core
        .store
        .read(|store| store.injected_delivery_ids.contains(&approval.id)));
    let due = requests::due(SESSION);
    assert_eq!(due.len(), 1);
    assert!(due[0].1.contains(r#""behavior":"allow""#), "{}", due[0].1);

    // The owner's later answer finds it answered.
    assert_eq!(
        requests::answer(
            SESSION,
            &notice.reference,
            Some("agent_owner"),
            Some("agent_owner"),
            false
        ),
        codex_drive::ReplyResult::Unknown
    );
    // So does the requester's second one, which is then just a message.
    let again = dm(
        "grokbot",
        "agent_grokbot",
        &format!("deny {}", notice.reference),
    );
    assert!(matches!(
        core.owner_reply(&registration, &again).await,
        OwnerReply::NotOne
    ));
    requests::forget(SESSION);
}

#[tokio::test]
async fn the_spawning_agent_answers_its_codexs_request() {
    const THREAD: &str = "01a1235e-70e1-7cb1-8619-e2c8bf3bdaaa";
    let home = tempfile::tempdir().unwrap();
    let core = core_with_account(home.path(), Arc::new(FakeSpawner::default()));
    set(&core, Some(true), Some(true));
    let registration = spawned("codex", THREAD);
    let notice = codex_drive::open_request(
        THREAD,
        json!({"id": 190, "method": "item/commandExecution/requestApproval",
            "params": {"threadId": THREAD, "command": "cargo test"}}),
    );
    let denial = dm(
        "grokbot",
        "agent_grokbot",
        &format!("deny {}", notice.reference),
    );
    assert_eq!(
        settled(core.owner_reply(&registration, &denial).await),
        "Codex approval reply from the spawning agent @grokbot (agent_grokbot): Answered"
    );
    assert!(!codex_drive::has_pending(THREAD, &notice.reference));
    assert_eq!(
        codex_drive::answer(
            THREAD,
            &notice.reference,
            Some("agent_owner"),
            Some("agent_owner"),
            true
        ),
        codex_drive::ReplyResult::Unknown,
        "the first answer counts"
    );
}

#[tokio::test]
async fn only_the_spawning_agents_own_direct_message_with_both_settings_on_answers() {
    const SESSION: &str = "a1d0c2e4-0000-4000-8000-00000000c1a2";
    let home = tempfile::tempdir().unwrap();
    let core = core_with_account(home.path(), spawner(false));
    let registration = spawned("claude", SESSION);
    let notice = claude_request(SESSION, "r2");
    let approve = format!("approve {}", notice.reference);
    let not_one = |reply: OwnerReply| matches!(reply, OwnerReply::NotOne);

    // Off in the release build until turned on (tests use a release data dir).
    set(&core, None, None);
    assert!(core.approving_requester(&registration).is_none());
    assert!(not_one(
        core.owner_reply(&registration, &dm("grokbot", "agent_grokbot", &approve))
            .await
    ));

    // Never without native input from the spawning agent.
    set(&core, Some(false), Some(true));
    assert!(core.approving_requester(&registration).is_none());
    assert!(not_one(
        core.owner_reply(&registration, &dm("grokbot", "agent_grokbot", &approve))
            .await
    ));

    set(&core, None, Some(true));
    // Another agent, or one taking the requester's name, is a peer.
    assert!(not_one(
        core.owner_reply(&registration, &dm("peer", "agent_peer", &approve))
            .await
    ));
    assert!(not_one(
        core.owner_reply(&registration, &dm("grokbot", "agent_impostor", &approve))
            .await
    ));
    // The requester's channel post or mention is no answer.
    let mut in_channel = dm("grokbot", "agent_grokbot", &approve);
    in_channel.channel_id = Some("general".into());
    assert!(not_one(core.owner_reply(&registration, &in_channel).await));
    let mut mention = dm("grokbot", "agent_grokbot", &approve);
    mention.reason = Some("mention".into());
    assert!(not_one(core.owner_reply(&registration, &mention).await));
    // Nor is its reply to a session someone took over.
    let mut taken_over = registration.clone();
    taken_over.spawn.as_mut().unwrap().taken_over_at = Some("2026-10-28T01:00:00Z".into());
    assert!(core.approving_requester(&taken_over).is_none());
    assert!(not_one(
        core.owner_reply(&taken_over, &dm("grokbot", "agent_grokbot", &approve))
            .await
    ));
    // Nor its reply to another session's reference.
    let other = spawned("claude", "a1d0c2e4-0000-4000-8000-00000000c1a9");
    assert!(not_one(
        core.owner_reply(&other, &dm("grokbot", "agent_grokbot", &approve))
            .await
    ));

    assert!(
        requests::has_pending(SESSION, &notice.reference),
        "still open"
    );
    assert!(core
        .store
        .read(|store| store.injected_delivery_ids.is_empty()));
    requests::forget(SESSION);
}

#[tokio::test]
async fn the_spawning_agents_reply_to_an_ended_claude_says_it_ended_and_never_resumes_it() {
    const SESSION: &str = "a1d0c2e4-0000-4000-8000-00000000c1a3";
    let home = tempfile::tempdir().unwrap();
    let dead = spawner(true);
    let core = core_with_account(home.path(), dead.clone());
    set(&core, None, Some(true));
    let registration = spawned("claude", SESSION);
    let notice = claude_request(SESSION, "r3");
    let approval = dm(
        "grokbot",
        "agent_grokbot",
        &format!("approve {}", notice.reference),
    );
    assert!(matches!(
        core.owner_reply(&registration, &approval).await,
        OwnerReply::NotOne
    ));
    assert_eq!(
        settled(core.ended_claude(&registration, &approval).await),
        "Spawned Claude has ended; not delivered"
    );
    assert!(dead.launched.lock().unwrap().is_empty(), "never resumed");
    requests::forget(SESSION);
}

#[test]
fn the_approval_dm_names_the_spawning_agent_only_when_it_may_answer() {
    let notice = codex_drive::open_request(
        "thread-requester-text",
        json!({"id": 191, "method": "item/fileChange/requestApproval",
            "params": {"threadId": "thread-requester-text"}}),
    );
    let owner_only = approval_text("w1", &notice, None);
    assert!(owner_only.ends_with("Only the signed-in machine owner may answer."));
    let both = approval_text("w1", &notice, Some("grokbot"));
    assert!(
        both.ends_with(
            "The signed-in machine owner or @grokbot, the agent that spawned this session, \
             may answer; the first answer counts."
        ),
        "{both}"
    );
    assert!(!both.contains("Only the signed-in"));
}

#[test]
fn a_core_without_an_account_never_lets_the_spawning_agent_answer() {
    let home = tempfile::tempdir().unwrap();
    let core = core(home.path(), Arc::new(FakeSpawner::default()));
    set(&core, Some(true), Some(true));
    let registration = spawned("codex", "01a1235e-70e1-7cb1-8619-e2c8bf3bdaaa");
    assert!(core.approving_requester(&registration).is_none());
}
