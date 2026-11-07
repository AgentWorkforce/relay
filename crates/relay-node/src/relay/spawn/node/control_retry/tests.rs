use super::*;
use crate::relay::spawn::node::NodeInfo;
use serde_json::json;

fn policy(retries: u32) -> Policy {
    Policy {
        initial: Duration::from_millis(1),
        max_delay: Duration::from_millis(1),
        retries,
        budget: Duration::from_secs(1),
    }
}

fn rejected(id: &str, code: &str) -> Value {
    json!({"v": 1, "id": id, "type": "error", "code": code, "message": "Node liveness retry pending"})
}

fn link() -> (NodeLink, tokio::sync::mpsc::UnboundedReceiver<Value>) {
    NodeLink::detached(NodeInfo {
        node_id: "node-test".into(),
        node_name: "test-desktop".into(),
    })
}

#[tokio::test]
async fn explicit_pre_admission_pressure_replays_the_same_registration_only() {
    let (link, mut sent) = link();
    let request = json!({"v": 1, "id": "register-one", "type": "agent.register", "name": "test-worker", "invocation_id": "inv-test", "session_ref": "spawn:inv-test"});
    let original = request.clone();
    let requester = link.clone();
    let task = tokio::spawn(async move {
        requester
            .request_with_policy("register-one", request, Duration::from_secs(1), policy(3))
            .await
    });
    for _ in 0..2 {
        assert_eq!(sent.recv().await.unwrap(), original);
        assert!(link.answer(&rejected("register-one", "d1_pressure")));
    }
    assert_eq!(sent.recv().await.unwrap(), original);
    assert!(link.answer(&json!({"type": "reply", "id": "register-one", "ok": true, "data": {"agent_id": "test-agent"}})));
    assert_eq!(
        task.await.unwrap().unwrap()["data"]["agent_id"],
        "test-agent"
    );
    assert!(sent.try_recv().is_err());
}

#[tokio::test]
async fn a_pressure_refusal_past_the_timeout_is_still_retried() {
    let (link, mut sent) = link();
    let requester = link.clone();
    let task = tokio::spawn(async move {
        requester
            .ask_with_policy(
                "r",
                json!({"id": "r"}),
                Duration::from_millis(5),
                Duration::from_secs(1),
                policy(3),
            )
            .await
    });
    sent.recv().await.unwrap();
    // Past the request's own timeout, within its late wait.
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(link.answer(&rejected("r", "d1_pressure")));
    assert_eq!(sent.recv().await.unwrap()["id"], "r");
    assert!(link.answer(
        &json!({"type": "reply", "id": "r", "ok": true, "data": {"agent_id": "test-agent"}})
    ));
    let Asked::Answered(reply) = task.await.unwrap() else {
        panic!("the retry's answer is the request's");
    };
    assert_eq!(reply["data"]["agent_id"], "test-agent");
}

#[tokio::test]
async fn a_closed_connection_ends_a_request_still_waiting_on_it() {
    let (link, mut sent) = link();
    let ends = super::super::EndsWaits(link.pending.clone());
    let requester = link.clone();
    let task = tokio::spawn(async move {
        requester
            .ask_with_policy(
                "r",
                json!({"id": "r"}),
                Duration::from_secs(60),
                Duration::from_secs(60),
                policy(3),
            )
            .await
    });
    sent.recv().await.unwrap();
    drop(ends);
    let asked = tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .expect("ends at once, not after its timeout")
        .unwrap();
    assert!(matches!(asked, Asked::Closed));
}

#[tokio::test]
async fn a_timeout_never_replays_an_uncertain_registration() {
    let (link, mut sent) = link();
    let answer = link
        .request_with_policy(
            "r",
            json!({"id": "r", "type": "agent.register"}),
            Duration::from_millis(5),
            policy(3),
        )
        .await;
    assert!(answer.is_none());
    assert_eq!(sent.recv().await.unwrap()["id"], "r");
    assert!(sent.try_recv().is_err());
}

#[tokio::test]
async fn permanent_refusals_and_foreign_pressure_are_never_retried() {
    let (link, mut sent) = link();
    let requester = link.clone();
    let task = tokio::spawn(async move {
        requester
            .request_with_policy("r", json!({"id": "r"}), Duration::from_secs(1), policy(3))
            .await
    });
    sent.recv().await.unwrap();
    assert!(!link.answer(&rejected("other", "d1_pressure")));
    assert!(link.answer(&rejected("r", "agent_name_in_use")));
    assert_eq!(task.await.unwrap().unwrap()["code"], "agent_name_in_use");
    assert!(sent.try_recv().is_err());
}

#[tokio::test]
async fn repeated_pressure_returns_a_named_bounded_failure() {
    let (link, mut sent) = link();
    let requester = link.clone();
    let task = tokio::spawn(async move {
        requester
            .request_with_policy("r", json!({"id": "r"}), Duration::from_secs(1), policy(1))
            .await
    });
    for _ in 0..2 {
        sent.recv().await.unwrap();
        link.answer(&rejected("r", "d1_pressure"));
    }
    let answer = task.await.unwrap().unwrap();
    assert_eq!(answer["code"], "d1_pressure");
    assert!(answer["message"]
        .as_str()
        .unwrap()
        .contains("retry budget exhausted"));
    assert!(sent.try_recv().is_err());
}

#[test]
fn one_way_results_get_correlation_ids_without_changing_invocation_or_output() {
    let (link, mut sent) = link();
    let output = json!({"spawned": true, "ready": true, "name": "test-worker"});
    assert!(link.send(wire::action_output("inv-test", output.clone())));
    let frame = sent.try_recv().unwrap();
    assert!(frame["id"].as_str().unwrap().starts_with("action_result_"));
    assert_eq!(frame["invocation_id"], "inv-test");
    assert_eq!(frame["output"], output);
}

fn result(id: &str, invocation: &str) -> Value {
    json!({"v": 1, "id": id, "type": "action.result", "invocation_id": invocation, "output": {"ready": true}})
}

fn results() -> Results {
    Results::new(Timing::default())
}

impl Results {
    /// `reply` on the socket of the node every test result is tracked for.
    fn reply_on(&mut self, frame: &Value, now: Instant) -> bool {
        self.reply(frame, "node-test", now)
    }
}

#[test]
fn load_refusals_pass_and_relaycasts_own_verdicts_are_final() {
    assert!(passing("d1_pressure"));
    assert!(passing("action_result_state_changed"));
    assert!(!passing("action_result_not_dispatched"));
    let now = Instant::now();
    let mut results = results();
    results.track(result("r1", "inv-1"), "node-test", now);
    results.track(result("r2", "inv-2"), "node-test", now);
    results.track(result("r3", "inv-3"), "node-test", now);
    results.track(result("r4", "inv-4"), "node-test", now);
    assert!(results.reply_on(&rejected("r1", "d1_pressure"), now));
    assert!(results.reply_on(&rejected("r2", "action_result_not_dispatched"), now));
    assert!(results.reply_on(&rejected("r3", "action_result_already_settled"), now));
    assert!(results.reply_on(&rejected("r4", "action_result_state_changed"), now));
    let mut kept: Vec<&str> = results.pending.keys().map(String::as_str).collect();
    kept.sort_unstable();
    assert_eq!(kept, ["r1", "r4"]);
    assert_eq!(
        results.notes,
        [
            "Agent Relay did not take this computer's answer to inv-1: Node liveness retry pending (d1_pressure); sending it again.",
            "Agent Relay did not take this computer's answer to inv-2: Node liveness retry pending (action_result_not_dispatched); not sending it again.",
            "Agent Relay did not take this computer's answer to inv-4: Node liveness retry pending (action_result_state_changed); sending it again.",
        ]
    );
}

#[test]
fn pressured_results_resend_the_same_frame_until_the_send_cap() {
    let mut results = results();
    let frame = result("result-one", "inv-test");
    let mut now = Instant::now();
    results.track(frame.clone(), "node-test", now);
    for _ in 1..MAX_SENDS {
        assert!(results.reply_on(&rejected("result-one", "d1_pressure"), now));
        assert!(results.due("node-test", now).is_empty());
        now += Duration::from_secs(60);
        assert_eq!(results.due("node-test", now), std::slice::from_ref(&frame));
        results.resent(&frame, now);
    }
    assert!(results.reply_on(&rejected("result-one", "d1_pressure"), now));
    assert!(results.pending.is_empty());
    assert_eq!(results.notes.len(), 2, "{:?}", results.notes);
    assert!(results.notes[0].ends_with("sending it again."));
    assert!(results.notes[1].ends_with("not sending it again."));
}

#[test]
fn a_result_without_a_verdict_is_retained_for_its_node_until_it_is_too_old() {
    let mut results = results();
    let now = Instant::now();
    let later = now + Duration::from_secs(60);
    results.track(result("old", "inv-3"), "node-test", now);
    results.track(result("mine", "inv-1"), "node-test", later);
    results.track(result("other", "inv-2"), "node-other", later);
    assert_eq!(
        results.retained("node-test", now + KEEP),
        [result("mine", "inv-1")]
    );
    assert_eq!(results.pending.len(), 1);
}

#[test]
fn a_result_sent_too_often_is_given_up_on_a_new_connection() {
    let mut results = results();
    let now = Instant::now();
    let frame = result("r", "inv-1");
    results.track(frame.clone(), "node-test", now);
    for _ in 1..MAX_SENDS {
        assert_eq!(
            results.retained("node-test", now),
            std::slice::from_ref(&frame)
        );
        results.resent(&frame, now);
    }
    assert!(results.retained("node-test", now).is_empty());
    assert_eq!(
        results.notes,
        ["Agent Relay did not confirm this computer's answer to inv-1 after 8 sends; not sending it again."]
    );
}

#[test]
fn a_result_the_socket_would_not_take_is_due_at_once() {
    let (link, sent) = link();
    drop(sent);
    assert!(!link.send(wire::action_output("inv-test", json!({"ready": true}))));
    let due = link.due_results();
    assert_eq!(due.len(), 1);
    assert_eq!(due[0]["invocation_id"], "inv-test");
}

#[test]
fn errors_no_one_waits_for_are_noted_once_per_code_now_and_then() {
    let mut results = results();
    let now = Instant::now();
    assert!(results.reply_on(&rejected("foreign", "d1_pressure"), now));
    assert!(results.reply_on(&rejected("another", "d1_pressure"), now));
    assert!(!results.reply_on(&json!({"type": "deliver", "agent": "w1"}), now));
    assert_eq!(
        results.notes,
        ["Agent Relay refused a message from this computer's spawn node: Node liveness retry pending (d1_pressure)."]
    );
    assert!(results.reply_on(&rejected("later", "d1_pressure"), now + NOTE_EVERY));
    assert_eq!(results.notes.len(), 2);
}

#[test]
fn successful_one_way_results_expire_without_automatic_replay() {
    let mut results = results();
    let now = Instant::now();
    results.track(
        json!({"id": "r", "type": "action.result"}),
        "node-test",
        now,
    );
    assert!(results
        .due("node-test", now + Duration::from_secs(5))
        .is_empty());
    assert_eq!(results.pending.len(), 1);
    assert!(results
        .due("node-test", now + Duration::from_secs(25))
        .is_empty());
    assert!(results.pending.is_empty());
    assert!(results.retained("node-test", now).is_empty());
}

#[test]
fn a_late_result_of_a_replaced_node_never_goes_out_on_the_new_one() {
    let mut results = results();
    let now = Instant::now();
    // The new workspace's node is live; the old node's action finishes now
    // and its dead link cannot take the result.
    results.track(result("old", "inv-old"), "node-old", now);
    results.unsent("old", now);
    results.track(result("new", "inv-new"), "node-test", now);
    assert!(results.due("node-test", now).is_empty());
    // The new node's socket cannot settle or refuse the old node's result.
    assert!(results.reply_on(&rejected("old", "action_result_not_dispatched"), now));
    let receipt = json!({"v": 1, "id": "old", "type": "reply", "ok": true});
    assert!(!results.reply_on(&receipt, now));
    // Its silence window passing on the new socket does not count as taken.
    let later = now + Duration::from_secs(60);
    assert!(results.due("node-test", later).is_empty());
    assert_eq!(results.owed(), ["old"]);
    // The old node, connecting again, sends it; any other node drops it.
    assert_eq!(results.due("node-old", later), [result("old", "inv-old")]);
    results.resent(&result("old", "inv-old"), later);
    assert_eq!(
        results.retained("node-old", later),
        [result("old", "inv-old")]
    );
    assert!(results.retained("node-test", later).is_empty());
    assert!(results.pending.is_empty());
}
