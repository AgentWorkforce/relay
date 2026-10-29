//! Only the verified machine owner is trusted by
//! a spawned Codex. The spawn's requester gets no native turns and cannot
//! answer approvals, like any other agent; its messages are framed as the
//! owner's (`owner_framing`).

use super::*;
use crate::relay::codex::app_server::drive;
use crate::relay::delivery::policy::Delivery;
use crate::relay::spawn::drive::{approval_text, direct_from, OwnerReply};
use crate::relay::store::SpawnRequester;

const THREAD: &str = "01a1235e-70e1-7cb1-8619-e2c8bf3bd000";

fn spawned_codex() -> Registration {
    let mut registration: Registration = serde_json::from_value(json!({
        "name": "w1", "agentID": "agent_w1", "target": {"kind": "codex", "id": THREAD},
        "title": "w1", "baseURL": "http://localhost:9", "registeredAt": "2026-10-18T00:00:00Z",
        "spawn": {"nodeID": "node-1", "nodeName": "desk", "invocationID": "inv_w1", "harness": "codex"}
    }))
    .unwrap();
    registration.spawn.as_mut().unwrap().requester = Some(SpawnRequester {
        name: "grokbot".into(),
        agent_id: "agent_grokbot".into(),
    });
    registration
}

fn from_requester(text: &str) -> Delivery {
    Delivery {
        id: "d1".into(),
        message_id: "m1".into(),
        sender: Some("grokbot".into()),
        sender_id: Some("agent_grokbot".into()),
        reason: Some("dm".into()),
        text: Some(text.into()),
        ..Delivery::default()
    }
}

#[tokio::test]
async fn a_requesters_dm_is_no_native_turn_and_cannot_answer_an_approval() {
    let home = tempfile::tempdir().unwrap();
    let core = core(home.path(), Arc::new(FakeSpawner::default()));
    let registration = spawned_codex();
    let notice = drive::open_request(
        THREAD,
        json!({"id": 90, "method": "item/commandExecution/requestApproval",
            "params": {"threadId": THREAD, "command": "cargo test"}}),
    );

    // The requester's ordinary message is not a native turn.
    let message = from_requester("Please check CI");
    assert!(!core.owner_native_turn(&registration, &message).await);

    // Its approval is not an answer: it is delivered as a peer message, and
    // the request stays open for the owner.
    let approval = from_requester(&format!("approve {}", notice.reference));
    assert!(matches!(
        core.owner_reply(&registration, &approval).await,
        OwnerReply::NotOne
    ));
    assert!(!core.store.read(|store| store.injected_delivery_ids.contains(&"d1".to_string())));
    assert_eq!(
        drive::answer(THREAD, &notice.reference, Some("agent_grokbot"), Some("agent_owner"), true),
        drive::ReplyResult::Unauthorized
    );
    assert_eq!(
        drive::answer(THREAD, &notice.reference, Some("agent_owner"), Some("agent_owner"), true),
        drive::ReplyResult::Answered,
        "still open for the owner"
    );
}

#[test]
fn only_a_direct_message_from_the_exact_id_is_from_that_agent() {
    let delivery = from_requester("hi");
    assert!(direct_from(&delivery, Some("agent_grokbot")));
    assert!(!direct_from(&delivery, Some("agent_someone_else")));
    assert!(!direct_from(&delivery, None));
    let in_channel = Delivery {
        channel_id: Some("c1".into()),
        ..from_requester("hi")
    };
    assert!(!direct_from(&in_channel, Some("agent_grokbot")));
    let mention = Delivery {
        reason: Some("mention".into()),
        ..from_requester("hi")
    };
    assert!(!direct_from(&mention, Some("agent_grokbot")));
}

#[test]
fn the_approval_dm_says_only_the_owner_may_answer() {
    let notice = drive::open_request(
        "thread-text",
        json!({"id": 91, "method": "item/fileChange/requestApproval",
            "params": {"threadId": "thread-text"}}),
    );
    let text = approval_text("w1", &notice);
    assert!(text.starts_with(&format!("[Codex approval {} for @w1]", notice.reference)));
    assert!(text.ends_with("Only the signed-in machine owner may answer."), "{text}");
    assert!(!text.contains("requester"), "{text}");
}
