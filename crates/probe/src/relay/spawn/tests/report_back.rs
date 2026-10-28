//! A spawned agent learns who asked for it, from Relaycast's own record of
//! the invocation, and owes them its first turn's final answer.

use super::*;
use crate::relay::delivery::policy::MessageRef;
use crate::relay::links::Endpoint;
use crate::relay::store::Destination;

/// Relaycast's REST API answering `GET /v1/actions/spawn/invocations/…`
/// with `invocation`, and anything else with 404. Returns the base URL and
/// the request lines it saw.
pub(super) fn relaycast_rest(invocation: Value) -> (String, Arc<Mutex<Vec<String>>>) {
    relaycast_routes(vec![(
        "GET /v1/actions/spawn/invocations/inv_w1 ",
        "200 OK",
        json!({"ok": true, "data": invocation}),
    )])
}

/// Relaycast's REST API answering each request line that starts with a
/// route's prefix with its status and body, and anything else with 404.
fn relaycast_routes(
    routes: Vec<(&'static str, &'static str, Value)>,
) -> (String, Arc<Mutex<Vec<String>>>) {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = seen.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { return };
            let mut request = Vec::new();
            let mut buffer = [0_u8; 4096];
            while !String::from_utf8_lossy(&request).contains("\r\n\r\n") {
                match stream.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(read) => request.extend_from_slice(&buffer[..read]),
                }
            }
            let text = String::from_utf8_lossy(&request).to_string();
            log.lock()
                .unwrap()
                .push(text.lines().next().unwrap_or_default().to_string());
            let (status, body) = routes
                .iter()
                .find(|(prefix, _, _)| text.starts_with(prefix))
                .map(|(_, status, body)| (*status, body.clone()))
                .unwrap_or((
                    "404 Not Found",
                    json!({"ok": false, "error": {"code": "not_found", "message": "not here"}}),
                ));
            let body = body.to_string();
            let _ = write!(
                stream,
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
        }
    });
    (base_url, seen)
}

#[tokio::test]
async fn the_requester_relaycast_recorded_is_named_and_owed_the_final_answer() {
    let home = tempfile::tempdir().unwrap();
    let spawner = Arc::new(FakeSpawner::default());
    let (rest, seen) = relaycast_rest(json!({
        "invocation_id": "inv_w1", "action_name": "spawn",
        "caller_id": "agent_grokbot", "caller_name": "grokbot-jd-relay",
        "input": {"name": "w1", "cli": "codex", "task": "Fix CI"},
        "status": "dispatched",
    }));
    let core = core_at(home.path(), spawner.clone(), &rest);
    let (link, sent) = NodeLink::detached(node());
    let _frames = relaycast(link.clone(), sent);
    let answer = core.clone().answer_spawn(link, request("w1")).await;
    assert_eq!(answer, wire::action_output("inv_w1", wire::spawned("w1")));
    assert!(
        seen.lock()
            .unwrap()
            .iter()
            .any(|line| line.starts_with("GET /v1/actions/spawn/invocations/inv_w1 ")),
        "{seen:?}"
    );

    let text = spawner.launched.lock().unwrap()[0].text.clone();
    let reference = MessageRef::of("spawn-inv_w1");
    assert!(
        text.starts_with(&format!(
            "[via Agent Relay — spawned as @w1 (w1@test-desk-desktop) · from @grokbot-jd-relay · ref {reference}]"
        )),
        "{text}"
    );
    assert!(text.ends_with("\n\nFix CI"), "{text}");
    assert_eq!(MessageRef::in_text(&text), Some(reference.clone()));
    assert!(!text.contains("rk_live"), "no workspace key in the prompt");
    assert!(!text.contains("at_live"), "no agent token in the prompt");

    // The requester is kept by its immutable id as well as its name.
    let requester = core
        .store
        .read(|store| {
            store
                .registrations
                .iter()
                .find(|registration| registration.name == "w1")
                .and_then(|registration| registration.spawn.clone())
        })
        .and_then(|spawn| spawn.requester)
        .unwrap();
    assert_eq!(requester.agent_id, "agent_grokbot");
    assert_eq!(requester.name, "grokbot-jd-relay");

    // Its first turn's final answer is owed to the requester…
    let owed = core.store.read(|store| store.replies.clone()).unwrap();
    assert_eq!(owed.len(), 1);
    let requester = core
        .store
        .read(|store| {
            store
                .registrations
                .iter()
                .find(|registration| registration.name == "w1")
                .unwrap()
                .spawn
                .as_ref()
                .unwrap()
                .requester
                .clone()
        })
        .unwrap();
    assert_eq!(requester.agent_id, "agent_grokbot");
    assert_eq!(requester.name, "grokbot-jd-relay");
    assert_eq!(owed[0].agent_id, "agent_w1");
    assert_eq!(owed[0].message_ref(), reference);
    assert!(matches!(&owed[0].destination, Destination::Dm(to) if to.value == "grokbot-jd-relay"));
    assert_eq!(owed[0].claimed, None);

    // …unless the agent messages them itself over the socket first.
    core.claim_socket_reply("w1", &Endpoint::Name("grokbot-jd-relay".into()), None)
        .unwrap();
    let owed = core.store.read(|store| store.replies.clone()).unwrap();
    assert_eq!(owed[0].claimed, Some(true), "never a second message");
}

#[tokio::test]
async fn without_a_recorded_requester_nothing_is_owed() {
    let home = tempfile::tempdir().unwrap();
    let spawner = Arc::new(FakeSpawner::default());
    // An invocation with no caller, as a workspace-key invoke has.
    let (rest, _seen) = relaycast_rest(json!({
        "invocation_id": "inv_w1", "action_name": "spawn",
        "caller_id": null, "caller_name": null,
    }));
    let core = core_at(home.path(), spawner.clone(), &rest);
    let (link, sent) = NodeLink::detached(node());
    let _frames = relaycast(link.clone(), sent);
    core.clone().answer_spawn(link, request("w1")).await;
    let text = spawner.launched.lock().unwrap()[0].text.clone();
    assert!(!text.contains("from @"), "{text}");
    assert!(core.store.read(|store| store.replies.clone()).is_none());
}

#[tokio::test]
async fn the_answer_goes_only_to_the_agent_that_still_holds_the_requesters_name() {
    use crate::relay::spawn::report_back::still_named;
    let (rest, seen) = relaycast_routes(vec![
        (
            "GET /v1/agents/grokbot ",
            "200 OK",
            json!({"ok": true, "data": {"id": "agent_grokbot", "name": "grokbot"}}),
        ),
        (
            "GET /v1/agents/renamed ",
            "200 OK",
            json!({"ok": true, "data": {"id": "agent_someone_else", "name": "renamed"}}),
        ),
        (
            "GET /v1/agents/gone ",
            "404 Not Found",
            json!({"ok": false, "error": {"code": "agent_not_found", "message": "no agent"}}),
        ),
        (
            "GET /v1/agents/flaky ",
            "500 Internal Server Error",
            json!({"ok": false, "error": {"code": "internal", "message": "down"}}),
        ),
    ]);
    let mut registration: crate::relay::store::Registration = serde_json::from_value(json!({
        "name": "w1", "agentID": "agent_w1", "target": {"kind": "codex", "id": "t1"},
        "title": "w1", "baseURL": rest, "registeredAt": "2026-10-18T00:00:00Z",
        "workspaceKey": "rk_live_test0000"
    }))
    .unwrap();
    assert_eq!(
        still_named(&registration, "grokbot", "agent_grokbot").await,
        Some(true)
    );
    assert_eq!(
        still_named(&registration, "renamed", "agent_renamed").await,
        Some(false)
    );
    assert_eq!(
        still_named(&registration, "gone", "agent_gone").await,
        Some(false)
    );
    assert_eq!(
        still_named(&registration, "flaky", "agent_flaky").await,
        None,
        "asked again later"
    );
    assert!(seen
        .lock()
        .unwrap()
        .iter()
        .any(|line| line.starts_with("GET /v1/agents/grokbot ")));
    registration.workspace_key = None;
    assert_eq!(
        still_named(&registration, "grokbot", "agent_grokbot").await,
        Some(false)
    );
}
