use super::*;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

const THREAD: &str = "01a16f54-f5f0-7d10-b9d5-bef66e02d007";
const OWNER: &str = "window-original";

fn approval(method: &str) -> Value {
    json!({"id":42,"method":method,"params":{"threadId":THREAD,"turnId":"turn-1","itemId":"item-1","command":"synthetic command"}})
}
fn state() -> Value {
    json!({"id":THREAD,"requests":[approval("item/commandExecution/requestApproval")]})
}
fn broadcast(change: Value) -> Value {
    json!({"type":"broadcast","method":"thread-stream-state-changed","version":11,
        "sourceClientId":OWNER,"params":{"hostId":"local","conversationId":THREAD,"change":change}})
}
fn snapshot(state: Value, revision: u64) -> Value {
    broadcast(json!({"type":"snapshot","revision":revision,"conversationState":state}))
}
fn patches(base: u64, revision: u64, changes: Value) -> Value {
    broadcast(json!({"type":"patches","baseRevision":base,"revision":revision,"patches":changes}))
}

struct Fixture {
    sent: Vec<Value>,
    incoming: VecDeque<Value>,
    state: Value,
    revision: u64,
    owner: String,
    fail_follow: bool,
    lose_decision: bool,
    wrong_ack_owner: bool,
}
impl Default for Fixture {
    fn default() -> Self {
        Self {
            sent: vec![],
            incoming: VecDeque::new(),
            state: state(),
            revision: 1,
            owner: OWNER.into(),
            fail_follow: false,
            lose_decision: false,
            wrong_ack_owner: false,
        }
    }
}
#[derive(Clone, Default)]
struct Fake(Arc<Mutex<Fixture>>);
impl Transport for Fake {
    fn send(&mut self, message: &Value) -> Result<(), Error> {
        let mut fixture = self.0.lock().unwrap();
        fixture.sent.push(message.clone());
        let method = message["method"].as_str().unwrap_or("");
        if method == "thread-stream-following-changed" {
            if fixture.fail_follow {
                return Err(Error::Disconnected);
            }
            if message["params"]["following"] == true {
                let value = snapshot(fixture.state.clone(), fixture.revision);
                fixture.incoming.push_back(value);
            }
        } else if message["type"] == "request" {
            let mut response = json!({"type":"response","requestId":message["requestId"],"resultType":"success","result":{"ok":true},"handledByClientId":fixture.owner});
            if method == "initialize" {
                response["result"] = json!({"clientId":"follower"});
            }
            if method.ends_with("approval-decision") {
                if fixture.lose_decision {
                    return Err(Error::Disconnected);
                }
                if fixture.wrong_ack_owner {
                    response["handledByClientId"] = "replacement".into();
                }
            }
            fixture.incoming.push_back(response);
        }
        Ok(())
    }
    fn receive(&mut self, _: Instant) -> Result<Option<Value>, Error> {
        Ok(self.0.lock().unwrap().incoming.pop_front())
    }
}
fn attached() -> (Fake, Follower<Fake>, ApprovalRequest) {
    let fake = Fake::default();
    let mut follower = Follower::attach(fake.clone(), THREAD, OWNER).unwrap();
    follower.poll(Duration::ZERO).unwrap();
    let request = follower.registry().pending()[0].clone();
    (fake, follower, request)
}
fn decisions(fake: &Fake) -> Vec<Value> {
    fake.0
        .lock()
        .unwrap()
        .sent
        .iter()
        .filter(|v| {
            v["method"]
                .as_str()
                .is_some_and(|m| m.ends_with("approval-decision"))
        })
        .cloned()
        .collect()
}

#[test]
fn follows_only_exact_owner_without_taking_ownership_or_resuming() {
    let (fake, mut follower, _) = attached();
    follower.close().unwrap();
    assert!(follower.registry().pending().is_empty());
    let fixture = fake.0.lock().unwrap();
    assert_eq!(fixture.sent.len(), 4);
    assert_eq!(fixture.sent[0]["version"], 0);
    assert_eq!(fixture.sent[1]["method"], "thread-owner-discovery");
    assert_eq!(fixture.sent[1]["version"], 1);
    for (index, following) in [(2, true), (3, false)] {
        let value = &fixture.sent[index];
        assert_eq!(value["method"], "thread-stream-following-changed");
        assert_eq!(value["version"], 1);
        assert_eq!(value["targetClientIds"], json!([OWNER]));
        assert_eq!(
            value["params"],
            json!({"hostId":"local","conversationId":THREAD,"following":following})
        );
    }
}

#[test]
fn command_and_file_decisions_are_one_action_only_and_ack_is_not_applied_proof() {
    for (method, kind, decision, word) in [
        (
            "item/commandExecution/requestApproval",
            ApprovalKind::Command,
            Decision::Accept,
            "accept",
        ),
        (
            "item/fileChange/requestApproval",
            ApprovalKind::File,
            Decision::Decline,
            "decline",
        ),
    ] {
        let fake = Fake::default();
        fake.0.lock().unwrap().state["requests"] = json!([approval(method)]);
        let mut follower = Follower::attach(fake.clone(), THREAD, OWNER).unwrap();
        follower.poll(Duration::ZERO).unwrap();
        let request = follower.registry().pending()[0].clone();
        assert_eq!(request.kind(), kind);
        assert_eq!(
            follower.decide(&request, decision, &|| true),
            DecisionOutcome::AcknowledgedUnconfirmed
        );
        assert_eq!(
            follower.decide(&request, Decision::Decline, &|| panic!(
                "must not consume twice"
            )),
            DecisionOutcome::AcknowledgedUnconfirmed
        );
        let sent = decisions(&fake);
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0]["version"], 1);
        assert_eq!(sent[0]["targetClientId"], OWNER);
        assert_eq!(
            sent[0]["params"],
            json!({"conversationId":THREAD,"requestId":42,"decision":word})
        );
    }
}

#[test]
fn late_revocation_and_changed_request_never_dispatch() {
    let (fake, mut follower, request) = attached();
    assert_eq!(
        follower.decide(&request, Decision::Accept, &|| false),
        DecisionOutcome::Refused
    );
    assert!(decisions(&fake).is_empty());
    assert_eq!(
        follower.decide(&request, Decision::Accept, &|| true),
        DecisionOutcome::AcknowledgedUnconfirmed
    );
    assert_eq!(decisions(&fake).len(), 1);
    let (fake, mut follower, request) = attached();
    {
        let mut f = fake.0.lock().unwrap();
        f.state["requests"][0]["params"]["command"] = "different".into();
        f.revision += 1;
    }
    assert_eq!(
        follower.decide(&request, Decision::Accept, &|| panic!("changed request")),
        DecisionOutcome::Refused
    );
    assert!(decisions(&fake).is_empty());
}

#[test]
fn removed_request_or_replaced_owner_never_dispatches() {
    for replace_owner in [false, true] {
        let (fake, mut follower, request) = attached();
        {
            let mut f = fake.0.lock().unwrap();
            if replace_owner {
                f.owner = "replacement".into();
            } else {
                f.state["requests"] = json!([]);
                f.revision += 1;
            }
        }
        assert_eq!(
            follower.decide(&request, Decision::Accept, &|| panic!("authority lost")),
            DecisionOutcome::Refused
        );
        assert!(decisions(&fake).is_empty());
    }
}

#[test]
fn uncertain_write_or_wrong_owner_ack_is_never_retried() {
    for lose in [false, true] {
        let (fake, mut follower, request) = attached();
        {
            let mut f = fake.0.lock().unwrap();
            f.lose_decision = lose;
            f.wrong_ack_owner = !lose;
        }
        assert_eq!(
            follower.decide(&request, Decision::Accept, &|| true),
            DecisionOutcome::InDoubt
        );
        assert_eq!(
            follower.decide(&request, Decision::Decline, &|| panic!("uncertain replay")),
            DecisionOutcome::InDoubt
        );
        assert_eq!(decisions(&fake).len(), 1);
        assert!(follower.registry().pending().is_empty());
    }
}

#[test]
fn failed_refresh_invalidates_handles_and_reconnection_cannot_reuse_them() {
    let (fake, mut follower, request) = attached();
    fake.0.lock().unwrap().fail_follow = true;
    assert_eq!(
        follower.decide(&request, Decision::Accept, &|| true),
        DecisionOutcome::Refused
    );
    assert!(follower.registry().pending().is_empty());
    let (fresh, mut other, _) = attached();
    assert_eq!(
        other.decide(&request, Decision::Accept, &|| panic!("old connection")),
        DecisionOutcome::Refused
    );
    assert!(decisions(&fresh).is_empty());
}

#[test]
fn untrusted_scope_is_ignored_and_version_mismatch_invalidates() {
    for field in ["owner", "host", "thread"] {
        let mut registry = Registry::new(THREAD, OWNER).unwrap();
        let mut message = snapshot(state(), 1);
        match field {
            "owner" => message["sourceClientId"] = "other".into(),
            "host" => message["params"]["hostId"] = "remote".into(),
            _ => message["params"]["conversationId"] = "other".into(),
        }
        assert!(registry.apply(&message).unwrap().is_empty());
        assert!(registry.pending().is_empty());
    }
    let mut registry = Registry::new(THREAD, OWNER).unwrap();
    registry.apply(&snapshot(state(), 1)).unwrap();
    let mut message = snapshot(state(), 1);
    message["version"] = 12.into();
    assert_eq!(registry.apply(&message), Err(Error::UnsupportedVersion));
    assert!(registry.pending().is_empty());
}

#[test]
fn exact_patch_continuity_and_request_replacement_revoke_old_handles() {
    let mut registry = Registry::new(THREAD, OWNER).unwrap();
    registry.apply(&snapshot(state(), 1)).unwrap();
    let old = registry.pending()[0].clone();
    let events = registry
        .apply(&patches(
            1,
            2,
            json!([{"op":"replace","path":["requests",0,"params","itemId"],"value":"item-2"}]),
        ))
        .unwrap();
    assert!(!registry.contains(&old));
    assert!(events.contains(&Event::RequestGone {
        key: old.key().into()
    }));
    assert_eq!(registry.pending()[0].item(), "item-2");
    assert_eq!(
        registry.apply(&patches(1, 3, json!([]))),
        Err(Error::InvalidState)
    );
    assert!(registry.pending().is_empty());
}

#[test]
fn malformed_or_ambiguous_request_snapshots_fail_closed() {
    for malformed in [
        json!([
            approval("item/commandExecution/requestApproval"),
            approval("item/commandExecution/requestApproval")
        ]),
        json!([{"id":true,"method":"unknown","params":{}}]),
        json!([{"id":1,"method":"item/fileChange/requestApproval","params":{"threadId":"other","turnId":"t","itemId":"i"}}]),
    ] {
        let mut registry = Registry::new(THREAD, OWNER).unwrap();
        let mut value = state();
        value["requests"] = malformed;
        assert_eq!(
            registry.apply(&snapshot(value, 1)),
            Err(Error::InvalidState)
        );
        assert!(registry.pending().is_empty());
    }
}

#[test]
fn broader_permissions_and_user_input_are_never_exposed_as_action_tickets() {
    let mut registry = Registry::new(THREAD, OWNER).unwrap();
    let mut value = state();
    value["requests"] = json!([{"id":1,"method":"item/permissions/requestApproval","params":{}},{"id":2,"method":"item/tool/requestUserInput","params":{}}]);
    registry.apply(&snapshot(value, 1)).unwrap();
    assert!(registry.pending().is_empty());
}

#[test]
fn invalid_patch_paths_and_snapshot_revision_rewrites_fail_closed() {
    for changes in [
        json!([{"op":"remove","path":["requests",9]}]),
        json!([{"op":"replace","path":["missing"],"value":0}]),
        json!([{"op":"move","path":["requests"]}]),
    ] {
        let mut registry = Registry::new(THREAD, OWNER).unwrap();
        registry.apply(&snapshot(state(), 1)).unwrap();
        assert_eq!(
            registry.apply(&patches(1, 2, changes)),
            Err(Error::InvalidState)
        );
        assert!(registry.state().is_none());
    }
    let mut registry = Registry::new(THREAD, OWNER).unwrap();
    registry.apply(&snapshot(state(), 1)).unwrap();
    let mut value = state();
    value["requests"] = json!([]);
    assert_eq!(
        registry.apply(&snapshot(value, 1)),
        Err(Error::InvalidState)
    );
}

#[cfg(unix)]
mod wire_tests;

#[test]
fn offered_decisions_cannot_be_widened_and_permission_grants_stay_on_desktop() {
    let fake = Fake::default();
    fake.0.lock().unwrap().state["requests"][0]["params"]["availableDecisions"] =
        json!(["decline", "acceptForSession"]);
    let mut follower = Follower::attach(fake.clone(), THREAD, OWNER).unwrap();
    follower.poll(Duration::ZERO).unwrap();
    let request = follower.registry().pending()[0].clone();
    assert!(!request.allows(Decision::Accept));
    assert!(request.allows(Decision::Decline));
    assert_eq!(
        follower.decide(&request, Decision::Accept, &|| panic!("unoffered decision")),
        DecisionOutcome::Refused
    );
    assert!(decisions(&fake).is_empty());
    for field in ["grantRoot", "additionalPermissions"] {
        let mut value = state();
        value["requests"][0]["params"][field] = json!({"synthetic":"scope"});
        let mut registry = Registry::new(THREAD, OWNER).unwrap();
        registry.apply(&snapshot(value, 1)).unwrap();
        assert!(registry.pending().is_empty());
    }
}

#[test]
fn reset_and_owner_disconnect_invalidate_even_if_the_same_request_reappears() {
    for message in [
        json!({"type":"broadcast","method":"ipc-connection-reset"}),
        json!({"type":"broadcast","method":"client-status-changed","sourceClientId":OWNER,"params":{"clientId":OWNER,"status":"disconnected"}}),
    ] {
        let mut registry = Registry::new(THREAD, OWNER).unwrap();
        registry.apply(&snapshot(state(), 1)).unwrap();
        let old = registry.pending()[0].clone();
        assert_eq!(registry.apply(&message), Err(Error::Disconnected));
        assert!(registry.pending().is_empty());
        registry.apply(&snapshot(state(), 1)).unwrap();
        assert!(!registry.contains(&old));
    }
}

#[test]
fn removed_then_reintroduced_identical_request_has_a_new_ticket_identity() {
    let mut registry = Registry::new(THREAD, OWNER).unwrap();
    registry.apply(&snapshot(state(), 1)).unwrap();
    let old = registry.pending()[0].clone();
    registry.apply(&snapshot(state(), 2)).unwrap();
    assert!(registry.contains(&old));
    let mut empty = state();
    empty["requests"] = json!([]);
    registry.apply(&snapshot(empty, 3)).unwrap();
    registry.apply(&snapshot(state(), 4)).unwrap();
    assert!(!registry.contains(&old));
    assert_ne!(registry.pending()[0].key(), old.key());
}

#[test]
fn file_content_changes_invalidate_the_exact_live_request_handle() {
    let mut registry = Registry::new(THREAD, OWNER).unwrap();
    let mut value = state();
    value["cwd"] = "/tmp/project".into();
    value["requests"] = json!([approval("item/fileChange/requestApproval")]);
    value["turns"] = json!([{"id":"turn-1","items":[{"id":"item-1","type":"fileChange","changes":[{"path":"file.rs","kind":{"type":"update"},"diff":"first"}]}]}]);
    registry.apply(&snapshot(value.clone(), 1)).unwrap();
    let before = registry.pending()[0].clone();
    value["turns"][0]["items"][0]["changes"][0]["diff"] = "different".into();
    registry.apply(&snapshot(value, 2)).unwrap();
    assert!(!registry.contains(&before));
}

#[test]
fn consumed_admission_remains_refused_without_provider_writes() {
    use std::sync::atomic::{AtomicBool, Ordering};
    let (fake, mut follower, request) = attached();
    let consumed = AtomicBool::new(false);
    assert_eq!(
        follower.decide(&request, Decision::Accept, &|| {
            assert!(!consumed.swap(true, Ordering::SeqCst));
            false // Late proof failed after the durable consumption boundary.
        }),
        DecisionOutcome::Refused
    );
    assert_eq!(
        follower.decide(&request, Decision::Accept, &|| {
            !consumed.load(Ordering::SeqCst)
        }),
        DecisionOutcome::Refused
    );
    assert!(decisions(&fake).is_empty());
}
