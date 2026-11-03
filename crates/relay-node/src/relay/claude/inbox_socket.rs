//! Writing one delivery into a terminal session's inbox: a Unix socket, or
//! on Windows a named pipe. Only the session's own process, as the kernel
//! names it, is handed the frames and the token in them.

use super::{PeerFrames, DRAIN_TIMEOUT, SOCKET_TIMEOUT};
use crate::relay::inject::InjectOutcome;
#[cfg(unix)]
use std::io::Read;
use std::io::Write;
#[cfg(unix)]
use std::os::unix::net::UnixStream;
use std::path::Path;

/// Why nothing is written to an inbox whose other end is not the session's
/// own process: the token would go to whoever listens there instead.
fn foreign_inbox(pid: Option<i64>) -> InjectOutcome {
    InjectOutcome::Retry(match pid {
        Some(pid) => format!("the session's inbox is held by another process (pid {pid})"),
        None => "could not tell which process holds the session's inbox".to_string(),
    })
}

/// Hands both lines to the session's inbox: a named pipe on Windows,
/// where Claude Code's `messagingSocketPath` is a `\\.\pipe\…` name. A pipe
/// client opens it as a file. A file has no write timeout, so the writes
/// run on a thread of their own, bounded by `SOCKET_TIMEOUT` each: the
/// authentication line not handed over in time leaves nothing sent
/// (`Retry`); the message line not handed over in time may have partly
/// gone out (`InDoubt`). A thread left blocked ends when the session closes
/// its end.
#[cfg(windows)]
pub(super) fn write(socket: &Path, frames: &PeerFrames, expected_pid: i32) -> InjectOutcome {
    use std::sync::mpsc;
    enum Step {
        /// The pipe's server is not the session's process; nothing written.
        Foreign(Option<i32>),
        Opened,
        Auth(std::io::Result<()>),
        Message(std::io::Result<()>),
        Drained,
    }
    let (auth, message) = frames.bytes.split_at(frames.auth_len);
    let (auth, message) = (auth.to_vec(), message.to_vec());
    let path = socket.to_path_buf();
    let (sender, steps) = mpsc::channel();
    // The message line goes out only once this side still waits for it, so
    // an authentication line that came through too late, after `Retry` was
    // answered, is never followed by the message.
    let (go, proceed) = mpsc::channel::<()>();
    let started = std::thread::Builder::new()
        .name("claude-inbox".into())
        .spawn(move || {
            let mut pipe = match std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(&path)
            {
                Ok(pipe) => pipe,
                Err(error) => {
                    let _ = sender.send(Step::Auth(Err(error)));
                    return;
                }
            };
            // The kernel names the process that created the pipe: only the
            // session's own may be handed its token.
            use std::os::windows::io::AsRawHandle;
            match crate::relay::transport::server_of(pipe.as_raw_handle()) {
                Ok(server)
                    if server.uid == crate::relay::peer::current_uid()
                        && server.pid == Some(expected_pid) => {}
                Ok(server) => {
                    let _ = sender.send(Step::Foreign(server.pid));
                    return;
                }
                Err(_) => {
                    let _ = sender.send(Step::Foreign(None));
                    return;
                }
            }
            let _ = sender.send(Step::Opened);
            let written = pipe.write_all(&auth);
            let failed = written.is_err();
            let _ = sender.send(Step::Auth(written));
            if failed || proceed.recv().is_err() {
                return;
            }
            let written = pipe.write_all(&message);
            let failed = written.is_err();
            let _ = sender.send(Step::Message(written));
            if failed {
                return;
            }
            // `FlushFileBuffers` on a pipe waits until the session has read
            // everything written, so both lines are read before it closes.
            let _ = pipe.sync_all();
            let _ = sender.send(Step::Drained);
        });
    if let Err(error) = started {
        return InjectOutcome::Retry(format!("could not reach the session's inbox: {error}"));
    }
    let unreachable = |reason: String| {
        InjectOutcome::Retry(format!("could not reach the session's inbox: {reason}"))
    };
    let mut opened = false;
    loop {
        match steps.recv_timeout(SOCKET_TIMEOUT) {
            Ok(Step::Foreign(pid)) => return foreign_inbox(pid.map(i64::from)),
            Ok(Step::Opened) => opened = true,
            Ok(Step::Auth(Ok(()))) => break,
            Ok(Step::Auth(Err(error))) => return unreachable(error.to_string()),
            // The thread sends nothing else before the authentication line.
            Ok(Step::Message(_) | Step::Drained) => {
                return unreachable("it answered out of order".into())
            }
            Err(_) if opened => return unreachable("it stopped reading".into()),
            Err(_) => return unreachable("it did not answer".into()),
        }
    }
    if go.send(()).is_err() {
        return unreachable("the connection closed".into());
    }
    match steps.recv_timeout(SOCKET_TIMEOUT) {
        Ok(Step::Message(Ok(()))) => {
            // As on Unix, the session gets `DRAIN_TIMEOUT` to read both
            // lines; the bytes are handed over either way.
            let _ = steps.recv_timeout(DRAIN_TIMEOUT);
            InjectOutcome::Delivered
        }
        Ok(Step::Message(Err(error))) => InjectOutcome::InDoubt(format!(
            "the session's inbox connection broke while sending: {error}"
        )),
        _ => {
            InjectOutcome::InDoubt("the session's inbox stopped reading while sending".to_string())
        }
    }
}

#[cfg(unix)]
pub(super) fn write(socket: &Path, frames: &PeerFrames, expected_pid: i32) -> InjectOutcome {
    let mut stream = match UnixStream::connect(socket) {
        Ok(stream) => stream,
        Err(error) => {
            return InjectOutcome::Retry(format!("could not reach the session's inbox: {error}"))
        }
    };
    // The path is the session's, but a socket file can be replaced: the
    // kernel names the process listening on it, and only the session's own
    // process, run by this user, is handed its token.
    match crate::relay::peer::peer_credentials(&stream) {
        Ok(peer)
            if peer.uid == crate::relay::peer::current_uid() && peer.pid == Some(expected_pid) => {}
        Ok(peer) => return foreign_inbox(peer.pid.map(i64::from)),
        Err(_) => return foreign_inbox(None),
    }
    let _ = stream.set_write_timeout(Some(SOCKET_TIMEOUT));
    let (auth, message) = frames.bytes.split_at(frames.auth_len);
    // A write can fail after part of it went out, so only a failure before
    // any of the message line was handed to the kernel is certain.
    if let Err(error) = stream.write_all(auth) {
        return InjectOutcome::Retry(format!("could not reach the session's inbox: {error}"));
    }
    if let Err(error) = stream.write_all(message) {
        return InjectOutcome::InDoubt(format!(
            "the session's inbox connection broke while sending: {error}"
        ));
    }
    // Let the session read both lines before the connection closes.
    let _ = stream.shutdown(std::net::Shutdown::Write);
    let _ = stream.set_read_timeout(Some(DRAIN_TIMEOUT));
    let _ = stream.read(&mut [0u8; 256]);
    InjectOutcome::Delivered
}
