//! Spawns whose `agent.register` went unanswered, and retries that meet
//! the agent such a spawn left holding its name.

use super::super::unanswered::Unanswered;
use super::*;

/// Relaycast's REST API answering `GET /v1/agents/{name}` with `agent`,
/// and anything else with 404.
fn relaycast_rest(agent: Value) -> String {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let base_url = format!("http://{}", listener.local_addr().unwrap());
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
            let (status, body) = if String::from_utf8_lossy(&request).starts_with("GET /v1/agents/")
            {
                ("200 OK", json!({"ok": true, "data": agent}))
            } else {
                (
                    "404 Not Found",
                    json!({"ok": false, "error": {"code": "not_found", "message": "not here"}}),
                )
            };
            let body = body.to_string();
            let _ = write!(
                stream,
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
        }
    });
    base_url
}

/// Relaycast's REST API answering `GET /v1/agents/{name}` with 404 the
/// first time and `agent` after: a register write still landing.
fn relaycast_rest_landing(agent: Value) -> String {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    std::thread::spawn(move || {
        let mut asked = 0;
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
            let lookup = String::from_utf8_lossy(&request).starts_with("GET /v1/agents/");
            if lookup {
                asked += 1;
            }
            let (status, body) = if lookup && asked > 1 {
                ("200 OK", json!({"ok": true, "data": agent}))
            } else {
                (
                    "404 Not Found",
                    json!({"ok": false, "error": {"code": "agent_not_found", "message": "not here"}}),
                )
            };
            let body = body.to_string();
            let _ = write!(
                stream,
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
        }
    });
    base_url
}

/// Relaycast's record of `w1`, stamped with `invocation`.
fn agent_w1(id: &str, invocation: &str) -> Value {
    json!({"id": id, "name": "w1",
        "metadata": {"fleet": {"node_id": "node_desktop_1", "invocation_id": invocation}}})
}

/// An intent whose register was sent and never answered, against `rest`.
fn unanswered_at(rest: &str) -> intents::Intent {
    let mut intent = interrupted("w1", false, None);
    intent.register_sent = true;
    intent.base_url = rest.to_string();
    intent
}

#[tokio::test]
async fn cancelling_a_spawn_awaiting_its_register_keeps_its_intent() {
    let home = tempfile::tempdir().unwrap();
    let core = core(home.path(), Arc::new(FakeSpawner::default()));
    // Nobody answers the register.
    let (link, mut sent) = NodeLink::detached(node());
    let spawning = tokio::spawn(core.clone().answer_spawn(link, request("w1")));
    let frame = next_frame(&mut sent).await;
    assert_eq!(frame["type"], "agent.register");
    spawning.abort();
    assert!(spawning.await.unwrap_err().is_cancelled());
    let kept = intents::load(&core.config.app_data_dir);
    assert_eq!(kept.len(), 1, "Relaycast may have registered the agent");
    assert!(kept[0].register_sent);
    assert_eq!(kept[0].agent_id, None);
}

#[tokio::test]
async fn a_refused_register_leaves_nothing_to_recover() {
    let home = tempfile::tempdir().unwrap();
    let core = core(home.path(), Arc::new(FakeSpawner::default()));
    let (link, mut sent) = NodeLink::detached(node());
    let spawning = tokio::spawn(core.clone().answer_spawn(link.clone(), request("w1")));
    let frame = next_frame(&mut sent).await;
    link.answer(
        &json!({"v": 1, "id": frame["id"], "type": "error", "ok": false,
        "code": "node_capacity_exceeded", "message": "full"}),
    );
    let result = spawning.await.unwrap();
    assert_eq!(result["error"], "spawn_capacity_exceeded: full");
    assert!(intents::load(&core.config.app_data_dir).is_empty());
}

#[tokio::test]
async fn a_restart_finds_and_ends_the_agent_of_an_unanswered_register() {
    let home = tempfile::tempdir().unwrap();
    // Relaycast registered it, stamped with this invocation.
    let rest = relaycast_rest(agent_w1("agent_w1", "inv_w1"));
    let core = core_at(home.path(), Arc::new(FakeSpawner::default()), &rest);
    let dir = core.config.app_data_dir.clone();
    intents::put(&dir, &unanswered_at(&rest)).unwrap();
    let (link, mut sent) = NodeLink::detached(node());
    CoreHost(Arc::downgrade(&core))
        .connected(link.clone())
        .await;
    // Asking again with agent.register would be refused: the name is taken.
    let frame = next_frame(&mut sent).await;
    assert_eq!(frame["type"], "agent.deregister");
    assert_eq!(frame["agent_id"], "agent_w1");
    let left = intents::load(&dir);
    assert!(left[0].ended, "kept until Relaycast confirms");
    assert_eq!(left[0].agent_id.as_deref(), Some("agent_w1"));
    link.answer(
        &json!({"v": 1, "id": frame["id"], "type": "reply", "ok": true,
        "data": {"deregistered": true}}),
    );
    settled(&dir).await;
    assert!(core.store.read(|s| s.registrations.is_empty()));
}

#[tokio::test]
async fn an_agent_still_landing_when_first_asked_is_found_and_ended() {
    let home = tempfile::tempdir().unwrap();
    // The connection closed while Relaycast was still writing the agent: the
    // first lookup finds none, the one after the grace finds it.
    let rest = relaycast_rest_landing(agent_w1("agent_w1", "inv_w1"));
    let core = core_at(home.path(), Arc::new(FakeSpawner::default()), &rest);
    let dir = core.config.app_data_dir.clone();
    let intent = unanswered_at(&rest);
    intents::put(&dir, &intent).unwrap();
    let (link, mut sent) = NodeLink::detached(node());
    core.settle_unanswered(link.clone(), intent, Unanswered::Lost);
    let frame = next_frame(&mut sent).await;
    assert_eq!(frame["type"], "agent.deregister");
    assert_eq!(frame["agent_id"], "agent_w1");
    let left = intents::load(&dir);
    assert!(left[0].ended, "kept until Relaycast confirms");
    link.answer(
        &json!({"v": 1, "id": frame["id"], "type": "reply", "ok": true,
        "data": {"deregistered": true}}),
    );
    settled(&dir).await;
}

#[tokio::test]
async fn an_agent_of_the_same_name_from_another_invocation_is_left_alone() {
    let home = tempfile::tempdir().unwrap();
    let rest = relaycast_rest(agent_w1("agent_other", "inv_other"));
    let core = core_at(home.path(), Arc::new(FakeSpawner::default()), &rest);
    let dir = core.config.app_data_dir.clone();
    intents::put(&dir, &unanswered_at(&rest)).unwrap();
    let (link, mut sent) = NodeLink::detached(node());
    CoreHost(Arc::downgrade(&core))
        .connected(link.clone())
        .await;
    settled(&dir).await;
    assert!(sent.try_recv().is_err(), "nothing is deregistered");
}

#[tokio::test]
async fn a_register_answered_late_is_taken_off_the_node() {
    let home = tempfile::tempdir().unwrap();
    let core = core(home.path(), Arc::new(FakeSpawner::default()));
    let dir = core.config.app_data_dir.clone();
    let intent = unanswered_at("http://localhost:9");
    intents::put(&dir, &intent).unwrap();
    let (link, mut sent) = NodeLink::detached(node());
    // The spawn gave up waiting; the answer comes after.
    let answer = link.ask("agent_register_1", json!({"id": "agent_register_1"}));
    next_frame(&mut sent).await;
    core.settle_unanswered(
        link.clone(),
        intent,
        Unanswered::Waiting(answer.unwrap(), "agent_register_1".into()),
    );
    link.answer(
        &json!({"v": 1, "id": "agent_register_1", "type": "reply", "ok": true,
        "data": {"agent_id": "agent_w1", "name": "w1", "token": "at_live_w1"}}),
    );
    let frame = next_frame(&mut sent).await;
    assert_eq!(frame["type"], "agent.deregister");
    assert_eq!(frame["agent_id"], "agent_w1");
    let left = intents::load(&dir);
    assert!(left[0].ended, "kept until Relaycast confirms");
    link.answer(
        &json!({"v": 1, "id": frame["id"], "type": "reply", "ok": true,
        "data": {"deregistered": true}}),
    );
    settled(&dir).await;
}

#[tokio::test]
async fn a_register_answered_past_its_timeout_still_spawns_the_agent() {
    let home = tempfile::tempdir().unwrap();
    let spawner = Arc::new(FakeSpawner::default());
    let core = core(home.path(), spawner.clone());
    let (link, mut sent) = NodeLink::detached(node());
    let spawning = tokio::spawn(core.clone().answer_spawn(link.clone(), request("w1")));
    let frame = next_frame(&mut sent).await;
    assert_eq!(frame["type"], "agent.register");
    // Relaycast's node, under database pressure, answers after the
    // register's own timeout.
    tokio::time::pause();
    tokio::time::sleep(super::super::invoke::REGISTER_TIMEOUT + Duration::from_secs(5)).await;
    tokio::time::resume();
    assert!(
        !spawning.is_finished(),
        "the spawn waits for the late answer"
    );
    link.answer(
        &json!({"v": 1, "id": frame["id"], "type": "reply", "ok": true,
        "data": {"agent_id": "agent_w1", "name": "w1", "token": "at_live_w1"}}),
    );
    let saved = spawning.await.unwrap();
    let kept = named(&core, "w1");
    assert_eq!(
        saved,
        wire::action_output("inv_w1", completions::spawned_output(&kept))
    );
    assert_eq!(kept.agent_id, "agent_w1");
    assert_eq!(spawner.launched.lock().unwrap().len(), 1);
    assert!(intents::load(&core.config.app_data_dir).is_empty());
    assert!(
        std::iter::from_fn(|| sent.try_recv().ok())
            .all(|frame| frame["type"] != "agent.deregister"),
        "the agent it registered is kept"
    );
}

#[tokio::test]
async fn a_pressure_refusal_past_the_register_timeout_is_retried_and_spawns() {
    let home = tempfile::tempdir().unwrap();
    let spawner = Arc::new(FakeSpawner::default());
    let core = core(home.path(), spawner.clone());
    let (link, mut sent) = NodeLink::detached(node());
    let spawning = tokio::spawn(core.clone().answer_spawn(link.clone(), request("w1")));
    let frame = next_frame(&mut sent).await;
    assert_eq!(frame["type"], "agent.register");
    // Relaycast's node gives up on the pressured write only after the
    // register's own timeout: nothing was registered, so it is sent again.
    tokio::time::pause();
    tokio::time::sleep(super::super::invoke::REGISTER_TIMEOUT + Duration::from_secs(5)).await;
    tokio::time::resume();
    link.answer(&json!({"v": 1, "id": frame["id"], "type": "error",
        "code": "d1_pressure", "message": "agent.register was not applied under database pressure"}));
    let again = next_frame(&mut sent).await;
    assert_eq!(again, frame, "the same register, sent again");
    link.answer(
        &json!({"v": 1, "id": frame["id"], "type": "reply", "ok": true,
        "data": {"agent_id": "agent_w1", "name": "w1", "token": "at_live_w1"}}),
    );
    let saved = spawning.await.unwrap();
    let kept = named(&core, "w1");
    assert_eq!(
        saved,
        wire::action_output("inv_w1", completions::spawned_output(&kept))
    );
    assert_eq!(spawner.launched.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn a_retry_meeting_its_own_lost_agent_frees_the_name_and_registers() {
    let home = tempfile::tempdir().unwrap();
    let spawner = Arc::new(FakeSpawner::default());
    // The first attempt's agent, whose answer was lost, holds the name.
    let rest = relaycast_rest(agent_w1("agent_lost", "inv_w1"));
    let core = core_at(home.path(), spawner.clone(), &rest);
    let (link, mut sent) = NodeLink::detached(node());
    let spawning = tokio::spawn(core.clone().answer_spawn(link.clone(), request("w1")));
    let frame = next_frame(&mut sent).await;
    assert_eq!(frame["type"], "agent.register");
    link.answer(
        &json!({"v": 1, "id": frame["id"], "type": "error", "ok": false,
        "code": "agent_already_exists", "message": "Agent \"w1\" already exists"}),
    );
    let frame = next_frame(&mut sent).await;
    assert_eq!(frame["type"], "agent.deregister");
    assert_eq!(frame["agent_id"], "agent_lost");
    link.answer(
        &json!({"v": 1, "id": frame["id"], "type": "reply", "ok": true,
        "data": {"deregistered": true}}),
    );
    let frame = next_frame(&mut sent).await;
    assert_eq!(frame["type"], "agent.register");
    link.answer(
        &json!({"v": 1, "id": frame["id"], "type": "reply", "ok": true,
        "data": {"agent_id": "agent_w1", "name": "w1", "token": "at_live_w1"}}),
    );
    let saved = spawning.await.unwrap();
    let kept = named(&core, "w1");
    assert_eq!(
        saved,
        wire::action_output("inv_w1", completions::spawned_output(&kept))
    );
    assert_eq!(kept.agent_id, "agent_w1");
    assert_eq!(spawner.launched.lock().unwrap().len(), 1);
    assert!(intents::load(&core.config.app_data_dir).is_empty());
}

#[tokio::test]
async fn a_name_another_invocation_holds_is_refused_without_freeing_it() {
    let home = tempfile::tempdir().unwrap();
    let rest = relaycast_rest(agent_w1("agent_other", "inv_other"));
    let core = core_at(home.path(), Arc::new(FakeSpawner::default()), &rest);
    let (link, mut sent) = NodeLink::detached(node());
    let spawning = tokio::spawn(core.clone().answer_spawn(link.clone(), request("w1")));
    let frame = next_frame(&mut sent).await;
    link.answer(
        &json!({"v": 1, "id": frame["id"], "type": "error", "ok": false,
        "code": "agent_already_exists", "message": "Agent \"w1\" already exists"}),
    );
    let result = spawning.await.unwrap();
    assert!(result["error"]
        .as_str()
        .unwrap()
        .starts_with("spawn_agent_name_in_use"));
    assert!(sent.try_recv().is_err(), "nothing is deregistered");
    assert!(intents::load(&core.config.app_data_dir).is_empty());
}

#[tokio::test]
async fn settling_an_earlier_attempt_never_erases_a_retrys_intent() {
    let home = tempfile::tempdir().unwrap();
    let core = core(home.path(), Arc::new(FakeSpawner::default()));
    let dir = core.config.app_data_dir.clone();
    let earlier = unanswered_at(&relaycast_rest(agent_w1("agent_w1", "inv_w1")));
    // Relaycast retried the invocation, which wrote its own intent.
    let mut retry = earlier.clone();
    retry.session_id = "retry-session".into();
    intents::put(&dir, &retry).unwrap();
    let (link, mut sent) = NodeLink::detached(node());
    core.settle_unanswered(link, earlier, Unanswered::Lost);
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(intents::load(&dir), [retry]);
    assert!(sent.try_recv().is_err(), "nothing is deregistered");
}

#[tokio::test]
async fn settling_an_earlier_attempt_never_ends_a_saved_retrys_agent() {
    let home = tempfile::tempdir().unwrap();
    let core = core(home.path(), Arc::new(FakeSpawner::default()));
    let dir = core.config.app_data_dir.clone();
    // The retry registered and saved its own agent, stamped with the same
    // invocation, after the earlier attempt's register went unanswered.
    spawn(&core, "w1").await;
    let earlier = unanswered_at(&relaycast_rest(agent_w1("agent_w1", "inv_w1")));
    intents::put(&dir, &earlier).unwrap();
    let (link, mut sent) = NodeLink::detached(node());
    core.settle_unanswered(link, earlier, Unanswered::Lost);
    settled(&dir).await;
    assert!(
        sent.try_recv().is_err(),
        "the retry's agent stays on the node"
    );
    assert_eq!(named(&core, "w1").agent_id, "agent_w1");
}

#[tokio::test]
async fn a_recovery_while_the_spawn_still_settles_leaves_it_to_that_settler() {
    let home = tempfile::tempdir().unwrap();
    let core = core(home.path(), Arc::new(FakeSpawner::default()));
    let dir = core.config.app_data_dir.clone();
    // Relaycast's lookup misses the agent (another invocation holds the
    // name there), while the spawn's own register answer is still coming.
    let intent = unanswered_at(&relaycast_rest(agent_w1("agent_other", "inv_other")));
    intents::put(&dir, &intent).unwrap();
    let (link, mut sent) = NodeLink::detached(node());
    let answer = link.ask("agent_register_1", json!({"id": "agent_register_1"}));
    next_frame(&mut sent).await;
    core.settle_unanswered(
        link.clone(),
        intent.clone(),
        Unanswered::Waiting(answer.unwrap(), "agent_register_1".into()),
    );
    // A reconnect's recovery settles the same attempt: it is skipped.
    core.settle_unanswered(link.clone(), intent, Unanswered::Lost);
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(intents::load(&dir).len(), 1, "the intent is not removed");
    link.answer(
        &json!({"v": 1, "id": "agent_register_1", "type": "reply", "ok": true,
        "data": {"agent_id": "agent_w1", "name": "w1", "token": "at_live_w1"}}),
    );
    let frame = next_frame(&mut sent).await;
    assert_eq!(frame["type"], "agent.deregister");
    assert_eq!(frame["agent_id"], "agent_w1");
    link.answer(
        &json!({"v": 1, "id": frame["id"], "type": "reply", "ok": true,
        "data": {"deregistered": true}}),
    );
    settled(&dir).await;
    assert!(core.ledger().lock().settling.is_empty());
}

#[tokio::test]
async fn an_agent_found_after_its_intent_went_is_still_taken_off_the_node() {
    let home = tempfile::tempdir().unwrap();
    let core = core(home.path(), Arc::new(FakeSpawner::default()));
    let dir = core.config.app_data_dir.clone();
    // Its record is gone, yet Relaycast holds its agent.
    let intent = unanswered_at(&relaycast_rest(agent_w1("agent_w1", "inv_w1")));
    let (link, mut sent) = NodeLink::detached(node());
    core.settle_unanswered(link.clone(), intent, Unanswered::Lost);
    let frame = next_frame(&mut sent).await;
    assert_eq!(frame["type"], "agent.deregister");
    assert_eq!(frame["agent_id"], "agent_w1");
    let left = intents::load(&dir);
    assert!(left[0].ended, "recorded again until Relaycast confirms");
    assert_eq!(left[0].agent_id.as_deref(), Some("agent_w1"));
    link.answer(
        &json!({"v": 1, "id": frame["id"], "type": "reply", "ok": true,
        "data": {"deregistered": true}}),
    );
    settled(&dir).await;
}
