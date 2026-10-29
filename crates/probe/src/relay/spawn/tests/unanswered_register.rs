//! Spawns whose `agent.register` went unanswered, and retries that meet
//! the agent such a spawn left holding its name.

use super::super::unanswered::Unanswered;
use super::*;

/// Relaycast's REST API answering `GET /v1/agents/{name}` with `agent`,
/// and anything else with 404.
fn relaycast_rest(agent: Value) -> String {
    relaycast_rest_holding(Arc::new(Mutex::new(Some(agent))))
}

/// Relaycast's REST API answering `GET /v1/agents/{name}` with the agent
/// `holding` has at the time (404 with none), and anything else with 404.
fn relaycast_rest_holding(holding: Arc<Mutex<Option<Value>>>) -> String {
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
            let agent = holding.lock().unwrap().clone();
            let (status, body) = match agent {
                Some(agent) if String::from_utf8_lossy(&request).starts_with("GET /v1/agents/") => {
                    ("200 OK", json!({"ok": true, "data": agent}))
                }
                _ => (
                    "404 Not Found",
                    json!({"ok": false, "error": {"code": "not_found", "message": "not here"}}),
                ),
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
async fn a_retry_meeting_its_own_lost_agent_takes_it_over() {
    let home = tempfile::tempdir().unwrap();
    let spawner = Arc::new(FakeSpawner::default());
    // The first attempt's agent, whose answer was lost, holds the name.
    let rest = relaycast_rest(agent_w1("agent_lost", "inv_w1"));
    let core = core_at(home.path(), spawner.clone(), &rest);
    let (link, mut sent) = NodeLink::detached(node());
    let spawning = tokio::spawn(core.clone().answer_spawn(link.clone(), request("w1")));
    let frame = next_frame(&mut sent).await;
    assert_eq!(frame["type"], "agent.register");
    link.answer(&name_taken(&frame));
    // Taking it off the node would not free the name: it is taken over.
    let frame = next_frame(&mut sent).await;
    assert_eq!(frame["type"], "agent.recover");
    assert_eq!(frame["expected_agent_id"], "agent_lost");
    assert_eq!(frame["invocation_id"], "inv_w1");
    link.answer(&registered_as(&frame, "agent_lost"));
    let saved = spawning.await.unwrap();
    let kept = named(&core, "w1");
    assert_eq!(
        saved,
        wire::action_output("inv_w1", completions::spawned_output(&kept))
    );
    assert_eq!(kept.agent_id, "agent_lost");
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

/// Relaycast's refusal of a register for a name an agent holds.
fn name_taken(frame: &Value) -> Value {
    json!({"v": 1, "id": frame["id"], "type": "error", "ok": false,
        "code": "agent_already_exists",
        "message": "Agent \"w1\" already exists; use agent.recover with proof of the immutable id"})
}

/// Relaycast's answer to a register or takeover: `agent_id`, with a token.
fn registered_as(frame: &Value, agent_id: &str) -> Value {
    json!({"v": 1, "id": frame["id"], "type": "reply", "ok": true,
        "data": {"agent_id": agent_id, "name": "w1", "token": "at_live_w1"}})
}

/// The next frame sent, waiting as long as a register's answer is.
async fn frame_within(sent: &mut tokio::sync::mpsc::UnboundedReceiver<Value>, wait: u64) -> Value {
    tokio::time::timeout(Duration::from_secs(wait), sent.recv())
        .await
        .expect("a frame in time")
        .expect("the link is open")
}

#[tokio::test]
async fn a_register_relaycast_made_without_answering_is_taken_over() {
    let home = tempfile::tempdir().unwrap();
    let spawner = Arc::new(FakeSpawner::default());
    // Relaycast registered the agent, stamped with the invocation; its
    // answer never comes.
    let rest = relaycast_rest(agent_w1("agent_w1", "inv_w1"));
    let core = core_at(home.path(), spawner.clone(), &rest);
    let (link, mut sent) = NodeLink::detached(node());
    let spawning = tokio::spawn(core.clone().answer_spawn(link.clone(), request("w1")));
    let register = next_frame(&mut sent).await;
    assert_eq!(register["type"], "agent.register");
    let frame = frame_within(&mut sent, 60).await;
    assert_eq!(frame["type"], "agent.recover", "found by its invocation");
    assert_eq!(frame["expected_agent_id"], "agent_w1");
    link.answer(&registered_as(&frame, "agent_w1"));
    let result = spawning.await.unwrap();
    assert!(result["error"].is_null(), "spawned: {result}");
    assert_eq!(named(&core, "w1").agent_id, "agent_w1");
    assert_eq!(spawner.launched.lock().unwrap().len(), 1);
    // The register's own answer is no longer waited for.
    assert!(!link.answer(&registered_as(&register, "agent_w1")));
    assert!(intents::load(&core.config.app_data_dir).is_empty());
}

#[tokio::test]
async fn an_unanswered_register_says_relaycast_did_not_answer_and_that_a_retry_is_safe() {
    let home = tempfile::tempdir().unwrap();
    let rest = relaycast_rest_holding(Arc::default());
    let core = core_at(home.path(), Arc::new(FakeSpawner::default()), &rest);
    let (link, mut sent) = NodeLink::detached(node());
    let spawning = tokio::spawn(core.clone().answer_spawn(link, request("w1")));
    assert_eq!(next_frame(&mut sent).await["type"], "agent.register");
    let result = tokio::time::timeout(Duration::from_secs(60), spawning)
        .await
        .expect("the spawn gives up")
        .unwrap();
    let error = result["error"].as_str().unwrap();
    assert!(
        error.starts_with("spawn_failed: Relaycast did not answer the request to register the agent"),
        "{error}"
    );
    assert!(error.contains("retrying the spawn with the same name is safe"), "{error}");
    assert!(!error.contains("did not register the agent in time"), "{error}");
}

#[tokio::test]
async fn a_register_completing_after_its_spawn_failed_leaves_the_name_to_a_retry() {
    let home = tempfile::tempdir().unwrap();
    let spawner = Arc::new(FakeSpawner::default());
    // Relaycast has not registered it yet when the spawn gives up.
    let holding = Arc::new(Mutex::new(None));
    let rest = relaycast_rest_holding(holding.clone());
    let core = core_at(home.path(), spawner.clone(), &rest);
    let dir = core.config.app_data_dir.clone();
    let (link, mut sent) = NodeLink::detached(node());
    let spawning = tokio::spawn(core.clone().answer_spawn(link.clone(), request("w1")));
    let register = next_frame(&mut sent).await;
    let failed = tokio::time::timeout(Duration::from_secs(60), spawning)
        .await
        .expect("the spawn gives up")
        .unwrap();
    assert!(failed["error"].as_str().unwrap().starts_with("spawn_failed: "));
    // Then Relaycast registers it and answers.
    *holding.lock().unwrap() = Some(agent_w1("agent_w1", "inv_w1"));
    link.answer(&registered_as(&register, "agent_w1"));
    let frame = next_frame(&mut sent).await;
    assert_eq!(frame["type"], "agent.deregister", "not left on the node");
    assert_eq!(frame["agent_id"], "agent_w1");
    link.answer(
        &json!({"v": 1, "id": frame["id"], "type": "reply", "ok": true,
        "data": {"deregistered": true}}),
    );
    settled(&dir).await;
    // Off the node, it still holds the name: a retry of the name, as a new
    // invocation, takes it over.
    let mut retry = request("w1");
    retry.invocation_id = "inv_w1_retry".into();
    let spawning = tokio::spawn(core.clone().answer_spawn(link.clone(), retry));
    let frame = next_frame(&mut sent).await;
    assert_eq!(frame["type"], "agent.register");
    link.answer(&name_taken(&frame));
    let frame = next_frame(&mut sent).await;
    assert_eq!(frame["type"], "agent.recover");
    assert_eq!(frame["expected_agent_id"], "agent_w1");
    assert_eq!(frame["invocation_id"], "inv_w1_retry");
    link.answer(&registered_as(&frame, "agent_w1"));
    let result = spawning.await.unwrap();
    assert!(result["error"].is_null(), "spawned: {result}");
    let kept = named(&core, "w1");
    assert_eq!(kept.agent_id, "agent_w1");
    assert_eq!(kept.spawn.unwrap().invocation_id, "inv_w1_retry");
    assert_eq!(spawner.launched.lock().unwrap().len(), 1);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(sent.try_recv().is_err(), "the agent stays on the node");
    assert!(intents::load(&dir).is_empty());
}

#[tokio::test]
async fn an_agent_still_being_taken_off_the_node_is_not_taken_over() {
    let home = tempfile::tempdir().unwrap();
    let spawner = Arc::new(FakeSpawner::default());
    let holding = Arc::new(Mutex::new(None));
    let rest = relaycast_rest_holding(holding.clone());
    let core = core_at(home.path(), spawner.clone(), &rest);
    let dir = core.config.app_data_dir.clone();
    let (link, mut sent) = NodeLink::detached(node());
    let spawning = tokio::spawn(core.clone().answer_spawn(link.clone(), request("w1")));
    let register = next_frame(&mut sent).await;
    let failed = tokio::time::timeout(Duration::from_secs(60), spawning)
        .await
        .expect("the spawn gives up")
        .unwrap();
    assert!(failed["error"].as_str().unwrap().starts_with("spawn_failed: "));
    *holding.lock().unwrap() = Some(agent_w1("agent_w1", "inv_w1"));
    link.answer(&registered_as(&register, "agent_w1"));
    let deregister = next_frame(&mut sent).await;
    assert_eq!(deregister["type"], "agent.deregister");
    // Relaycast has not answered the deregistration: it may land after a
    // takeover, so a retry leaves the agent alone.
    let mut retry = request("w1");
    retry.invocation_id = "inv_w1_retry".into();
    let spawning = tokio::spawn(core.clone().answer_spawn(link.clone(), retry.clone()));
    let frame = next_frame(&mut sent).await;
    assert_eq!(frame["type"], "agent.register");
    link.answer(&name_taken(&frame));
    let result = spawning.await.unwrap();
    assert!(
        result["error"].as_str().unwrap().starts_with("spawn_agent_name_in_use"),
        "{result}"
    );
    assert!(sent.try_recv().is_err(), "no takeover");
    // Once Relaycast confirms it, even past the deregistration's own
    // timeout, a retry takes the agent over.
    tokio::time::sleep(Duration::from_secs(11)).await;
    link.answer(
        &json!({"v": 1, "id": deregister["id"], "type": "reply", "ok": true,
        "data": {"deregistered": true}}),
    );
    settled(&dir).await;
    retry.invocation_id = "inv_w1_retry_2".into();
    let spawning = tokio::spawn(core.clone().answer_spawn(link.clone(), retry));
    let frame = next_frame(&mut sent).await;
    assert_eq!(frame["type"], "agent.register");
    link.answer(&name_taken(&frame));
    let frame = next_frame(&mut sent).await;
    assert_eq!(frame["type"], "agent.recover");
    assert_eq!(frame["expected_agent_id"], "agent_w1");
    link.answer(&registered_as(&frame, "agent_w1"));
    let result = spawning.await.unwrap();
    assert!(result["error"].is_null(), "spawned: {result}");
    assert_eq!(spawner.launched.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn a_takeover_refused_after_the_lookup_still_takes_the_agent_off_the_node() {
    let home = tempfile::tempdir().unwrap();
    let rest = relaycast_rest(agent_w1("agent_w1", "inv_w1"));
    let core = core_at(home.path(), Arc::new(FakeSpawner::default()), &rest);
    let dir = core.config.app_data_dir.clone();
    let (link, mut sent) = NodeLink::detached(node());
    let spawning = tokio::spawn(core.clone().answer_spawn(link.clone(), request("w1")));
    assert_eq!(next_frame(&mut sent).await["type"], "agent.register");
    let frame = frame_within(&mut sent, 60).await;
    assert_eq!(frame["type"], "agent.recover");
    link.answer(&json!({"v": 1, "id": frame["id"], "type": "error", "ok": false,
        "code": "agent_recovery_not_authorized", "message": "not this node's"}));
    let result = spawning.await.unwrap();
    assert!(result["error"].as_str().unwrap().starts_with("spawn_failed: "));
    // The agent Relaycast registered for the spawn is not left behind.
    let frame = next_frame(&mut sent).await;
    assert_eq!(frame["type"], "agent.deregister");
    assert_eq!(frame["agent_id"], "agent_w1");
    link.answer(
        &json!({"v": 1, "id": frame["id"], "type": "reply", "ok": true,
        "data": {"deregistered": true}}),
    );
    settled(&dir).await;
}

#[tokio::test]
async fn only_another_invocations_takeover_keeps_a_settler_from_the_agent() {
    let home = tempfile::tempdir().unwrap();
    let core = core(home.path(), Arc::new(FakeSpawner::default()));
    let ledger = core.ledger();
    // An earlier spawn took the agent over, then a later one did.
    ledger
        .lock()
        .adopted
        .insert("agent_w1".into(), "inv_later".into());
    assert!(
        !core.claim_deregister("agent_w1", "inv_earlier"),
        "the later spawn's agent is left alone"
    );
    assert!(
        core.claim_deregister("agent_w1", "inv_later"),
        "the later spawn's own settler still takes it off"
    );
    assert_eq!(ledger.lock().deregistering.get("agent_w1"), Some(&1));
}

#[tokio::test]
async fn an_unanswered_takeover_of_an_earlier_spawns_agent_still_takes_it_off_the_node() {
    let home = tempfile::tempdir().unwrap();
    let holding = Arc::new(Mutex::new(None));
    let rest = relaycast_rest_holding(holding.clone());
    let core = core_at(home.path(), Arc::new(FakeSpawner::default()), &rest);
    let dir = core.config.app_data_dir.clone();
    let (link, mut sent) = NodeLink::detached(node());
    // The first spawn gives up; Relaycast registers its agent afterwards.
    let spawning = tokio::spawn(core.clone().answer_spawn(link.clone(), request("w1")));
    let register = next_frame(&mut sent).await;
    let failed = tokio::time::timeout(Duration::from_secs(60), spawning)
        .await
        .expect("the spawn gives up")
        .unwrap();
    assert!(failed["error"].as_str().unwrap().starts_with("spawn_failed: "));
    *holding.lock().unwrap() = Some(agent_w1("agent_w1", "inv_w1"));
    link.answer(&registered_as(&register, "agent_w1"));
    let frame = next_frame(&mut sent).await;
    assert_eq!(frame["type"], "agent.deregister");
    link.answer(
        &json!({"v": 1, "id": frame["id"], "type": "reply", "ok": true,
        "data": {"deregistered": true}}),
    );
    settled(&dir).await;
    // A retry's takeover of it is never answered.
    let mut retry = request("w1");
    retry.invocation_id = "inv_w1_retry".into();
    let spawning = tokio::spawn(core.clone().answer_spawn(link.clone(), retry));
    let frame = next_frame(&mut sent).await;
    link.answer(&name_taken(&frame));
    assert_eq!(next_frame(&mut sent).await["type"], "agent.recover");
    let failed = tokio::time::timeout(Duration::from_secs(60), spawning)
        .await
        .expect("the retry gives up")
        .unwrap();
    assert!(failed["error"].as_str().unwrap().starts_with("spawn_failed: "));
    // Relaycast may never apply it: the agent is taken off by its id.
    let frame = next_frame(&mut sent).await;
    assert_eq!(frame["type"], "agent.deregister");
    assert_eq!(frame["agent_id"], "agent_w1");
}

#[tokio::test]
async fn a_failed_spawns_cleanup_claims_its_agent_as_it_leaves_failed() {
    let home = tempfile::tempdir().unwrap();
    let core = core(home.path(), Arc::new(FakeSpawner::default()));
    let intent = interrupted("w1", true, None);
    let agent_id = intent.agent_id.clone().unwrap();
    let (link, _sent) = NodeLink::detached(node());
    core.defer_failed_cleanup(&link, &intent);
    core.failed_spawn_result_sent(&intent.invocation_id);
    // No moment where it is in neither, which a same-name retry could take
    // over before the cleanup takes it off the node.
    let ledger = core.ledger();
    let state = ledger.lock();
    assert!(!state.failed.contains_key(&intent.invocation_id));
    assert!(state.deregistering.contains_key(&agent_id));
}
