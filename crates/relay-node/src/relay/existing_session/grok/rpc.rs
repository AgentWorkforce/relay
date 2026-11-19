//! The JSON-RPC lines a `LeaderClient` writes to its leader, and how it
//! waits for the answers.

use super::Event;
use serde_json::{json, Value};
use std::io::Write;
use std::sync::mpsc;
use std::time::Instant;

pub(super) fn request_id() -> Option<String> {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).ok()?;
    Some(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

pub(super) fn write_request(stdin: &mut impl Write, id: &str, method: &str, params: Value) -> bool {
    let request = json!({"jsonrpc":"2.0","id":id,"method":method,"params":params});
    serde_json::to_writer(&mut *stdin, &request).is_ok()
        && stdin.write_all(b"\n").is_ok()
        && stdin.flush().is_ok()
}

pub(super) fn recv_event(receiver: &mpsc::Receiver<Event>, deadline: Instant) -> Option<Event> {
    loop {
        let left = deadline.checked_duration_since(Instant::now())?;
        match receiver.recv_timeout(left).ok()? {
            Event::Ignored | Event::Other => continue,
            event => return Some(event),
        }
    }
}

pub(super) fn response(
    receiver: &mpsc::Receiver<Event>,
    deadline: Instant,
    expected: &str,
) -> Option<Result<Value, Option<i64>>> {
    loop {
        match recv_event(receiver, deadline)? {
            Event::Response {
                id,
                result,
                error,
                code,
            } if id == expected => {
                return Some(if error { Err(code) } else { result.ok_or(None) });
            }
            _ => continue,
        }
    }
}
