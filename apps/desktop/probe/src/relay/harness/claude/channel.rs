//! A spawned Claude's own channel, its stream-json input and output, which
//! outlives the core: the input is the FIFO the launcher keeps at
//! `<session>.input` while Claude runs (its holder removes it when Claude
//! ends), and the output is `<session>.jsonl`. Windows has no FIFO: there
//! the input is the pipe the core that started Claude holds under that
//! name (`spawn::launch::start_with_input`), for as long as Claude runs.
//!
//! The core writes native user turns and answers to Claude's control
//! requests into the input, one whole line at a time, and reads the requests
//! from the output (`poll`). A core that starts again reads the output from
//! its start: a request Claude still waits for gets a new reference.
//!
//! A spawn started before the channel existed has no FIFO left; it keeps the
//! peer inbox route.

use super::requests;
use crate::relay::delivery::policy::MessageRef;
use serde_json::Value;
use std::collections::HashMap;
#[cfg(unix)]
use std::io::Write;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::{Duration, Instant};

/// How long a write waits for room in a full pipe before any of it is in.
const WRITE_WAIT: Duration = Duration::from_secs(5);
/// How long the rest of a line begun is waited for: one left half-written
/// would garble the next.
const FINISH_WAIT: Duration = Duration::from_secs(60);
/// How long a turn written but not yet seen starting holds later ones back.
const START_WAIT: Duration = Duration::from_secs(120);

pub fn input_path(logs: &Path, session: &str) -> PathBuf {
    logs.join(format!("{session}.input"))
}

pub fn log_path(logs: &Path, session: &str) -> PathBuf {
    logs.join(format!("{session}.jsonl"))
}

/// Whether `session` has its channel: its input pipe is there (on Windows,
/// this core holds it: `spawn::launch::holds_input`).
pub fn has_input(logs: &Path, session: &str) -> bool {
    #[cfg(unix)]
    {
        std::fs::symlink_metadata(input_path(logs, session))
            .is_ok_and(|metadata| crate::platform::fs::is_fifo(&metadata.file_type()))
    }
    #[cfg(windows)]
    {
        crate::relay::spawn::launch::holds_input(&input_path(logs, session))
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum SendError {
    /// Nothing reads the input: Claude ended.
    Closed,
    /// Nothing was written.
    NotWritten(String),
    /// Part of the line was written; Claude may have read it.
    Partial(String),
}

fn lock<T>(mutex: &'static OnceLock<Mutex<T>>) -> MutexGuard<'static, T>
where
    T: Default,
{
    mutex
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
}

/// The input's write end, without waiting for a reader: none is `Closed`.
#[cfg(unix)]
fn open(fifo: &Path) -> Result<std::fs::File, SendError> {
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::OpenOptions::new()
        .write(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(fifo)
        .map_err(|error| match error.raw_os_error() {
            Some(libc::ENXIO | libc::ENOENT) => SendError::Closed,
            _ => SendError::NotWritten(error.to_string()),
        })
}

/// Whether a write failed because nothing reads the pipe any more.
fn closed_pipe(error: &std::io::Error) -> bool {
    #[cfg(unix)]
    {
        error.raw_os_error() == Some(libc::EPIPE)
    }
    #[cfg(windows)]
    {
        error.kind() == std::io::ErrorKind::BrokenPipe
    }
}

/// Whether Claude reads `session`'s input: a pipe left behind by a holder
/// that was killed has no reader.
/// On Windows the input is held only while Claude runs.
pub fn reading(logs: &Path, session: &str) -> bool {
    #[cfg(unix)]
    {
        has_input(logs, session)
            && !matches!(open(&input_path(logs, session)), Err(SendError::Closed))
    }
    #[cfg(windows)]
    {
        has_input(logs, session)
    }
}

/// Writes from this process are one at a time, so lines longer than the
/// pipe's atomic size never interleave.
static WRITING: OnceLock<Mutex<()>> = OnceLock::new();

/// Writes `line` and a newline into the input this core holds under `fifo`
/// (`spawn::launch::write_input`), with the Unix write's deadlines: it
/// waits `WRITE_WAIT` to begin and, once some is in, `FINISH_WAIT` more,
/// so an agent that stops reading holds the others up no longer than on
/// Unix. Unlike Unix, a pipe write cannot be taken back: a line handed
/// over and not finished in time is `Partial` even with none of it in yet,
/// since Claude may read it later; only a line never handed over (an
/// earlier one still unfinished) is `NotWritten`.
#[cfg(windows)]
pub fn send(fifo: &Path, line: &str) -> Result<(), SendError> {
    let _one = lock(&WRITING);
    let start = Instant::now() + WRITE_WAIT;
    let bytes = format!("{line}\n").into_bytes();
    match crate::relay::spawn::launch::write_input(fifo, &bytes, start, start + FINISH_WAIT) {
        None => Err(SendError::Closed),
        Some(Ok(())) => Ok(()),
        // Still in the writer's hands: Claude may read it whole later, so
        // it is never written again (`DeadlineWriter::write_counted`).
        Some(Err(shortfall)) if shortfall.in_doubt => Err(SendError::Partial(format!(
            "{}; the line may still arrive",
            shortfall.error
        ))),
        Some(Err(shortfall)) if shortfall.written == 0 && closed_pipe(&shortfall.error) => {
            Err(SendError::Closed)
        }
        Some(Err(shortfall)) if shortfall.written == 0 => {
            Err(SendError::NotWritten(shortfall.error.to_string()))
        }
        Some(Err(shortfall)) => Err(SendError::Partial(shortfall.error.to_string())),
    }
}

/// Writes `line` and a newline into the input at `fifo`. Never blocks on a
/// pipe nobody reads.
#[cfg(unix)]
pub fn send(fifo: &Path, line: &str) -> Result<(), SendError> {
    let _one = lock(&WRITING);
    let mut file = open(fifo)?;
    let bytes = format!("{line}\n").into_bytes();
    let (mut written, deadline) = (0, Instant::now() + WRITE_WAIT);
    while written < bytes.len() {
        match file.write(&bytes[written..]) {
            Ok(count) => written += count,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(error)
                if error.kind() == std::io::ErrorKind::WouldBlock
                    && Instant::now()
                        < deadline
                            + if written > 0 {
                                FINISH_WAIT
                            } else {
                                Duration::ZERO
                            } =>
            {
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(error) => {
                return Err(match written {
                    0 if closed_pipe(&error) => SendError::Closed,
                    0 => SendError::NotWritten(error.to_string()),
                    _ => SendError::Partial(error.to_string()),
                });
            }
        }
    }
    Ok(())
}

/// Where the core is in a session's output.
#[derive(Default)]
struct Reader {
    /// Whether the output has been read once: until then a read is the
    /// first, however many failed before it.
    read: bool,
    offset: u64,
    partial: Vec<u8>,
    /// Refusals not yet written whole.
    unsent: Vec<String>,
}

fn readers() -> MutexGuard<'static, HashMap<String, Reader>> {
    static READERS: OnceLock<Mutex<HashMap<String, Reader>>> = OnceLock::new();
    lock(&READERS)
}

/// The whole lines added to `log` since the last read, and whether this was
/// the first read of the session by this core.
fn read_new(log: &Path, session: &str) -> (Vec<Value>, bool) {
    let mut readers = readers();
    let reader = readers.entry(session.to_string()).or_default();
    let first = !reader.read;
    let Ok(mut file) = std::fs::File::open(log) else {
        return (Vec::new(), first);
    };
    let mut bytes = Vec::new();
    if file.seek(SeekFrom::Start(reader.offset)).is_err() || file.read_to_end(&mut bytes).is_err() {
        return (Vec::new(), first);
    }
    reader.read = true;
    reader.offset += bytes.len() as u64;
    let mut text = std::mem::take(&mut reader.partial);
    text.extend_from_slice(&bytes);
    let complete = text
        .iter()
        .rposition(|byte| *byte == b'\n')
        .map_or(0, |at| at + 1);
    reader.partial = text.split_off(complete);
    let events = text
        .split(|byte| *byte == b'\n')
        .filter_map(|line| serde_json::from_slice::<Value>(line).ok())
        .collect();
    (events, first)
}

/// Whether `event` shows Claude moved on from what it was asking: a turn's
/// result, or its session running again or idle.
fn moved_on(event: &Value) -> bool {
    event["type"] == "result"
        || (event["subtype"] == "session_state_changed"
            && matches!(event["state"].as_str(), Some("idle" | "running")))
}

/// Takes up the control requests in `events`. On a first read, which covers
/// what a core before this one may have answered, only those Claude has not
/// moved on from are; after that, every one is.
fn take_requests(session: &str, events: &[Value], first: bool) -> Vec<String> {
    let mut open: Vec<&Value> = Vec::new();
    for event in events {
        match event["type"].as_str() {
            Some("control_request") => open.push(event),
            Some("control_cancel_request") => {
                let id = event["request_id"].as_str().unwrap_or_default();
                open.retain(|request| request["request_id"] != id);
                requests::cancel(session, id);
            }
            _ if first && moved_on(event) => open.clear(),
            _ => {}
        }
    }
    open.into_iter()
        .filter_map(|request| requests::register(session, request))
        .collect()
}

#[derive(Debug, PartialEq, Eq)]
pub enum Poll {
    /// Claude reads its input, or its input is there and may be read yet
    /// (Claude still starting, or ended and its holder not yet done).
    Live,
    /// Its input is gone: Claude ended, and its references with it.
    Gone,
}

/// Reads `session`'s new output for control requests and writes the
/// answers due. Blocking, briefly.
/// Whether the process is gone is the watcher's to say; a pipe nobody
/// reads yet is waited for, and anything not written whole is kept to write
/// again.
pub fn poll(logs: &Path, session: &str) -> Poll {
    let fifo = input_path(logs, session);
    if !has_input(logs, session) {
        end(session);
        return Poll::Gone;
    }
    if !reading(logs, session) {
        return Poll::Live;
    }
    let (events, first) = read_new(&log_path(logs, session), session);
    let mut refusals = std::mem::take(&mut readers().entry(session.into()).or_default().unsent);
    refusals.extend(take_requests(session, &events, first));
    let mut unsent = Vec::new();
    for line in refusals {
        if send(&fifo, &line).is_err() {
            unsent.push(line);
        }
    }
    readers().entry(session.into()).or_default().unsent = unsent;
    for (reference, line) in requests::due(session) {
        match send(&fifo, &line) {
            Ok(()) => requests::settle(&reference),
            Err(SendError::Closed) => return Poll::Live,
            Err(_) => {}
        }
    }
    Poll::Live
}

/// Ends what the core keeps for `session`: Claude has ended.
pub fn close(session: &str) {
    end(session);
}

fn end(session: &str) {
    requests::forget(session);
    readers().remove(session);
    submitted().remove(session);
}

/// Per session, the turn written and not yet seen: where the output was,
/// the turn's id and when.
fn submitted() -> MutexGuard<'static, HashMap<String, (u64, String, Instant)>> {
    static SUBMITTED: OnceLock<Mutex<HashMap<String, (u64, String, Instant)>>> = OnceLock::new();
    lock(&SUBMITTED)
}

fn length(path: &Path) -> u64 {
    std::fs::metadata(path).map_or(0, |metadata| metadata.len())
}

/// The stream-json line of a native user turn: the text alone, its id the
/// reference of the message it is (`MessageRef::native_uuid`), so its final
/// answer can be found in the transcript.
pub fn user_turn(text: &str, message_id: &str) -> String {
    serde_json::json!({
        "type": "user",
        "uuid": MessageRef::native_uuid(&MessageRef::of(message_id)),
        "message": {"role": "user", "content": text},
    })
    .to_string()
}

/// Writes a user turn into `session`'s input. A turn written is held to be
/// running until Claude's output shows it start, so a second one waits.
pub fn submit(logs: &Path, session: &str, text: &str, message_id: &str) -> Result<(), SendError> {
    let at = length(&log_path(logs, session));
    let uuid = MessageRef::native_uuid(&MessageRef::of(message_id));
    send(&input_path(logs, session), &user_turn(text, message_id))?;
    submitted().insert(session.to_string(), (at, uuid, Instant::now()));
    Ok(())
}

/// Whether a turn written to `session` has not yet shown up in its output:
/// Claude echoes it (`--replay-user-messages`) once it has read it, so a
/// late event of the turn before cannot pass for it.
pub fn starting(logs: &Path, session: &str) -> bool {
    let Some((at, uuid, when)) = submitted().get(session).cloned() else {
        return false;
    };
    let log = log_path(logs, session);
    let started = length(&log) > at
        && super::read_from(&log, at).is_some_and(|output| {
            output
                .split(|byte| *byte == b'\n')
                .filter_map(|line| serde_json::from_slice::<Value>(line).ok())
                .any(|event| event["type"] == "user" && event["uuid"] == uuid.as_str())
        });
    if started || when.elapsed() >= START_WAIT {
        submitted().remove(session);
        return false;
    }
    true
}

// The channel is a FIFO the Unix launcher keeps; on Windows the input this
// core holds (`windows_tests`).
#[cfg(test)]
#[cfg(unix)]
mod tests;
#[cfg(test)]
#[cfg(windows)]
mod windows_tests;
