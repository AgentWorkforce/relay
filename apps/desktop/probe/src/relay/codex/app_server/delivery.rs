//! Loaded-thread delivery and resuming registered native spawns.

use super::*;

/// Starts a turn with `text` in `thread` when the app-server has it loaded:
/// `Ok(false)` when it does not (or cannot say) before anything reached the
/// thread; after that, anything but a confirmed turn is an error.
pub fn send_if_loaded(
    stream: &mut dyn ProxyStream,
    thread: &str,
    text: &str,
    message_id: &str,
    hide: Hide,
    timeout: Duration,
) -> Result<bool, TurnError> {
    send(stream, thread, text, message_id, (hide, false), timeout)
}

/// Delivers to a registered native spawn, resuming its exact thread when
/// Codex unloaded it after being idle. The caller must verify that the
/// registration is still a native spawn and the thread is not archived.
pub fn send_to_spawned(
    stream: &mut dyn ProxyStream,
    thread: &str,
    text: &str,
    message_id: &str,
    hide: Hide,
    timeout: Duration,
) -> Result<bool, TurnError> {
    send(stream, thread, text, message_id, (hide, true), timeout)
}

/// A desktop-driven spawned turn of the thread `claim` holds: as
/// `send_to_spawned`, but the app-server connection is kept open through
/// the turn so its approval requests can be answered (`drive`).
pub fn send_spawned(
    mut stream: Box<dyn ProxyStream>,
    claim: drive::Claim,
    (text, message_id): (&str, &str),
    hide: Hide,
    timeout: Duration,
) -> Result<bool, TurnError> {
    let thread = claim.thread().to_string();
    let (result, state) = send_with_state(
        stream.as_mut(),
        &thread,
        text,
        message_id,
        (hide, true),
        timeout,
    );
    if let (Ok(true) | Err(TurnError::InDoubt(_)), Some(state)) = (&result, state) {
        drive::start(stream, state, claim);
    }
    result
}

fn send(
    stream: &mut dyn ProxyStream,
    thread: &str,
    text: &str,
    message_id: &str,
    flags: (Hide, bool),
    timeout: Duration,
) -> Result<bool, TurnError> {
    send_with_state(stream, thread, text, message_id, flags, timeout).0
}

/// As `send`, with the connection's state once a turn was asked for.
fn send_with_state(
    stream: &mut dyn ProxyStream,
    thread: &str,
    text: &str,
    message_id: &str,
    (hide, resume): (Hide, bool),
    timeout: Duration,
) -> (Result<bool, TurnError>, Option<ClientState>) {
    let deadline = Instant::now() + timeout;
    let Ok(mut client) = Client::open(stream, deadline) else {
        return (Ok(false), None);
    };
    // Thread ids are UUIDs, compared without case; the turn names the
    // thread as the host listed it.
    let hosted = match client.loaded(deadline) {
        Ok(loaded) => loaded
            .into_iter()
            .find(|id| id.eq_ignore_ascii_case(thread)),
        Err(_) => return (Ok(false), None),
    };
    let hosted = match hosted {
        Some(hosted) => Ok(Some(hosted)),
        None if resume => resume_spawned(&mut client, thread, deadline),
        None => Ok(None),
    };
    let thread = match hosted {
        Ok(Some(thread)) => thread,
        Ok(None) => return (Ok(false), None),
        Err(error) => return (Err(error), None),
    };
    let compact = hide != Hide::Never;
    let Some((input, injected)) = turn_input(&mut client, &thread, text, message_id, compact)
    else {
        return (Ok(false), None);
    };
    if hide == Hide::Only && !injected {
        return (Ok(false), None);
    }
    let result = start_turn(&mut client, &thread, input, injected, message_id, timeout);
    (result, Some(client.into_state()))
}

/// A resume alone starts no turn. Ask Codex to restore the thread by ID,
/// without supplying new directory, model, approval or sandbox overrides.
/// `excludeTurns` (a stable field) keeps the reply to metadata: a long
/// thread's full history could otherwise exceed the 16 MiB frame limit.
fn resume_spawned(
    client: &mut Client,
    thread: &str,
    deadline: Instant,
) -> Result<Option<String>, TurnError> {
    let resume = json!({"method": "thread/resume", "id": RESUME_ID,
        "params": {"threadId": thread, "excludeTurns": true}});
    if client.send(&resume, deadline).is_err() {
        return Ok(None);
    }
    let Ok(response) = client.response(RESUME_ID, deadline) else {
        return Ok(None);
    };
    if let Some(error) = response.get("error").filter(|error| !error.is_null()) {
        return Err(TurnError::Refused(refusal(
            error,
            "Codex refused to resume the spawned thread",
        )));
    }
    Ok(response["result"]["thread"]["id"]
        .as_str()
        .filter(|id| id.eq_ignore_ascii_case(thread))
        .map(str::to_string))
}
