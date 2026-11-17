//! A spawned agent leaves the relay once its session has ended for the
//! grace period, as an automatic one does. A Codex thread ends when it is
//! archived; one Codex merely unloaded (idle) stays. A session that runs
//! again after its agent left is a new agent, never the old name back.

use super::*;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicUsize, Ordering};

/// A Relaycast REST stand-in that accepts every write, recording each
/// `DELETE` path.
fn accepting_relaycast() -> (String, Arc<Mutex<Vec<String>>>) {
    relaycast(r#"{"ok":true,"data":[]}"#.to_string())
}

/// Like [`accepting_relaycast`], with `queue` as the deliveries body.
fn relaycast(queue: String) -> (String, Arc<Mutex<Vec<String>>>) {
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
                } else if path.contains("deliveries") {
                    // An empty queue is `{"ok":true,"data":[]}`. `data: null`
                    // is an unreadable list, and a failed read keeps an idle
                    // Grok leader.
                    queue.as_str()
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
async fn an_idle_grok_leader_is_ended_after_a_day_and_a_codex_agent_is_not() {
    // The core will not open HTTP while file-selected roots are set. This
    // process can inherit them; the queue read has to be allowed to run.
    std::env::remove_var("SSL_CERT_FILE");
    std::env::remove_var("SSL_CERT_DIR");
    let home = tempfile::tempdir().unwrap();
    let (base, deleted) = accepting_relaycast();
    let spawner = Arc::new(FakeSpawner::default());
    let core = core_at(home.path(), spawner.clone(), &base);
    let observer = observed(&core);
    spawn(&core, "leader").await;
    spawn(&core, "codex-idle").await;
    core.store
        .update(|store| {
            let leader = store
                .registrations
                .iter_mut()
                .find(|r| r.name == "leader")
                .unwrap();
            leader.target.kind = crate::relay::store::SessionKind::Grok;
            leader.spawn.as_mut().unwrap().harness = crate::relay::harness::grok::ID.name().into();
        })
        .unwrap();
    observer.set("leader", ProcessLiveness::Running, WorkState::Idle, false);
    observer.set(
        "codex-idle",
        ProcessLiveness::Running,
        WorkState::Idle,
        false,
    );

    // First sight of idle starts the clock. A day has not passed.
    core.observe_spawned().await;
    assert!(registered(&core, "leader"));
    assert!(spawner.stopped.lock().unwrap().is_empty());

    let stale = chrono::Utc::now() - chrono::Duration::hours(25);
    {
        let ledger = core.ledger();
        let mut state = ledger.lock();
        assert!(state.agents["leader"].idle_since.is_some());
        state.agents.get_mut("leader").unwrap().idle_since = Some(stale);
        assert!(state.agents["codex-idle"].idle_since.is_none());
    }
    // Spawn saved a Codex receipt. Replaying it as Grok is refused, so the
    // leader would be kept. A real Grok launch writes its own receipt.
    let receipts = home.path().join("app-data/spawn-completions");
    for entry in std::fs::read_dir(&receipts).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().is_some_and(|ext| ext == "json") {
            std::fs::remove_file(path).unwrap();
        }
    }
    core.observe_spawned().await;
    assert!(
        !registered(&core, "leader"),
        "deleted={:?} stopped={}",
        deleted.lock().unwrap(),
        spawner.stopped.lock().unwrap().len(),
    );
    assert!(registered(&core, "codex-idle"));
    assert_eq!(deleted.lock().unwrap().as_slice(), ["/v1/agents/leader"]);
    assert!(spawner
        .stopped
        .lock()
        .unwrap()
        .iter()
        .any(|target| target.kind == crate::relay::store::SessionKind::Grok));

    // A turn clears the clock, so a later idle hour does not end it.
    spawn(&core, "busy").await;
    core.store
        .update(|store| {
            let busy = store
                .registrations
                .iter_mut()
                .find(|r| r.name == "busy")
                .unwrap();
            busy.target.kind = crate::relay::store::SessionKind::Grok;
            busy.spawn.as_mut().unwrap().harness = crate::relay::harness::grok::ID.name().into();
        })
        .unwrap();
    observer.set("busy", ProcessLiveness::Running, WorkState::Idle, false);
    core.observe_spawned().await;
    {
        let ledger = core.ledger();
        ledger.lock().agents.get_mut("busy").unwrap().idle_since = Some(stale);
    }
    observer.set("busy", ProcessLiveness::Running, WorkState::Working, true);
    core.observe_spawned().await;
    {
        let ledger = core.ledger();
        assert!(ledger.lock().agents["busy"].idle_since.is_none());
    }
    observer.set("busy", ProcessLiveness::Running, WorkState::Idle, false);
    core.observe_spawned().await;
    assert!(registered(&core, "busy"));
    {
        let ledger = core.ledger();
        assert!(ledger.lock().agents["busy"].idle_since.is_some());
    }
}

/// A session log whose last turn is `events`, on a Grok-shaped registration.
fn write_grok_events(core: &Core, name: &str, events: &str) -> std::path::PathBuf {
    use crate::relay::existing_session::{Binding, Provider, Transport};
    use crate::relay::harness::grok::{grok_record_folder, write_spawned_record, SpawnedGrok};
    const SESSION: &str = "01a0fd4c-3771-7a20-9f41-6f86d56624f9";
    core.store
        .update(|store| {
            let leader = store
                .registrations
                .iter_mut()
                .find(|registration| registration.name == name)
                .unwrap();
            leader.target.kind = crate::relay::store::SessionKind::Grok;
            leader.target.id = SESSION.into();
            let spawn = leader.spawn.as_mut().unwrap();
            spawn.harness = crate::relay::harness::grok::ID.name().into();
        })
        .unwrap();
    let folder = core.config.app_data_dir.join("spawned-agents/grok");
    grok_record_folder(&folder).unwrap();
    let cwd = core.config.home.join("work");
    let record = SpawnedGrok {
        binding: Binding {
            provider: Provider::Grok,
            transport: Transport::Acp,
            workspace_id: "agent-relay-spawn".into(),
            session_id: SESSION.into(),
            endpoint_id: String::new(),
            owner_id: "agent-relay-spawn".into(),
            credential_reference: format!("probe:grok:{}", "0".repeat(64)),
            owner_uid: crate::relay::peer::current_uid(),
            auth_id: String::new(),
            protocol_id: String::new(),
            cwd: cwd.clone(),
            model_id: "grok-4.7".into(),
            agent_version: "1.0.46".into(),
            executable: "/usr/local/bin/grok".into(),
            leader_pid: 999_999_999,
            leader_start: 77,
            socket_path: "/tmp/grok-leader.sock".into(),
            socket_device: 12,
            socket_inode: 34,
        },
        grok_home: core.config.home.join(".grok"),
    };
    write_spawned_record(&folder, &record).unwrap();
    let path = record.events();
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, events).unwrap();
    path
}

fn drop_spawn_receipts(home: &std::path::Path) {
    let receipts = home.join("app-data/spawn-completions");
    let Ok(entries) = std::fs::read_dir(&receipts) else {
        return;
    };
    for entry in entries {
        let path = entry.unwrap().path();
        if path.extension().is_some_and(|ext| ext == "json") {
            std::fs::remove_file(path).unwrap();
        }
    }
}

/// Relaycast that appends a running turn when the queue is read, then
/// reports that queue empty. The path is filled in once the session log exists.
fn queue_that_starts_a_turn(events: Arc<Mutex<Option<std::path::PathBuf>>>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
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
                if header.trim_end().is_empty() {
                    break;
                }
                if let Some(value) = header
                    .trim_end()
                    .to_ascii_lowercase()
                    .strip_prefix("content-length: ")
                {
                    length = value.trim().parse().unwrap_or(0);
                }
            }
            let mut body = vec![0; length];
            reader.read_exact(&mut body).unwrap();
            let reply = if method == "DELETE" {
                "HTTP/1.1 204 No Content\r\nconnection: close\r\n\r\n".to_string()
            } else {
                if path.contains("deliveries") {
                    use std::io::Write as _;
                    let path = events.lock().unwrap().clone();
                    let Some(path) = path else {
                        panic!("the session log was not set");
                    };
                    let mut file = std::fs::OpenOptions::new().append(true).open(path).unwrap();
                    file.write_all(b"{\"type\":\"turn_started\"}\n").unwrap();
                }
                let body = if method == "PATCH" {
                    r#"{"ok":true,"data":{"id":"a","name":"a","type":"agent","status":"online"}}"#
                } else if path.contains("deliveries") {
                    r#"{"ok":true,"data":[]}"#
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
    base
}

#[tokio::test]
async fn a_grok_leader_turn_between_looks_restarts_its_idle_clock() {
    std::env::remove_var("SSL_CERT_FILE");
    std::env::remove_var("SSL_CERT_DIR");
    let home = tempfile::tempdir().unwrap();
    let (base, deleted) = accepting_relaycast();
    let spawner = Arc::new(FakeSpawner::default());
    let core = core_at(home.path(), spawner.clone(), &base);
    let observer = observed(&core);
    spawn(&core, "leader").await;
    let events = write_grok_events(&core, "leader", "{\"type\":\"turn_ended\"}\n");
    observer.set("leader", ProcessLiveness::Running, WorkState::Idle, false);
    core.observe_spawned().await;
    let stale = chrono::Utc::now() - chrono::Duration::hours(25);
    {
        let ledger = core.ledger();
        let mut state = ledger.lock();
        let record = state.agents.get_mut("leader").unwrap();
        assert!(record.idle_mark.is_some());
        record.idle_since = Some(stale);
    }
    // A short turn finished before the next look. The log is the evidence.
    std::fs::write(
        &events,
        "{\"type\":\"turn_ended\"}\n{\"type\":\"turn_started\"}\n{\"type\":\"turn_ended\"}\n",
    )
    .unwrap();
    drop_spawn_receipts(home.path());
    core.observe_spawned().await;
    assert!(registered(&core, "leader"));
    assert!(spawner.stopped.lock().unwrap().is_empty());
    assert!(deleted.lock().unwrap().is_empty());
    {
        let ledger = core.ledger();
        let since = ledger.lock().agents["leader"].idle_since.unwrap();
        assert!(since > stale);
    }
}

#[tokio::test]
async fn a_grok_leader_that_is_working_or_replaced_is_not_ended() {
    std::env::remove_var("SSL_CERT_FILE");
    std::env::remove_var("SSL_CERT_DIR");
    let home = tempfile::tempdir().unwrap();
    let (base, _) = accepting_relaycast();
    let spawner = Arc::new(FakeSpawner::default());
    let core = core_at(home.path(), spawner.clone(), &base);
    spawn(&core, "leader").await;
    let events = write_grok_events(&core, "leader", "{\"type\":\"turn_ended\"}\n");
    // A different agent now holds the name: the idle sample must not end it.
    core.end_idle_grok_leader("leader", "someone-else", None)
        .await
        .unwrap();
    assert!(registered(&core, "leader"));
    let agent_id = named(&core, "leader").agent_id;
    std::fs::write(&events, "{\"type\":\"turn_started\"}\n").unwrap();
    core.end_idle_grok_leader("leader", &agent_id, None)
        .await
        .unwrap();
    assert!(registered(&core, "leader"));
    assert!(spawner.stopped.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_grok_leader_turn_that_starts_before_the_stop_is_left_running() {
    std::env::remove_var("SSL_CERT_FILE");
    std::env::remove_var("SSL_CERT_DIR");
    let home = tempfile::tempdir().unwrap();
    let events = Arc::new(Mutex::new(None));
    let base = queue_that_starts_a_turn(events.clone());
    let spawner = Arc::new(FakeSpawner::default());
    let core = core_at(home.path(), spawner.clone(), &base);
    let observer = observed(&core);
    spawn(&core, "leader").await;
    *events.lock().unwrap() = Some(write_grok_events(
        &core,
        "leader",
        "{\"type\":\"turn_ended\"}\n",
    ));
    observer.set("leader", ProcessLiveness::Running, WorkState::Idle, false);
    core.observe_spawned().await;
    {
        let ledger = core.ledger();
        ledger.lock().agents.get_mut("leader").unwrap().idle_since =
            Some(chrono::Utc::now() - chrono::Duration::hours(25));
    }
    drop_spawn_receipts(home.path());
    core.observe_spawned().await;
    assert!(
        registered(&core, "leader"),
        "stopped={}",
        spawner.stopped.lock().unwrap().len()
    );
    assert!(spawner.stopped.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_grok_leader_with_no_credential_is_not_ended() {
    std::env::remove_var("SSL_CERT_FILE");
    std::env::remove_var("SSL_CERT_DIR");
    let home = tempfile::tempdir().unwrap();
    let (base, deleted) = accepting_relaycast();
    let spawner = Arc::new(FakeSpawner::default());
    let core = core_at(home.path(), spawner.clone(), &base);
    let observer = observed(&core);
    spawn(&core, "leader").await;
    core.store
        .update(|store| {
            let leader = store
                .registrations
                .iter_mut()
                .find(|registration| registration.name == "leader")
                .unwrap();
            leader.target.kind = crate::relay::store::SessionKind::Grok;
            let spawn = leader.spawn.as_mut().unwrap();
            spawn.harness = crate::relay::harness::grok::ID.name().into();
            // A gate launch's token lives in memory. After a restart the
            // queue cannot be read, which is not an empty queue.
            spawn.gate_launch = true;
        })
        .unwrap();
    observer.set("leader", ProcessLiveness::Running, WorkState::Idle, false);
    core.observe_spawned().await;
    {
        let ledger = core.ledger();
        ledger.lock().agents.get_mut("leader").unwrap().idle_since =
            Some(chrono::Utc::now() - chrono::Duration::hours(25));
    }
    drop_spawn_receipts(home.path());
    core.observe_spawned().await;
    assert!(registered(&core, "leader"));
    assert!(spawner.stopped.lock().unwrap().is_empty());
    assert!(deleted.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_grok_leader_with_a_full_queue_page_is_not_ended() {
    std::env::remove_var("SSL_CERT_FILE");
    std::env::remove_var("SSL_CERT_DIR");
    let home = tempfile::tempdir().unwrap();
    // The oldest page, already settled. A later unread message would sit
    // past it, so this is not an empty queue.
    let items: Vec<String> = (0..crate::relay::client::QUEUE_PAGE)
        .map(|index| {
            format!(r#"{{"id":"del_{index}","message_id":"msg_{index}","status":"acked"}}"#)
        })
        .collect();
    let (base, deleted) = relaycast(format!(r#"{{"ok":true,"data":[{}]}}"#, items.join(",")));
    let spawner = Arc::new(FakeSpawner::default());
    let core = core_at(home.path(), spawner.clone(), &base);
    let observer = observed(&core);
    spawn(&core, "leader").await;
    core.store
        .update(|store| {
            let leader = store
                .registrations
                .iter_mut()
                .find(|registration| registration.name == "leader")
                .unwrap();
            leader.target.kind = crate::relay::store::SessionKind::Grok;
            leader.spawn.as_mut().unwrap().harness = crate::relay::harness::grok::ID.name().into();
        })
        .unwrap();
    observer.set("leader", ProcessLiveness::Running, WorkState::Idle, false);
    core.observe_spawned().await;
    {
        let ledger = core.ledger();
        ledger.lock().agents.get_mut("leader").unwrap().idle_since =
            Some(chrono::Utc::now() - chrono::Duration::hours(25));
    }
    drop_spawn_receipts(home.path());
    core.observe_spawned().await;
    assert!(registered(&core, "leader"));
    assert!(spawner.stopped.lock().unwrap().is_empty());
    assert!(deleted.lock().unwrap().is_empty());
}

/// The first queue read is empty. The read at the stop finds a message
/// that arrived after that, and the leader stays.
fn queue_that_fills_before_the_stop() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let reads = AtomicUsize::new(0);
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
            let mut request = vec![0; length];
            reader.read_exact(&mut request).unwrap();
            let reply = if method == "DELETE" {
                "HTTP/1.1 204 No Content\r\nconnection: close\r\n\r\n".to_string()
            } else {
                let body = if method == "PATCH" {
                    r#"{"ok":true,"data":{"id":"a","name":"a","type":"agent","status":"online"}}"#
                        .to_string()
                } else if path.contains("deliveries") {
                    let read = reads.fetch_add(1, Ordering::SeqCst);
                    if read == 0 {
                        r#"{"ok":true,"data":[]}"#.to_string()
                    } else {
                        r#"{"ok":true,"data":[{"id":"del_late","message_id":"msg_late","status":"queued"}]}"#
                            .to_string()
                    }
                } else {
                    r#"{"ok":true,"data":null}"#.to_string()
                };
                format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                )
            };
            let _ = stream.write_all(reply.as_bytes());
        }
    });
    base
}

#[tokio::test]
async fn a_grok_leader_stays_when_a_message_arrives_before_the_stop() {
    std::env::remove_var("SSL_CERT_FILE");
    std::env::remove_var("SSL_CERT_DIR");
    let home = tempfile::tempdir().unwrap();
    let base = queue_that_fills_before_the_stop();
    let spawner = Arc::new(FakeSpawner::default());
    let core = core_at(home.path(), spawner.clone(), &base);
    let observer = observed(&core);
    spawn(&core, "leader").await;
    core.store
        .update(|store| {
            let leader = store
                .registrations
                .iter_mut()
                .find(|registration| registration.name == "leader")
                .unwrap();
            leader.target.kind = crate::relay::store::SessionKind::Grok;
            leader.spawn.as_mut().unwrap().harness = crate::relay::harness::grok::ID.name().into();
        })
        .unwrap();
    observer.set("leader", ProcessLiveness::Running, WorkState::Idle, false);
    core.observe_spawned().await;
    {
        let ledger = core.ledger();
        ledger.lock().agents.get_mut("leader").unwrap().idle_since =
            Some(chrono::Utc::now() - chrono::Duration::hours(25));
    }
    drop_spawn_receipts(home.path());
    core.observe_spawned().await;
    assert!(registered(&core, "leader"));
    assert!(spawner.stopped.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_grok_leader_whose_log_cannot_be_read_is_not_ended() {
    std::env::remove_var("SSL_CERT_FILE");
    std::env::remove_var("SSL_CERT_DIR");
    let home = tempfile::tempdir().unwrap();
    let (base, _) = accepting_relaycast();
    let spawner = Arc::new(FakeSpawner::default());
    let core = core_at(home.path(), spawner.clone(), &base);
    spawn(&core, "leader").await;
    let events = write_grok_events(&core, "leader", "{\"type\":\"turn_ended\"}\n");
    std::fs::remove_file(&events).unwrap();
    std::fs::create_dir(&events).unwrap();
    let agent_id = named(&core, "leader").agent_id;
    drop_spawn_receipts(home.path());
    core.end_idle_grok_leader("leader", &agent_id, None)
        .await
        .unwrap();
    assert!(registered(&core, "leader"));
    assert!(spawner.stopped.lock().unwrap().is_empty());
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
