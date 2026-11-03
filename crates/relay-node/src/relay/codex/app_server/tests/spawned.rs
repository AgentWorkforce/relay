use super::*;

const THREAD: &str = "01a0f207-6743-7f12-ac70-f791c2c01c64";

#[test]
fn spawned_resume_must_confirm_the_exact_thread_before_starting_a_turn() {
    for answer in [
        None,
        Some(json!({"result": {}})),
        Some(json!({"result": {"thread": {"id": "another-thread"}}})),
        Some(json!({"error": {"message": "thread not found"}})),
    ] {
        let mut server = FakeAppServer::new(move |r| match r["method"].as_str() {
            Some("thread/loaded/list") => Some(server_frame(
                &json!({"id": r["id"], "result": {"data": []}}),
            )),
            Some("thread/resume") => answer.clone().map(|mut a| {
                a["id"] = r["id"].clone();
                server_frame(&a)
            }),
            _ => None,
        });
        assert_ne!(
            send_to_spawned(&mut server, THREAD, "hello", "m", Hide::Never, SEND_TIMEOUT),
            Ok(true)
        );
        assert!(!server
            .seen
            .lock()
            .unwrap()
            .iter()
            .any(|r| r["method"] == "turn/start"));
    }
}

// The Codex hidden turn: a follow-up from the agent that started the spawn
// goes into the history under the owner's note, anyone else's under the
// peer's.
#[test]
fn a_spawned_follow_up_is_hidden_under_the_note_for_its_framing() {
    use crate::relay::codex::compact::{OWNER_NOTE, PEER_AUTHORITY_NOTE, PEER_NOTE};
    let owner = crate::relay::delivery::policy::with_owner_line(RELAYED);
    let peer = format!("{PEER_NOTE}\n{PEER_AUTHORITY_NOTE}");
    // Each its own message: a message already injected is not injected again.
    for (text, note, message_id) in [
        (owner.as_str(), OWNER_NOTE, "spawned-owner-1"),
        (RELAYED, peer.as_str(), "spawned-peer-1"),
    ] {
        let mut server = injecting(Some(json!({"id": 4, "result": {}})));
        let seen = server.seen.clone();
        assert_eq!(
            send_to_spawned(
                &mut server,
                super::THREAD,
                text,
                message_id,
                Hide::IfAble,
                SEND_TIMEOUT
            ),
            Ok(true)
        );
        let inject = seen
            .lock()
            .unwrap()
            .iter()
            .find(|r| r["method"] == "thread/inject_items")
            .cloned()
            .unwrap();
        assert_eq!(inject["params"]["items"][0]["content"][0]["text"], note);
        assert_eq!(inject["params"]["items"][1]["content"][0]["text"], text);
    }
}

#[test]
fn a_loaded_spawn_needs_no_resume_and_an_unreadable_list_cannot_authorize_one() {
    let mut loaded = FakeAppServer::hosting(
        &[THREAD],
        Some(json!({"id": TURN_ID, "result": {"turn": {"id": "t"}}})),
    );
    assert_eq!(
        send_to_spawned(&mut loaded, THREAD, "hello", "m", Hide::Never, SEND_TIMEOUT),
        Ok(true)
    );
    assert!(!loaded
        .seen
        .lock()
        .unwrap()
        .iter()
        .any(|r| r["method"] == "thread/resume"));
    let mut unknown = FakeAppServer::new(|_| None);
    assert_eq!(
        send_to_spawned(
            &mut unknown,
            THREAD,
            "hello",
            "m",
            Hide::Never,
            SEND_TIMEOUT
        ),
        Ok(false)
    );
    assert!(!unknown
        .seen
        .lock()
        .unwrap()
        .iter()
        .any(|r| r["method"] == "thread/resume"));
}
