//! Recover a silent turn without starting an unguarded competing turn.

use super::*;

const STEER_ID: i64 = 40;
const INTERRUPT_ID: i64 = 41;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Recovery {
    Steered,
    Interrupted,
    Unavailable,
    Unsupported,
}

/// The caller has verified a silent active turn with waiting relay input.
/// `interrupt` is authority from a current, untaken-over spawn registration,
/// and only after the longer threshold. An explicit method-not-found is the
/// only response that permits falling back from steer to interrupt. `steer`
/// is `None` while relay messages are hidden: steered input shows in the chat,
/// so the message stays queued and only an authorized interrupt is tried.
pub fn recover(
    stream: &mut dyn ProxyStream,
    thread: &str,
    turn: &str,
    steer: Option<&str>,
    message_id: &str,
    interrupt: bool,
    timeout: Duration,
) -> Result<Recovery, TurnError> {
    if steer.is_none() && !interrupt {
        return Ok(Recovery::Unsupported);
    }
    let deadline = Instant::now() + timeout;
    let Ok(mut client) = Client::open(stream, deadline) else {
        return Ok(Recovery::Unavailable);
    };
    let Ok(loaded) = client.loaded(deadline) else {
        return Ok(Recovery::Unavailable);
    };
    let Some(thread) = loaded.iter().find(|id| id.eq_ignore_ascii_case(thread)) else {
        return Ok(Recovery::Unavailable);
    };
    if let Some(text) = steer {
        if let Some(recovered) = steer_turn(&mut client, thread, turn, text, message_id, deadline)? {
            return Ok(recovered);
        }
    }
    if !interrupt {
        return Ok(Recovery::Unsupported);
    }
    let request = json!({"id": INTERRUPT_ID, "method": "turn/interrupt",
        "params": {"threadId": thread, "turnId": turn}});
    // No input was accepted. Whether interrupt succeeded or timed out, wait
    // for the rollout to confirm idle before ordinary delivery starts again.
    if client.send(&request, deadline).is_err() {
        return Ok(Recovery::Interrupted);
    }
    let response = client.response(INTERRUPT_ID, deadline);
    match response {
        Ok(response) if response["error"].is_object() => Ok(Recovery::Unavailable),
        _ => Ok(Recovery::Interrupted),
    }
}

/// `None` when the app-server has no steering, so interrupt may follow.
fn steer_turn(
    client: &mut Client<'_>,
    thread: &str,
    turn: &str,
    text: &str,
    message_id: &str,
    deadline: Instant,
) -> Result<Option<Recovery>, TurnError> {
    let request = json!({"id": STEER_ID, "method": "turn/steer", "params": {
        "threadId": thread, "expectedTurnId": turn,
        "clientUserMessageId": message_id,
        "input": [{"type": "text", "text": text}]
    }});
    // Even a lost response may mean Codex accepted the input. Never issue a
    // second delivery or an interrupt after an ambiguous steer.
    client.send(&request, deadline).map_err(|_| {
        TurnError::InDoubt(
            "Codex steering could not be confirmed; the message will not be resent".into(),
        )
    })?;
    let response = client.response(STEER_ID, deadline).map_err(|_| {
        TurnError::InDoubt("Codex steering did not answer; the message will not be resent".into())
    })?;
    if response["result"]["turnId"].as_str() == Some(turn) {
        return Ok(Some(Recovery::Steered));
    }
    let error = &response["error"];
    if error["code"].as_i64() == Some(-32601) {
        return Ok(None);
    }
    if error.is_object() {
        // A changed/completed turn is normal: observe it again on the
        // next delivery pass. Do not repeat a refused message elsewhere.
        Ok(Some(Recovery::Unavailable))
    } else {
        Err(TurnError::InDoubt(
            "Codex returned an unrecognized steering response".into(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::{server_frame, FakeAppServer};
    use super::*;

    fn server(steer: Option<Value>) -> FakeAppServer {
        FakeAppServer::new(move |r| {
            let response = match r["method"].as_str()? {
                "thread/loaded/list" => json!({"result": {"data": ["thread"], "nextCursor": null}}),
                "turn/steer" => steer.clone()?,
                "turn/interrupt" => json!({"result": {}}),
                _ => return None,
            };
            let mut response = response;
            response["id"] = r["id"].clone();
            Some(server_frame(&response))
        })
    }

    #[test]
    fn steer_uses_expected_turn_and_message_id_without_interrupting() {
        let mut server = server(Some(json!({"result": {"turnId": "turn"}})));
        assert_eq!(
            recover(
                &mut server,
                "thread",
                "turn",
                Some("hello"),
                "message",
                true,
                SEND_TIMEOUT
            ),
            Ok(Recovery::Steered)
        );
        let seen = server.seen.lock().unwrap();
        let steer = seen.iter().find(|r| r["method"] == "turn/steer").unwrap();
        assert_eq!(steer["params"]["expectedTurnId"], "turn");
        assert_eq!(steer["params"]["clientUserMessageId"], "message");
        assert!(!seen
            .iter()
            .any(|r| r["method"] == "turn/interrupt" || r["method"] == "turn/start"));
    }

    #[test]
    fn only_explicitly_unsupported_steering_and_spawn_authority_allow_interrupt() {
        for authorized in [false, true] {
            for code in [-32601, -32600, -32000] {
                let mut server =
                    server(Some(json!({"error": {"code": code, "message": "refused"}})));
                let result = recover(
                    &mut server,
                    "thread",
                    "turn",
                    Some("hello"),
                    "m",
                    authorized,
                    SEND_TIMEOUT,
                )
                .unwrap();
                let interrupted = authorized && code == -32601;
                assert_eq!(result == Recovery::Interrupted, interrupted);
                let seen = server.seen.lock().unwrap();
                assert_eq!(
                    seen.iter().any(|r| r["method"] == "turn/interrupt"),
                    interrupted
                );
                assert!(!seen.iter().any(|r| r["method"] == "turn/start"));
            }
        }
    }

    #[test]
    fn ambiguous_steer_never_falls_back_or_resends() {
        let mut server = server(None);
        assert!(matches!(
            recover(
                &mut server,
                "thread",
                "turn",
                Some("hello"),
                "m",
                true,
                SEND_TIMEOUT
            ),
            Err(TurnError::InDoubt(_))
        ));
        let seen = server.seen.lock().unwrap();
        assert_eq!(
            seen.iter().filter(|r| r["method"] == "turn/steer").count(),
            1
        );
        assert!(!seen.iter().any(|r| r["method"] == "turn/interrupt"));
    }

    #[test]
    fn hidden_messages_stay_queued_and_only_authorized_interrupts_are_sent() {
        for authorized in [false, true] {
            let mut server = server(Some(json!({"result": {"turnId": "turn"}})));
            let result = recover(
                &mut server,
                "thread",
                "turn",
                None,
                "m",
                authorized,
                SEND_TIMEOUT,
            );
            let expected = if authorized {
                Recovery::Interrupted
            } else {
                Recovery::Unsupported
            };
            assert_eq!(result, Ok(expected));
            let seen = server.seen.lock().unwrap();
            assert!(!seen.iter().any(|r| r["method"] == "turn/steer"));
            assert_eq!(
                seen.iter().any(|r| r["method"] == "turn/interrupt"),
                authorized
            );
        }
    }
}
