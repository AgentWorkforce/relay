use super::*;
use crate::relay::harness::claude::requests;
use crate::relay::store::{SessionKind, Target};
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};

const TOKEN: &str = "00000000-0000-4000-8000-000000000001";
fn binding() -> Binding {
    Binding {
        scope: "scope".into(),
        owner: "owner".into(),
    }
}
fn runtime() -> Runtime {
    Runtime {
        pid: 123,
        start: 456,
        idle: false,
    }
}
fn input() -> Value {
    json!({"command":"echo harmless","nested":{"keep":true}})
}
fn permission() -> Permission {
    Permission::new(
        binding(),
        Target {
            kind: SessionKind::ClaudeTerminal,
            id: "native".into(),
        },
        runtime(),
        TOKEN,
        "Bash",
        input(),
    )
    .unwrap()
}
fn open(cache: &Tickets, id: &str) -> Arc<Ticket> {
    cache
        .open(
            &binding(),
            &runtime(),
            id,
            TOKEN,
            "Bash",
            &input(),
            || Ok(permission()),
            || true,
        )
        .unwrap()
}

#[tokio::test]
async fn disconnected_and_concurrent_retries_keep_one_notice_and_backoff() {
    let cache = Tickets::default();
    let first = open(&cache, "turn:1");
    let notice = first
        .state
        .lock()
        .await
        .permission
        .as_ref()
        .unwrap()
        .notice
        .clone();
    first.state.lock().await.retry.attempted(Instant::now());
    let weak = Arc::downgrade(&first);
    drop(first); // The HTTP request disappeared; the cache owns the ticket.
    let retry = cache
        .open(
            &binding(),
            &runtime(),
            "turn:1",
            TOKEN,
            "Bash",
            &input(),
            || panic!("duplicate prompt"),
            || true,
        )
        .unwrap();
    assert!(Arc::ptr_eq(&weak.upgrade().unwrap(), &retry));
    let state = retry.state.lock().await;
    assert_eq!(
        state.permission.as_ref().unwrap().notice.reference,
        notice.reference
    );
    assert!(!state.retry.due(Instant::now()));
    assert_eq!(requests::unforwarded(&notice.session).len(), 1);
}

#[tokio::test]
async fn reused_request_id_requires_exact_tool_input_and_generation() {
    let cache = Tickets::default();
    let _first = open(&cache, "turn:1");
    for (token, tool, value) in [
        (TOKEN, "Bash", json!({"command":"changed"})),
        (TOKEN, "Write", input()),
        ("00000000-0000-4000-8000-000000000002", "Bash", input()),
    ] {
        let error = cache
            .open(
                &binding(),
                &runtime(),
                "turn:1",
                token,
                tool,
                &value,
                || panic!("mismatch admitted"),
                || true,
            )
            .err()
            .unwrap();
        assert_eq!(error.status, 409);
    }
}

#[tokio::test]
async fn lost_final_response_replays_same_decision_without_another_prompt() {
    let cache = Tickets::default();
    let first = open(&cache, "turn:1");
    let notice = first
        .state
        .lock()
        .await
        .permission
        .as_ref()
        .unwrap()
        .notice
        .clone();
    let allowed = json!({"handled":true,"decision":{"behavior":"allow","updatedInput":input()}});
    first.state.lock().await.finish(allowed.clone());
    assert!(!requests::has_pending(&notice.session, &notice.reference));
    drop(first);
    let retry = open(&cache, "turn:1");
    let state = retry.state.lock().await;
    assert_eq!(state.result, Some(allowed));
    assert!(state.permission.is_none());
}

#[tokio::test(start_paused = true)]
async fn expiry_removes_pending_approval_without_a_reconnecting_socket() {
    let cache = Tickets::default();
    let ticket = open(&cache, "turn:1");
    let notice = ticket
        .state
        .lock()
        .await
        .permission
        .as_ref()
        .unwrap()
        .notice
        .clone();
    tokio::task::yield_now().await;
    tokio::time::advance(WAIT).await;
    tokio::task::yield_now().await;
    assert!(ticket.expired(Instant::now()));
    assert_eq!(ticket.state.lock().await.result, Some(denied()));
    assert!(!requests::has_pending(&notice.session, &notice.reference));
    assert!(cache.entries.lock().unwrap().is_empty());
}

#[tokio::test(start_paused = true)]
async fn lifecycle_revocation_cancels_notice_and_retains_denial_until_ttl() {
    let cache = Tickets::default();
    let valid = Arc::new(AtomicBool::new(true));
    let current = valid.clone();
    let ticket = cache
        .open(
            &binding(),
            &runtime(),
            "turn:1",
            TOKEN,
            "Bash",
            &input(),
            || Ok(permission()),
            move || current.load(Ordering::SeqCst),
        )
        .unwrap();
    let notice = ticket
        .state
        .lock()
        .await
        .permission
        .as_ref()
        .unwrap()
        .notice
        .clone();
    tokio::task::yield_now().await;
    valid.store(false, Ordering::SeqCst);
    tokio::time::advance(Duration::from_secs(5)).await;
    tokio::task::yield_now().await;
    assert_eq!(ticket.state.lock().await.result, Some(denied()));
    assert!(!requests::has_pending(&notice.session, &notice.reference));
    assert!(Arc::ptr_eq(&ticket, &open(&cache, "turn:1")));
    assert_eq!(cache.entries.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn cache_capacity_refuses_new_prompts_without_evicting_existing_decisions() {
    let cache = Tickets::default();
    let first = open(&cache, "turn:0");
    first.state.lock().await.finish(denied());
    for index in 1..CAPACITY {
        open(&cache, &format!("turn:{index}"));
    }
    let error = cache
        .open(
            &binding(),
            &runtime(),
            "overflow",
            TOKEN,
            "Bash",
            &input(),
            || panic!("capacity admitted"),
            || true,
        )
        .err()
        .unwrap();
    assert_eq!(error.status, 429);
    assert!(Arc::ptr_eq(&first, &open(&cache, "turn:0")));
}
