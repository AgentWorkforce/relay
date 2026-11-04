//! A spawned agent leaves the relay once its session has ended for the
//! grace period, as an automatic one does. A Codex thread ends when it is
//! archived; one Codex merely unloaded (idle) stays. A session that runs
//! again after its agent left is a new agent, never the old name back.

use super::*;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;

/// A Relaycast REST stand-in that accepts every write, recording each
/// `DELETE` path.
fn accepting_relaycast() -> (String, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let deleted = Arc::new(Mutex::new(Vec::new()));
    let log = deleted.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { return };
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            let mut parts = line.split_whitespace();
            let method = parts.next().unwrap_or_default().to_string();
            let path = parts.next().unwrap_or_default().to_string();
            let mut length = 0usize;
            loop {
                let mut header = String::new();
                reader.read_line(&mut header).unwrap();
                let header = header.trim_end().to_ascii_lowercase();
                if header.is_empty() {
                    break;
                }
                if let Some(value) = header.strip_prefix("content-length: ") {
                    length = value.trim().parse().unwrap_or(0);
                }
            }
            let mut body = vec![0; length];
            reader.read_exact(&mut body).unwrap();
            let reply = if method == "DELETE" {
                log.lock().unwrap().push(path);
                "HTTP/1.1 204 No Content\r\nconnection: close\r\n\r\n".to_string()
            } else {
                let body = if method == "PATCH" {
                    r#"{"ok":true,"data":{"id":"a","name":"a","type":"agent","status":"online"}}"#
                } else {
                    r#"{"ok":true,"data":null}"#
                };
                format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                )
            };
            let _ = stream.write_all(reply.as_bytes());
        }
    });
    (base, deleted)
}

/// Moves `name`'s absence back past the grace period, as if its session
/// had been gone that long.
fn gone_long_ago(core: &Core, name: &str) {
    core.store
        .update(|store| {
            let registration = store
                .registrations
                .iter_mut()
                .find(|r| r.name == name)
                .unwrap();
            assert!(
                registration.missing_since.is_some(),
                "@{name} is not marked absent"
            );
            registration.missing_since = Some("2026-10-01T00:00:00Z".into());
        })
        .unwrap();
}

fn registered(core: &Core, name: &str) -> bool {
    core.store
        .read(|store| store.registrations.iter().any(|r| r.name == name))
}

#[tokio::test]
async fn a_spawned_agent_leaves_the_relay_once_its_session_has_ended_past_the_grace() {
    let home = tempfile::tempdir().unwrap();
    let (base, deleted) = accepting_relaycast();
    let core = core_at(home.path(), Arc::new(FakeSpawner::default()), &base);
    let observer = observed(&core);
    spawn(&core, "w1").await;
    let target = named(&core, "w1").target;
    // Its session ended (for Codex: the thread was archived).
    observer.set("w1", ProcessLiveness::Exited, WorkState::Completed, false);
    core.observe_spawned().await;

    // First pass: marked absent, still registered: a brief miss survives.
    core.activate_new_sessions().await;
    assert!(registered(&core, "w1"));
    assert!(named(&core, "w1").missing_since.is_some());
    assert!(deleted.lock().unwrap().is_empty());

    // Gone for the grace period: it leaves, and its name is released, with
    // nothing left listed as connected.
    core.hub.update(|status| {
        status
            .push
            .insert("w1".into(), crate::relay::push::PushState::Live);
    });
    gone_long_ago(&core, "w1");
    let failures = core.activate_new_sessions().await;
    assert!(failures.is_empty(), "{failures:?}");
    assert!(!registered(&core, "w1"));
    assert_eq!(*deleted.lock().unwrap(), ["/v1/agents/w1"]);
    assert!(!core.spawned_targets().contains(&target));
    assert!(core.hub.snapshot().push.get("w1").is_none());
}

#[tokio::test]
async fn an_unloaded_but_unarchived_codex_thread_stays_on_the_relay() {
    let home = tempfile::tempdir().unwrap();
    let (base, deleted) = accepting_relaycast();
    let core = core_at(home.path(), Arc::new(FakeSpawner::default()), &base);
    let observer = observed(&core);
    spawn(&core, "idle").await;
    // No app-server has the thread loaded: paused, not ended.
    observer.set("idle", ProcessLiveness::Unknown, WorkState::Idle, false);
    core.observe_spawned().await;
    for _ in 0..2 {
        let failures = core.activate_new_sessions().await;
        assert!(failures.is_empty(), "{failures:?}");
    }
    assert!(registered(&core, "idle"));
    assert!(named(&core, "idle").missing_since.is_none());
    assert!(deleted.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_spawned_agent_is_not_taken_off_before_this_core_has_looked() {
    // After a restart, an agent marked absent long ago waits for the first
    // observation: it may be running again.
    let home = tempfile::tempdir().unwrap();
    let (base, deleted) = accepting_relaycast();
    let first = core_at(home.path(), Arc::new(FakeSpawner::default()), &base);
    let observer = observed(&first);
    spawn(&first, "w1").await;
    observer.set("w1", ProcessLiveness::Exited, WorkState::Completed, false);
    first.observe_spawned().await;
    first.activate_new_sessions().await;
    gone_long_ago(&first, "w1");
    first.stop_spawn_node().await;
    drop(first);

    let core = core_at(home.path(), Arc::new(FakeSpawner::default()), &base);
    observed(&core);
    core.activate_new_sessions().await;
    assert!(registered(&core, "w1"), "removed before any observation");
    assert!(deleted.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_session_that_runs_again_after_its_agent_left_is_a_new_agent() {
    let home = tempfile::tempdir().unwrap();
    let (base, _deleted) = accepting_relaycast();
    let core = core_at(home.path(), Arc::new(FakeSpawner::default()), &base);
    let observer = observed(&core);
    spawn(&core, "w1").await;
    let old = named(&core, "w1");

    // Seen ended, then running again within the grace period: a brief miss,
    // the same agent.
    observer.set("w1", ProcessLiveness::Exited, WorkState::Completed, false);
    core.observe_spawned().await;
    core.activate_new_sessions().await;
    observer.set("w1", ProcessLiveness::Running, WorkState::Idle, false);
    core.observe_spawned().await;
    core.activate_new_sessions().await;
    assert_eq!(named(&core, "w1").agent_id, old.agent_id);
    assert!(named(&core, "w1").missing_since.is_none());

    // Ended past the grace period: it leaves, taking its identity and queue.
    observer.set("w1", ProcessLiveness::Exited, WorkState::Completed, false);
    core.observe_spawned().await;
    core.activate_new_sessions().await;
    gone_long_ago(&core, "w1");
    core.activate_new_sessions().await;
    assert!(!registered(&core, "w1"));

    // The session resumed later finds nothing of the old agent: no spawned
    // record holds its session, nothing presents it as running, and the
    // session is open to a fresh registration (a new Relaycast identity).
    observer.set("w1", ProcessLiveness::Running, WorkState::Idle, false);
    core.observe_spawned().await;
    assert!(core
        .store
        .read(|store| store.registration_for(&old.target).is_none()));
    assert!(!core.spawned_targets().contains(&old.target));
    assert!(core.spawned_live().is_empty());
    assert!(core
        .spawn_advertisement(&[codex::ID], &[])
        .live
        .agents
        .is_empty());
}

#[tokio::test]
async fn a_taken_over_agent_leaves_once_the_persons_session_has_ended() {
    // Decided: a spawned agent leaves after its session ends, taken over
    // or not; the person's later session is a new agent.
    let home = tempfile::tempdir().unwrap();
    let (base, deleted) = accepting_relaycast();
    let spawner = Arc::new(FakeSpawner::default());
    let core = core_at(home.path(), spawner.clone(), &base);
    let observer = observed(&core);
    spawn(&core, "w1").await;
    core.store
        .update(|store| {
            let spawn = store.registrations[0].spawn.as_mut().unwrap();
            spawn.taken_over_at = Some("2026-10-01T00:00:00Z".into());
        })
        .unwrap();
    observer.set("w1", ProcessLiveness::Exited, WorkState::Completed, false);
    core.observe_spawned().await;
    core.activate_new_sessions().await;
    gone_long_ago(&core, "w1");
    core.activate_new_sessions().await;
    assert!(!registered(&core, "w1"));
    assert_eq!(*deleted.lock().unwrap(), ["/v1/agents/w1"]);
    // The person's process is theirs: nothing was stopped.
    assert!(spawner.stopped.lock().unwrap().is_empty());
}
