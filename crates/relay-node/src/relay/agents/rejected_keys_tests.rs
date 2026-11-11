//! A registration stranded on a rotated workspace key: removal proves the
//! rotation with the current key and leaves, or leaves this computer when
//! the current workspace holds no such agent.

use super::*;
use crate::relay::store::{CleanupKind, PendingCleanup, Registration};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::time::Duration;

const OLD: &str = "rk_live_old";
const CURRENT: &str = "rk_live_current";

/// One request as Relaycast saw it: method, path, and the bearer key.
type Seen = (String, String, String);

/// A Relaycast stand-in: every request is recorded and answered by
/// `answer(method, path, key)` with a status and a JSON body.
fn relaycast(
    answer: impl Fn(&str, &str, &str) -> (u16, String) + Send + 'static,
) -> (String, Arc<Mutex<Vec<Seen>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = seen.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { return };
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            let mut parts = line.split_whitespace();
            let method = parts.next().unwrap_or_default().to_string();
            let path = parts.next().unwrap_or_default().to_string();
            let (mut key, mut length) = (String::new(), 0usize);
            loop {
                let mut header = String::new();
                reader.read_line(&mut header).unwrap();
                let header = header.trim_end();
                if header.is_empty() {
                    break;
                }
                let lower = header.to_ascii_lowercase();
                if let Some(value) = lower.strip_prefix("authorization: bearer ") {
                    key = header[header.len() - value.len()..].to_string();
                }
                if let Some(value) = lower.strip_prefix("content-length: ") {
                    length = value.trim().parse().unwrap_or(0);
                }
            }
            let mut body = vec![0; length];
            reader.read_exact(&mut body).unwrap();
            let (status, body) = answer(&method, &path, &key);
            log.lock().unwrap().push((method, path, key));
            let reply = format!(
                "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(reply.as_bytes());
        }
    });
    (base, seen)
}

fn rejected() -> (u16, String) {
    (
        401,
        r#"{"ok":false,"error":{"code":"unauthorized","message":"Invalid API key"}}"#.into(),
    )
}

fn not_found() -> (u16, String) {
    (
        404,
        r#"{"ok":false,"error":{"code":"agent_not_found","message":"Agent not found"}}"#.into(),
    )
}

fn agent(id: &str, name: &str) -> (u16, String) {
    (
        200,
        format!(
            r#"{{"ok":true,"data":{{"id":"{id}","name":"{name}","type":"agent","status":"offline"}}}}"#
        ),
    )
}

fn registration(name: &str, id: &str, base: &str) -> Registration {
    serde_json::from_value(serde_json::json!({
        "name": name,
        "agentID": format!("agent-{name}"),
        "target": {"kind": "codex", "id": id},
        "baseURL": base,
        "registeredAt": "2026-10-14T00:00:00Z",
        "workspaceKey": OLD,
        "missingSince": "2026-10-20T00:00:00Z",
    }))
    .unwrap()
}

fn core(base: &str) -> (Arc<Core>, tempfile::TempDir) {
    let temp = tempfile::tempdir().unwrap();
    let config = crate::relay::daemon::Config {
        paths: crate::relay::paths::CorePaths::for_socket(temp.path().join("core.sock")).unwrap(),
        home: temp.path().into(),
        app_data_dir: temp.path().join("app-data"),
        env: std::collections::BTreeMap::new(),
        version: "0.0.0-test".into(),
        host_name: "Test Desk.local".into(),
        rediscover_every: Duration::from_secs(3600),
        push_timing: crate::relay::push::PushTiming::default(),
        delivery_timing: crate::relay::delivery::DeliveryTiming::default(),
    };
    let (core, _signals) = Core::new(config);
    *core.workspace.lock().unwrap() = Some(crate::relay::workspace::Workspace {
        key: Secret::new(CURRENT),
        base_url: base.into(),
        workspace_id: None,
        source: crate::relay::workspace::WorkspaceSource::Cloud,
        control_url: None,
    });
    (core, temp)
}

fn stranded(core: &Core, base: &str) {
    core.store
        .update(|store| {
            for (name, id) in [
                ("gone", "01a0c221-6806-7210-af25-97e104b15049"),
                ("kept", "01a0c221-6806-7210-af25-97e104b15050"),
            ] {
                store.registrations.push(registration(name, id, base));
                store
                    .tokens
                    .insert(name.into(), Secret::new(format!("at_{name}")));
            }
            store.add_pending_cleanup(PendingCleanup {
                kind: CleanupKind::Agent,
                name: "old-alias".into(),
                base_url: base.into(),
                workspace_key: Secret::new(OLD),
            });
        })
        .unwrap();
}

fn names(core: &Core) -> Vec<String> {
    core.store
        .read(|s| s.registrations.iter().map(|r| r.name.clone()).collect())
}

#[tokio::test]
async fn a_rotated_key_is_proved_by_agent_id_and_every_saved_copy_moves() {
    let (base, seen) = relaycast(|method, path, key| match (method, key) {
        (_, OLD) => rejected(),
        ("GET", CURRENT) if path == "/v1/agents/gone" => agent("agent-gone", "gone"),
        ("DELETE", CURRENT) => (204, String::new()),
        _ => not_found(),
    });
    let (core, _temp) = core(&base);
    stranded(&core, &base);

    core.unregister_archived("gone").await.unwrap();

    assert_eq!(names(&core), ["kept"]);
    let deletes: Vec<Seen> = seen
        .lock()
        .unwrap()
        .iter()
        .filter(|(method, _, _)| method == "DELETE")
        .cloned()
        .collect();
    assert_eq!(
        deletes,
        [
            ("DELETE".into(), "/v1/agents/gone".into(), OLD.into()),
            ("DELETE".into(), "/v1/agents/gone".into(), CURRENT.into()),
        ]
    );
    // The other registration and the pending cleanup on the same rotated
    // key now carry the current one, so their writes stop failing too.
    let kept = core
        .store
        .read(|s| s.registrations[0].workspace_key.clone());
    assert_eq!(kept, Some(Secret::new(CURRENT)));
    let cleanup = core.store.read(|s| s.pending_cleanups.clone().unwrap());
    assert_eq!(cleanup[0].workspace_key, Secret::new(CURRENT));
}

#[tokio::test]
async fn an_agent_the_current_workspace_does_not_hold_leaves_this_computer_only() {
    // The current workspace has a different agent under that name: nothing
    // is deleted with the current key, and the stranded registration stops
    // costing writes here.
    let (base, seen) = relaycast(|method, _, key| match (method, key) {
        (_, OLD) => rejected(),
        ("GET", CURRENT) => agent("someone-else", "gone"),
        _ => (204, String::new()),
    });
    let (core, _temp) = core(&base);
    stranded(&core, &base);

    core.unregister_archived("gone").await.unwrap();

    assert_eq!(names(&core), ["kept"]);
    assert!(core.store.read(|s| !s.tokens.contains_key("gone")));
    assert!(
        !seen
            .lock()
            .unwrap()
            .iter()
            .any(|(method, _, key)| method == "DELETE" && key == CURRENT),
        "another workspace's agent must never be deleted"
    );
    let kept = core
        .store
        .read(|s| s.registrations[0].workspace_key.clone());
    assert_eq!(kept, Some(Secret::new(OLD)), "nothing proved a rotation");
}

#[tokio::test]
async fn a_rejection_the_current_key_cannot_settle_keeps_the_registration() {
    // The current key is rejected too (the core itself needs to sign in
    // again): nothing is proved, the registration stays for a later pass.
    let (base, _seen) = relaycast(|_, _, _| rejected());
    let (core, _temp) = core(&base);
    stranded(&core, &base);

    let error = core.unregister_archived("gone").await.unwrap_err();

    assert!(error.message.contains("HTTP 401"), "{}", error.message);
    assert_eq!(names(&core), ["gone", "kept"]);
}

#[tokio::test]
async fn a_forbidden_write_is_never_retried_with_another_key() {
    let (base, seen) = relaycast(|_, _, _| {
        (
            403,
            r#"{"ok":false,"error":{"code":"forbidden","message":"no"}}"#.into(),
        )
    });
    let (core, _temp) = core(&base);
    stranded(&core, &base);

    assert!(core.unregister_archived("gone").await.is_err());

    assert_eq!(names(&core), ["gone", "kept"]);
    assert!(seen.lock().unwrap().iter().all(|(_, _, key)| key == OLD));
}

#[test]
fn only_an_invalid_key_is_a_rejected_key() {
    let api = |status| relaycast::RelayError::Api {
        code: "x".into(),
        message: "x".into(),
        status,
        request_id: None,
        attempts: 1,
        retry_after_ms: None,
        details: None,
    };
    assert!(rejects_the_key(&api(401)));
    assert!(!rejects_the_key(&api(403)));
    assert!(!rejects_the_key(&api(503)));
}

#[tokio::test]
async fn a_presence_write_on_a_rotated_key_lands_with_the_current_one_and_one_out_of_reach_stops() {
    let (base, seen) = relaycast(|method, path, key| match (method, key) {
        (_, OLD) => rejected(),
        ("GET", CURRENT) if path == "/v1/agents/gone" => agent("agent-gone", "gone"),
        ("GET", CURRENT) => not_found(),
        _ => agent("agent-gone", "gone"),
    });
    let (core, _temp) = core(&base);
    stranded(&core, &base);
    let gone = core.store.read(|s| s.registrations[0].clone());
    let write = |key: Secret| {
        let base = base.clone();
        async move { crate::relay::client::update_agent_status(&base, &key, "gone", "idle").await }
    };

    let (result, unreachable) = core
        .write_with_saved_key(&gone, &Secret::new(OLD), write)
        .await;
    assert!(result.is_ok(), "{result:?}");
    assert!(!unreachable);
    let patched: Vec<String> = seen
        .lock()
        .unwrap()
        .iter()
        .filter(|(method, _, _)| method == "PATCH")
        .map(|(_, _, key)| key.clone())
        .collect();
    assert_eq!(patched, [OLD, CURRENT]);

    // A registration the current workspace does not hold: reported out of
    // reach, so its marker and presence are not retried every pass.
    let mut other = registration("elsewhere", "01a0c221-6806-7210-af25-97e104b15051", &base);
    other.agent_id = "agent-elsewhere".into();
    let (result, unreachable) = core
        .write_with_saved_key(&other, &Secret::new(OLD), write)
        .await;
    assert!(result.is_err());
    assert!(unreachable);
}

#[tokio::test]
async fn a_name_marker_on_a_rotated_key_is_published_with_the_current_one() {
    let (base, seen) = relaycast(|method, path, key| match (method, key) {
        (_, OLD) => rejected(),
        ("GET", CURRENT) if path == "/v1/agents/gone" => agent("agent-gone", "gone"),
        ("GET", CURRENT) => not_found(),
        _ => agent("agent-gone", "gone"),
    });
    let (core, _temp) = core(&base);
    stranded(&core, &base);
    core.store
        .update(|s| s.pending_name_markers = Some(vec!["gone".into()]))
        .unwrap();

    core.retry_name_markers().await;

    let patched: Vec<String> = seen
        .lock()
        .unwrap()
        .iter()
        .filter(|(method, _, _)| method == "PATCH")
        .map(|(_, _, key)| key.clone())
        .collect();
    assert_eq!(patched, [OLD, CURRENT]);
    // The saved key changed under the publish, so the marker is sent once
    // more as the registration now stands, with the current key, and done.
    core.retry_name_markers().await;
    let last = seen.lock().unwrap().last().cloned().unwrap();
    assert_eq!((last.0.as_str(), last.2.as_str()), ("PATCH", CURRENT));
    assert!(core.store.read(|s| s.pending_name_markers.is_none()));
}

#[tokio::test]
async fn a_name_marker_out_of_reach_is_not_retried_but_a_transient_failure_is() {
    let (base, _seen) = relaycast(|method, _, key| match (method, key) {
        (_, OLD) => rejected(),
        _ => not_found(),
    });
    let (core, _temp) = core(&base);
    stranded(&core, &base);
    core.store
        .update(|s| s.pending_name_markers = Some(vec!["gone".into()]))
        .unwrap();
    core.retry_name_markers().await;
    assert!(core.store.read(|s| s.pending_name_markers.is_none()));

    // With no other key to ask, nothing is proved: the marker waits.
    *core.workspace.lock().unwrap() = None;
    core.store
        .update(|s| s.pending_name_markers = Some(vec!["gone".into()]))
        .unwrap();
    core.retry_name_markers().await;
    assert_eq!(
        core.store.read(|s| s.pending_name_markers.clone()),
        Some(vec!["gone".to_string()])
    );
}

/// The warning activity lines published while `run` goes.
async fn warnings_during(core: &Core, run: impl std::future::Future<Output = ()>) -> Vec<String> {
    let mut events = core.hub.subscribe();
    run.await;
    let mut lines = Vec::new();
    while let Ok(event) = events.try_recv() {
        if event.data["level"] == "warning" {
            lines.push(
                event.data["message"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string(),
            );
        }
    }
    lines
}

#[tokio::test]
async fn an_agent_out_of_reach_leaves_revoking_its_webhook_by_id_and_naming_what_is_left() {
    // Nothing is removed by name with the current key (a channel named like
    // its webhook's there may be someone else's); the webhook is revoked by
    // its id, which only this agent's webhook carries.
    let (base, seen) = relaycast(|method, _, key| match (method, key) {
        (_, OLD) => rejected(),
        ("DELETE", CURRENT) => (204, String::new()),
        _ => not_found(),
    });
    let (core, _temp) = core(&base);
    stranded(&core, &base);
    core.store
        .update(|s| {
            let gone = &mut s.registrations[0];
            gone.webhook = serde_json::from_value(serde_json::json!({
                "id": "wh_1", "url": "https://hooks.example/wh_1", "token": "wh_live_secret",
                "channelName": "hook-gone", "channelID": "ch_1",
            }))
            .unwrap();
            gone.integration_channel_name = Some("int-gone".into());
            gone.integrations = serde_json::from_value(serde_json::json!([{
                "id": "int_1", "provider": "github", "resource": "repo",
                "workspaceID": "ws_old",
            }]))
            .unwrap();
        })
        .unwrap();

    let warnings = warnings_during(&core, async {
        core.unregister_archived("gone").await.unwrap();
    })
    .await;

    assert_eq!(names(&core), ["kept"]);
    let current: Vec<String> = seen
        .lock()
        .unwrap()
        .iter()
        .filter(|(method, _, key)| method == "DELETE" && key == CURRENT)
        .map(|(_, path, _)| path.clone())
        .collect();
    assert_eq!(current.len(), 1, "{current:?}");
    assert!(current[0].contains("wh_1"), "{current:?}");
    let warning = warnings.join("\n");
    for named in ["wh_1", "hook-gone", "int-gone", "integration subscriptions"] {
        assert!(warning.contains(named), "{named} not named: {warning}");
    }
}

#[tokio::test]
async fn a_presence_change_out_of_reach_is_dropped_not_retried() {
    let (base, seen) = relaycast(|method, _, key| match (method, key) {
        (_, OLD) => rejected(),
        _ => not_found(),
    });
    let (core, _temp) = core(&base);
    stranded(&core, &base);
    core.presence_pending
        .lock()
        .unwrap()
        .insert("gone".into(), "idle");
    core.announce_pending_presence().await;
    assert!(core.presence_pending.lock().unwrap().is_empty());
    let before = seen.lock().unwrap().len();
    core.announce_pending_presence().await;
    assert_eq!(seen.lock().unwrap().len(), before, "nothing retried");
}
