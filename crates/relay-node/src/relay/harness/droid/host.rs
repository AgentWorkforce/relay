//! One persistent, detached JSON-RPC connection. Only this process writes provider
//! stdin. Every control-message id is held until this host ends; an uncertain
//! prompt is never re-sent and permission requests cannot hang it.

use super::{protocol::Engine, write_record, Record, MARKER};
mod input;
use crate::relay::process::{ProcessTable, SystemProcesses};
use crate::relay::spawn::launch::SpawnedProcess;
use anyhow::{anyhow, Result};
use input::Input;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

const FRAME_LIMIT: u64 = 8 * 1024 * 1024;
struct BoundSocket(std::path::PathBuf);
impl Drop for BoundSocket {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

struct Provider(Child, std::path::PathBuf);
impl Drop for Provider {
    fn drop(&mut self) {
        let _ = self.0.kill();
        if let Ok(status) = self.0.wait() {
            let _ = crate::relay::detach::record_exit(
                &self.1,
                &status
                    .code()
                    .map(|code| code.to_string())
                    .unwrap_or_else(|| "signal".into()),
            );
        }
    }
}

pub fn run(executable: &Path, directory: &Path, runtime: &Path, launch_id: &str) -> Result<()> {
    if !crate::relay::store::is_uuid(launch_id)
        || !directory.is_absolute()
        || !executable.is_absolute()
    {
        return Err(anyhow!("Invalid Droid host arguments"));
    }
    crate::relay::paths::socket_directory(runtime)?;
    let sockets = std::path::PathBuf::from("/tmp").join(format!(
        "agent-relay-droid-{}",
        crate::relay::peer::current_uid()
    ));
    crate::relay::paths::socket_directory(&sockets)?;
    let socket = sockets.join(format!("{launch_id}.sock"));
    // Never unlink a socket that an earlier host might still own.
    let listener = UnixListener::bind(&socket)?;
    let _socket_cleanup = BoundSocket(socket.clone());
    std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600))?;
    listener.set_nonblocking(true)?;
    let (mut provider, mut input, rx) = provider(
        executable,
        directory,
        launch_id,
        &runtime.join(format!("{launch_id}.droid.log")),
    )?;
    let alias = format!(
        "agent-relay-private-{}",
        crate::relay::store::random_uuid().replace('-', "")
    );
    let mut server = super::super::relay_mcp::definition(
        &std::env::current_exe()?,
        &alias,
        runtime.ends_with("spawned-dev"),
        super::super::relay_mcp::Harness::Droid,
    );
    server["env"] = json!({});
    send(
        &mut input,
        json!({"jsonrpc":"2.0","id":"initialize","method":"droid.initialize_session","params":{"machineId":"agent-relay","cwd":directory,"autonomyMode":"normal","mcpServers":[server]}}),
    )?;
    let created = reply(&rx, &mut input, "initialize", Duration::from_secs(30))?;
    let session = created["result"]["sessionId"]
        .as_str()
        .filter(|s| crate::relay::store::is_uuid(s))
        .ok_or_else(|| anyhow!("Droid JSON-RPC did not create a session; check Factory sign-in"))?
        .to_string();
    let table = SystemProcesses::default();
    let host = table
        .process(std::process::id() as i32)
        .map(SpawnedProcess::of)
        .ok_or_else(|| anyhow!("Droid host identity unavailable"))?;
    let child = table
        .process(provider.0.id() as i32)
        .map(SpawnedProcess::of)
        .ok_or_else(|| anyhow!("Droid JSON-RPC process unavailable"))?;
    let mut engine = Engine::new(&alias, &runtime.join(format!("{launch_id}.deliveries.db")))?;
    let initial_message_id = admit_initial(&mut engine, runtime, launch_id)?;
    let record = Record {
        launch_id: launch_id.into(),
        session_id: session.clone(),
        host,
        child,
        socket: socket.clone(),
        executable: table
            .executable(child.pid)
            .and_then(|p| std::fs::canonicalize(p).ok())
            .ok_or_else(|| anyhow!("Droid executable identity unavailable"))?,
        directory: directory.into(),
        initial_message_id,
    };
    write_record(&runtime.join(format!("{session}.json")), &record)?;
    write_record(&runtime.join(format!("{launch_id}.ready.json")), &record)?;
    let result = drive(
        &listener,
        &mut provider,
        &mut input,
        &rx,
        &session,
        &mut engine,
    );
    // Retain the identity record as evidence for an unreleased, ended worker.
    result
}

fn admit_initial(engine: &mut Engine, runtime: &Path, launch_id: &str) -> Result<Option<String>> {
    let Some(task) = super::registry::initial(runtime, launch_id)? else {
        return Ok(None);
    };
    anyhow::ensure!(
        engine.request(&json!({"op":"prompt","id":task.id,"text":task.text}))["status"]
            == "accepted",
        "Droid initial task was refused"
    );
    std::fs::remove_file(runtime.join(format!("{launch_id}.task.json")))?;
    Ok(Some(task.id))
}

fn provider(
    executable: &Path,
    directory: &Path,
    launch_id: &str,
    log: &Path,
) -> Result<(Provider, Input, Receiver<Value>)> {
    use std::os::unix::fs::OpenOptionsExt;
    let stderr = std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(log)?;
    let child = Command::new(executable)
        .args([
            "exec",
            "--input-format",
            "stream-jsonrpc",
            "--output-format",
            "stream-jsonrpc",
        ])
        .env(MARKER, launch_id)
        .env("FACTORY_DROID_AUTO_UPDATE_ENABLED", "false")
        .current_dir(directory)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::from(stderr))
        .spawn()?;
    let mut provider = Provider(child, log.with_extension("exit"));
    let input = provider
        .0
        .stdin
        .take()
        .ok_or_else(|| anyhow!("Droid JSON-RPC has no input"))?;
    let input = Input::new(input)?;
    let output = provider
        .0
        .stdout
        .take()
        .ok_or_else(|| anyhow!("Droid JSON-RPC has no output"))?;
    let (tx, rx) = mpsc::sync_channel(256);
    std::thread::spawn(move || {
        let mut reader = BufReader::new(output);
        loop {
            let mut line = String::new();
            match (&mut reader).take(FRAME_LIMIT + 1).read_line(&mut line) {
                Ok(n) if n > 0 && n as u64 <= FRAME_LIMIT && line.ends_with('\n') => {
                    let Ok(frame) = serde_json::from_str::<Value>(&line) else {
                        break;
                    };
                    if tx.send(frame).is_err() {
                        break;
                    }
                }
                _ => break,
            }
        }
    });
    Ok((provider, input, rx))
}
/// A control connection whose request line has not all arrived.
struct Control {
    stream: UnixStream,
    line: Vec<u8>,
    deadline: Instant,
}

/// The longest request line a control client may send.
const CONTROL_LINE_LIMIT: usize = 512 * 1024;
/// How long a control client has to send its request line.
const CONTROL_READ_BUDGET: Duration = Duration::from_secs(1);
/// How many control clients may wait on their request line at once; the
/// relay sends one request at a time, so more are dropped.
const CONTROL_PENDING_LIMIT: usize = 64;

/// Accepts control connections and answers every request whose line has
/// arrived, without waiting on any client: a client that has not written
/// yet stays in `pending` until its line arrives or its budget runs out, so
/// one silent client never holds up JSON-RPC frames or another request.
fn accept_control(
    listener: &UnixListener,
    pending: &mut Vec<Control>,
    engine: &mut Engine,
) -> Result<bool> {
    while let Ok((stream, _)) = listener.accept() {
        if !crate::relay::peer::peer_credentials(&stream)
            .is_ok_and(|p| p.uid == crate::relay::peer::current_uid())
        {
            continue;
        }
        // macOS hands an accepted socket the listener's non-blocking mode and
        // Linux does not; set it either way, since reads below must not wait.
        if stream.set_nonblocking(true).is_err() {
            continue;
        }
        if pending.len() >= CONTROL_PENDING_LIMIT {
            continue;
        }
        pending.push(Control {
            stream,
            line: Vec::new(),
            deadline: Instant::now() + CONTROL_READ_BUDGET,
        });
    }
    let now = Instant::now();
    let mut index = 0;
    while index < pending.len() {
        let expired = now >= pending[index].deadline;
        match read_control(&mut pending[index]) {
            ControlRead::Waiting if !expired => index += 1,
            ControlRead::Waiting | ControlRead::Dropped => {
                pending.swap_remove(index);
            }
            // A line is answered even when this pass came after the budget:
            // the client wrote in time if the host itself was slow to read.
            ControlRead::Line(line) => {
                let mut control = pending.swap_remove(index);
                let Ok(request) = serde_json::from_slice::<Value>(&line) else {
                    continue;
                };
                let response = engine.request(&request);
                // The answer is one short line; give a slow reader a moment.
                let _ = control.stream.set_nonblocking(false);
                let _ = control.stream.set_write_timeout(Some(CONTROL_READ_BUDGET));
                let _ = writeln!(control.stream, "{response}");
                if request["op"] == "stop" {
                    // Nothing after the stop is answered: a prompt accepted
                    // now would never be sent. Its client reads a closed
                    // connection instead.
                    return Ok(true);
                }
            }
        }
    }
    Ok(false)
}

enum ControlRead {
    Waiting,
    Line(Vec<u8>),
    Dropped,
}

fn read_control(control: &mut Control) -> ControlRead {
    let mut chunk = [0u8; 8192];
    loop {
        match control.stream.read(&mut chunk) {
            Ok(0) => return ControlRead::Dropped,
            Ok(read) => {
                control.line.extend_from_slice(&chunk[..read]);
                if let Some(end) = control.line.iter().position(|b| *b == b'\n') {
                    if end > CONTROL_LINE_LIMIT {
                        return ControlRead::Dropped;
                    }
                    control.line.truncate(end);
                    return ControlRead::Line(std::mem::take(&mut control.line));
                }
                if control.line.len() > CONTROL_LINE_LIMIT {
                    return ControlRead::Dropped;
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                return ControlRead::Waiting
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(_) => return ControlRead::Dropped,
        }
    }
}
fn drive(
    listener: &UnixListener,
    provider: &mut Provider,
    input: &mut Input,
    rx: &Receiver<Value>,
    session: &str,
    engine: &mut Engine,
) -> Result<()> {
    let mut pending = Vec::new();
    loop {
        loop {
            let frame = match rx.try_recv() {
                Ok(frame) => frame,
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => {
                    engine.uncertain();
                    return Err(anyhow!("Droid native output channel closed"));
                }
            };
            engine.observe(&frame);
            answer_request(input, &frame, Some(engine))?;
        }
        if provider.0.try_wait()?.is_some() {
            return Err(anyhow!("Droid JSON-RPC exited"));
        }
        if accept_control(listener, &mut pending, engine)? {
            return Ok(());
        }
        if let Some(frame) = engine.next(session) {
            if send(input, frame).is_err() {
                engine.uncertain();
                return Err(anyhow!("Droid JSON-RPC input closed"));
            }
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn send(input: &mut impl Write, mut frame: Value) -> Result<()> {
    frame["factoryApiVersion"] = json!("1.0.0");
    frame["type"] = json!(if frame.get("method").is_some() {
        "request"
    } else {
        "response"
    });
    input.write_all(&serde_json::to_vec(&frame)?)?;
    input.write_all(b"\n")?;
    input.flush()?;
    Ok(())
}
fn answer_request(input: &mut impl Write, frame: &Value, engine: Option<&Engine>) -> Result<()> {
    if frame.get("id").is_some() && frame.get("method").is_some() {
        let response = if frame["method"] == "droid.request_permission" {
            let allowed = engine.is_some_and(|e| e.permit(frame));
            json!({"jsonrpc":"2.0","id":frame["id"],"result":{"selectedOption":if allowed {"proceed_once"} else {"cancel"}}})
        } else {
            json!({"jsonrpc":"2.0","id":frame["id"],"error":{"code":-32601,"message":"Client method unsupported"}})
        };
        send(input, response)?;
    }
    Ok(())
}

fn reply(
    rx: &Receiver<Value>,
    input: &mut impl Write,
    id: &str,
    timeout: Duration,
) -> Result<Value> {
    let deadline = Instant::now() + timeout;
    loop {
        let frame = rx
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .map_err(|_| anyhow!("Droid JSON-RPC did not answer"))?;
        answer_request(input, &frame, None)?;
        if frame["id"] == id && frame.get("method").is_none() {
            if frame.get("error").is_some() {
                return Err(anyhow!(super::STARTUP_GUIDANCE));
            }
            return Ok(frame);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_envelope_matches_the_installed_droid_wire_contract() {
        let mut output = Vec::new();
        send(&mut output, json!({"jsonrpc":"2.0","id":"i","method":"droid.initialize_session","params":{"machineId":"agent-relay","cwd":"/tmp"}})).unwrap();
        let sent: Value = serde_json::from_slice(&output).unwrap();
        assert_eq!(sent["factoryApiVersion"], "1.0.0");
        assert_eq!(sent["type"], "request");
        assert_eq!(sent["params"]["cwd"], "/tmp");
    }
    #[test]
    fn startup_permissions_and_questions_fail_closed_with_valid_responses() {
        let mut output = Vec::new();
        answer_request(&mut output, &json!({"jsonrpc":"2.0","id":"p","method":"droid.request_permission","params":{"toolUses":[]}}), None).unwrap();
        let response: Value = serde_json::from_slice(&output).unwrap();
        assert_eq!(response["type"], "response");
        assert_eq!(response["factoryApiVersion"], "1.0.0");
        assert_eq!(response["result"]["selectedOption"], "cancel");
        output.clear();
        answer_request(
            &mut output,
            &json!({"id":"question","method":"droid.ask_user","params":{}}),
            None,
        )
        .unwrap();
        let response: Value = serde_json::from_slice(&output).unwrap();
        assert_eq!(response["error"]["code"], -32601);
    }
}

#[cfg(test)]
mod resilience_tests {
    use super::*;
    #[test]
    fn loss_of_output_ends_the_host_even_while_the_provider_is_alive() {
        let directory = tempfile::tempdir().unwrap();
        let listener = UnixListener::bind(directory.path().join("test.sock")).unwrap();
        listener.set_nonblocking(true).unwrap();
        let mut provider = Provider(
            Command::new("/bin/sleep")
                .arg("60")
                .stdin(Stdio::piped())
                .spawn()
                .unwrap(),
            directory.path().join("exit"),
        );
        let mut input = Input::new(provider.0.stdin.take().unwrap()).unwrap();
        let (sender, receiver) = mpsc::channel();
        drop(sender);
        let mut engine = Engine::testing();
        assert!(provider.0.try_wait().unwrap().is_none());
        assert!(drive(
            &listener,
            &mut provider,
            &mut input,
            &receiver,
            "session",
            &mut engine
        )
        .is_err());
        assert_eq!(engine.request(&json!({"op":"status"}))["state"], "unknown");
        // Provider's RAII owner kills and waits for this exact child.
        drop(provider);
    }
    #[test]
    fn setup_failure_removes_its_new_socket_but_never_an_existing_one() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("test.sock");
        let _listener = UnixListener::bind(&path).unwrap();
        assert!(UnixListener::bind(&path).is_err());
        assert!(path.exists());
        {
            let _cleanup = BoundSocket(path.clone());
        }
        assert!(!path.exists());
    }
    #[test]
    fn control_frames_fit_the_maximum_json_escaped_prompt() {
        let (mut sender, receiver) = UnixStream::pair().unwrap();
        receiver.set_nonblocking(true).unwrap();
        let body =
            json!({"op":"prompt","id":"escaped","text":"\0".repeat(65_536)}).to_string() + "\n";
        assert!(body.len() > 131_072 && body.len() < CONTROL_LINE_LIMIT);
        let writer = std::thread::spawn(move || {
            sender.write_all(body.as_bytes()).unwrap();
        });
        let mut control = Control {
            stream: receiver,
            line: Vec::new(),
            deadline: Instant::now() + Duration::from_secs(5),
        };
        loop {
            match read_control(&mut control) {
                ControlRead::Line(line) => {
                    assert_eq!(
                        serde_json::from_slice::<Value>(&line).unwrap()["text"]
                            .as_str()
                            .unwrap()
                            .len(),
                        65_536
                    );
                    break;
                }
                ControlRead::Waiting if Instant::now() < control.deadline => {
                    std::thread::sleep(Duration::from_millis(1))
                }
                _ => panic!("bounded encoded prompt was discarded"),
            }
        }
        writer.join().unwrap();
    }
}
