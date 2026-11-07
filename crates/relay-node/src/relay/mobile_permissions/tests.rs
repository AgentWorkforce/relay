use super::*;
use crate::relay::codex::app_server::drive::ReplyResult;
use crate::relay::store::SessionKind;

fn permission() -> Permission {
    Permission::new(
        Binding {
            scope: "workspace-agent-session".into(),
            owner: "immutable-owner".into(),
        },
        Target {
            kind: SessionKind::ClaudeTerminal,
            id: "native-session".into(),
        },
        Runtime {
            pid: 123,
            start: 456,
            idle: false,
        },
        "00000000-0000-4000-8000-000000000001",
        "Bash",
        json!({"command":"echo harmless", "nested":{"keep":true}}),
    )
    .unwrap()
}

#[test]
fn native_mobile_approval_is_one_action_with_exact_original_input() {
    let permission = permission();
    let context = &permission.context;
    assert_eq!(
        requests::answer(
            &context.namespace,
            &permission.notice.reference,
            Some("immutable-owner"),
            Some("immutable-owner"),
            true
        ),
        ReplyResult::Answered
    );
    let decision = permission.decision().unwrap();
    assert_eq!(
        decision,
        json!({"behavior":"allow","updatedInput":{"command":"echo harmless","nested":{"keep":true}}})
    );
    assert!(decision.get("updatedPermissions").is_none());
}

#[test]
fn peer_and_other_namespace_replies_cannot_answer_native_permission() {
    let permission = permission();
    let context = &permission.context;
    assert_eq!(
        requests::answer(
            &context.namespace,
            &permission.notice.reference,
            Some("peer"),
            Some("immutable-owner"),
            true
        ),
        ReplyResult::Unauthorized
    );
    assert_eq!(
        requests::answer(
            "old-runtime",
            &permission.notice.reference,
            Some("immutable-owner"),
            Some("immutable-owner"),
            true
        ),
        ReplyResult::Unknown
    );
    assert!(permission.decision().is_none());
    assert!(requests::has_pending(
        &context.namespace,
        &permission.notice.reference
    ));
}

#[test]
fn cancelling_one_native_request_preserves_another_and_invalidates_old_reference() {
    let first = permission();
    let other = permission();
    let (namespace, reference) = (
        first.context.namespace.clone(),
        first.notice.reference.clone(),
    );
    assert_ne!(namespace, other.context.namespace);
    drop(first);
    assert!(!requests::has_pending(&namespace, &reference));
    assert!(!pending().contains_key(&reference));
    assert!(requests::has_pending(
        &other.context.namespace,
        &other.notice.reference
    ));
    assert_eq!(
        requests::answer(
            &namespace,
            &reference,
            Some("immutable-owner"),
            Some("immutable-owner"),
            true
        ),
        ReplyResult::Unknown
    );
}

#[test]
fn reused_pid_is_a_different_runtime_but_busy_state_is_not() {
    let runtime = Runtime {
        pid: 123,
        start: 456,
        idle: false,
    };
    assert!(!same_process(
        &runtime,
        &Runtime {
            start: 457,
            ..runtime.clone()
        }
    ));
    assert!(!same_process(
        &runtime,
        &Runtime {
            pid: 124,
            ..runtime.clone()
        }
    ));
    assert!(same_process(
        &runtime,
        &Runtime {
            idle: true,
            ..runtime.clone()
        }
    ));
}

#[test]
fn native_denial_never_becomes_an_allow() {
    let permission = permission();
    assert_eq!(
        requests::answer(
            &permission.context.namespace,
            &permission.notice.reference,
            Some("immutable-owner"),
            Some("immutable-owner"),
            false
        ),
        ReplyResult::Answered
    );
    assert_eq!(permission.decision().unwrap()["behavior"], "deny");
}
