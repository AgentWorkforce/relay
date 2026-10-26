//! One persistent, detached ACP connection. Only this process writes provider
//! stdin. Every control-message id is held until this host ends; an uncertain
//! prompt is never re-sent and permission requests cannot hang it.

use super::{mcp, write_record, Record, MARKER};
use crate::relay::process::{ProcessTable, SystemProcesses};
use crate::relay::spawn::launch::SpawnedProcess;
use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixListener;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

const FRAME_LIMIT: u64 = 8 * 1024 * 1024;
const MAX_MESSAGES: usize = 4096;

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

pub fn run(
    executable: &Path,
    directory: &Path,
    runtime: &Path,
    launch_id: &str,
    full_access: bool,
) -> Result<()> {
    if !crate::relay::store::is_uuid(launch_id)
        || !directory.is_absolute()
        || !executable.is_absolute()
    {
        return Err(anyhow!("Invalid Devin host arguments"));
    }
    crate::relay::paths::socket_directory(runtime)?;
    let sockets = std::path::PathBuf::from("/tmp").join(format!(
        "agent-relay-devin-{}",
        crate::relay::peer::current_uid()
    ));
    crate::relay::paths::socket_directory(&sockets)?;
    let socket = sockets.join(format!("{launch_id}.sock"));
    // Never unlink a socket that an earlier host might still own.
    let listener = UnixListener::bind(&socket)?;
    std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600))?;
    listener.set_nonblocking(true)?;
    let (mut provider, mut input, rx) = provider(
        executable,
        directory,
        launch_id,
        full_access,
        &runtime.join(format!("{launch_id}.devin.log")),
    )?;
    send(
        &mut input,
        json!({"jsonrpc":"2.0","id":"initialize","method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{},"clientInfo":{"name":"agent-relay","version":"1"}}}),
    )?;
    let initialized = reply(&rx, &mut input, "initialize", Duration::from_secs(10))?;
    if initialized["result"]["protocolVersion"] != 1 {
        return Err(anyhow!("Devin ACP protocol is unsupported"));
    }
    let alias = format!(
        "agent-relay-private-{}",
        crate::relay::store::random_uuid().replace('-', "")
    );
    let server = mcp::definition(
        &std::env::current_exe()?,
        &alias,
        runtime.ends_with("spawned-dev"),
    );
    send(
        &mut input,
        json!({"jsonrpc":"2.0","id":"new","method":"session/new","params":{"cwd":directory,"mcpServers":[server]}}),
    )?;
    let created = reply(&rx, &mut input, "new", Duration::from_secs(15))?;
    let session = created["result"]["sessionId"]
        .as_str()
        .filter(|s| crate::relay::devin::is_session_id(s))
        .ok_or_else(|| anyhow!("Devin ACP did not create a session; check Devin sign-in"))?
        .to_string();
    let table = SystemProcesses::default();
    let host = table
        .process(std::process::id() as i32)
        .map(SpawnedProcess::of)
        .ok_or_else(|| anyhow!("Devin host identity unavailable"))?;
    let child = table
        .process(provider.0.id() as i32)
        .map(SpawnedProcess::of)
        .ok_or_else(|| anyhow!("Devin ACP process unavailable"))?;
    let record = Record {
        launch_id: launch_id.into(),
        session_id: session.clone(),
        host,
        child,
        socket: socket.clone(),
        executable: executable.into(),
    };
    write_record(&runtime.join(format!("{session}.json")), &record)?;
    write_record(&runtime.join(format!("{launch_id}.ready.json")), &record)?;
    let result = drive(&listener, &mut provider, &mut input, &rx, &session, &alias);
    // Retain the identity record as evidence for an unreleased, ended worker.
    let _ = std::fs::remove_file(socket);
    result
}

fn provider(
    executable: &Path,
    directory: &Path,
    launch_id: &str,
    full_access: bool,
    log: &Path,
) -> Result<(Provider, std::process::ChildStdin, Receiver<Value>)> {
    use std::os::unix::fs::OpenOptionsExt;
    let stderr = std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(log)?;
    let child = Command::new(executable)
        .args([
            "--permission-mode",
            if full_access {
                "dangerous"
            } else {
                "accept-edits"
            },
            "acp",
        ])
        .env(MARKER, launch_id)
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
        .ok_or_else(|| anyhow!("Devin ACP has no input"))?;
    let output = provider
        .0
        .stdout
        .take()
        .ok_or_else(|| anyhow!("Devin ACP has no output"))?;
    let (tx, rx) = mpsc::sync_channel(256);
    std::thread::spawn(move || {
        let mut reader = BufReader::new(output);
        loop {
            let mut line = String::new();
            match (&mut reader).take(FRAME_LIMIT + 1).read_line(&mut line) {
                Ok(n) if n > 0 && n as u64 <= FRAME_LIMIT && line.ends_with('\n') => {
                    if let Ok(frame) = serde_json::from_str::<Value>(&line) {
                        if tx.send(frame).is_err() {
                            break;
                        }
                    }
                }
                _ => break,
            }
        }
    });
    Ok((provider, input, rx))
}
fn accept_control(listener: &UnixListener, engine: &mut Engine) -> Result<bool> {
    while let Ok((mut stream, _)) = listener.accept() {
        if !crate::relay::peer::peer_credentials(&stream)
            .is_ok_and(|p| p.uid == crate::relay::peer::current_uid())
        {
            continue;
        }
        stream.set_read_timeout(Some(Duration::from_secs(1)))?;
        stream.set_write_timeout(Some(Duration::from_secs(1)))?;
        let mut line = String::new();
        if BufReader::new(&stream)
            .take(131_073)
            .read_line(&mut line)
            .is_err()
            || line.len() > 131_072
        {
            continue;
        }
        let Ok(request) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let response = engine.request(&request);
        let _ = writeln!(stream, "{response}");
        if request["op"] == "stop" {
            return Ok(true);
        }
    }
    Ok(false)
}
fn drive(
    listener: &UnixListener,
    provider: &mut Provider,
    input: &mut std::process::ChildStdin,
    rx: &Receiver<Value>,
    session: &str,
    alias: &str,
) -> Result<()> {
    let mut engine = Engine {
        relay_server: Some(alias.into()),
        ..Engine::default()
    };
    let mut gate = mcp::Gate::new(session, alias);
    loop {
        while let Ok(frame) = rx.try_recv() {
            engine.observe(&frame);
            if engine.active.is_some() {
                gate.observe(&frame)
            } else {
                gate.clear()
            }
            answer_request(input, &frame, Some(&mut gate))?;
        }
        if provider.0.try_wait()?.is_some() {
            return Err(anyhow!("Devin ACP exited"));
        }
        if accept_control(listener, &mut engine)? {
            return Ok(());
        }
        if let Some(frame) = engine.next(session) {
            gate.clear();
            if send(input, frame).is_err() {
                engine.uncertain();
                return Err(anyhow!("Devin ACP input closed"));
            }
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn send(input: &mut impl Write, frame: Value) -> Result<()> {
    writeln!(input, "{frame}")?;
    input.flush()?;
    Ok(())
}
fn answer_request(
    input: &mut impl Write,
    frame: &Value,
    gate: Option<&mut mcp::Gate>,
) -> Result<()> {
    if frame.get("id").is_some() && frame.get("method").is_some() {
        let response = if frame["method"] == "session/request_permission" {
            let outcome = gate.map_or_else(
                || json!({"outcome":"cancelled"}),
                |gate| gate.outcome(frame),
            );
            json!({"jsonrpc":"2.0","id":frame["id"],"result":{"outcome":outcome}})
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
            .map_err(|_| anyhow!("Devin ACP did not answer"))?;
        answer_request(input, &frame, None)?;
        if frame["id"] == id && frame.get("method").is_none() {
            if frame.get("error").is_some() {
                return Err(anyhow!(
                    "Devin ACP refused initialization; check Devin sign-in"
                ));
            }
            return Ok(frame);
        }
    }
}

struct Turn {
    hash: String,
    text: String,
    status: &'static str,
}
#[derive(Default)]
struct Engine {
    turns: BTreeMap<String, Turn>,
    queue: VecDeque<String>,
    active: Option<String>,
    relay_server: Option<String>,
}
impl Engine {
    fn request(&mut self, request: &Value) -> Value {
        match request["op"].as_str() {
            Some("status") => json!({"state":if self.active.is_some(){"working"}else{"idle"}}),
            Some("stop") => json!({"status":"stopped"}),
            Some("prompt") => {
                let Some(id) = request["id"]
                    .as_str()
                    .filter(|s| !s.is_empty() && s.len() <= 256)
                else {
                    return json!({"status":"refused"});
                };
                let Some(text) = request["text"]
                    .as_str()
                    .filter(|s| !s.is_empty() && s.len() <= 65_536)
                else {
                    return json!({"status":"refused"});
                };
                let hash = format!("{:x}", Sha256::digest(text.as_bytes()));
                if let Some(turn) = self.turns.get(id) {
                    return json!({"status":if turn.hash==hash {turn.status}else{"refused"}});
                }
                if self.turns.len() >= MAX_MESSAGES {
                    return json!({"status":"refused"});
                }
                self.turns.insert(
                    id.into(),
                    Turn {
                        hash,
                        text: text.into(),
                        status: "accepted",
                    },
                );
                self.queue.push_back(id.into());
                json!({"status":"accepted"})
            }
            _ => json!({"status":"refused"}),
        }
    }
    fn next(&mut self, session: &str) -> Option<Value> {
        if self.active.is_some() {
            return None;
        }
        let id = self.queue.pop_front()?;
        let text = self.turns.get(&id)?.text.clone();
        let text = self.relay_server.as_ref().map_or_else(|| text.clone(), |server| format!("Agent Relay transport: use the private MCP server {server} tool send_relay_message for relay replies (to, text, optional numeric reply_to). This replaces any agent-relay-sessions MCP or shell reply instructions below. Only this pinned send tool can be approved without full access. Preserve the requested recipient and reply_to.\n\n{text}"));
        self.active = Some(id.clone());
        Some(
            json!({"jsonrpc":"2.0","id":format!("prompt:{id}"),"method":"session/prompt","params":{"sessionId":session,"prompt":[{"type":"text","text":text}]}}),
        )
    }
    fn observe(&mut self, frame: &Value) {
        let Some(active) = self.active.as_ref() else {
            return;
        };
        if frame["id"].as_str() == Some(&format!("prompt:{active}"))
            && frame.get("method").is_none()
        {
            if let Some(turn) = self.turns.get_mut(active) {
                turn.status = if frame.get("error").is_none() {
                    "delivered"
                } else {
                    "in_doubt"
                };
                turn.text.clear();
            }
            self.active = None;
        } else if frame["method"] == "session/update"
            && frame["params"]["update"]["sessionUpdate"] == "agent_message_chunk"
        {
            if let Some(turn) = self.turns.get_mut(active) {
                turn.status = "delivered";
            }
        }
    }
    fn uncertain(&mut self) {
        if let Some(id) = self.active.take() {
            if let Some(turn) = self.turns.get_mut(&id) {
                turn.status = "in_doubt";
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn persistent_host_serializes_turns_and_replays_without_duplicate_prompt() {
        let mut host = Engine::default();
        let request = json!({"op":"prompt","id":"one","text":"hello"});
        assert_eq!(host.request(&request)["status"], "accepted");
        assert_eq!(host.request(&request)["status"], "accepted");
        assert!(host.next("session-one").is_some());
        assert!(host.next("session-one").is_none());
        assert_eq!(host.request(&json!({"op":"status"}))["state"], "working");
        host.observe(&json!({"id":"prompt:one","result":{"stopReason":"end_turn"}}));
        assert_eq!(host.request(&json!({"op":"status"}))["state"], "idle");
        assert_eq!(host.request(&request)["status"], "delivered");
        assert!(host.next("session-one").is_none());
        host.request(&json!({"op":"prompt","id":"two","text":"again"}));
        assert_eq!(
            host.next("session-one").unwrap()["params"]["prompt"][0]["text"],
            "again"
        );
    }
    #[test]
    fn changed_duplicate_is_refused_and_uncertain_prompt_is_not_repeated() {
        let mut host = Engine::default();
        host.request(&json!({"op":"prompt","id":"one","text":"hello"}));
        assert_eq!(
            host.request(&json!({"op":"prompt","id":"one","text":"different"}))["status"],
            "refused"
        );
        host.next("session-one");
        host.uncertain();
        assert_eq!(
            host.request(&json!({"op":"prompt","id":"one","text":"hello"}))["status"],
            "in_doubt"
        );
        assert!(host.next("session-one").is_none());
    }
    #[test]
    fn permission_requests_are_cancelled_and_rpc_errors_fail_closed() {
        let mut input = Vec::new();
        answer_request(
            &mut input,
            &json!({"id":1,"method":"session/request_permission"}),
            None,
        )
        .unwrap();
        let response: Value = serde_json::from_slice(&input).unwrap();
        assert_eq!(response["result"]["outcome"]["outcome"], "cancelled");
        let mut host = Engine::default();
        host.request(&json!({"op":"prompt","id":"one","text":"hello"}));
        host.next("s1");
        host.observe(&json!({"id":"prompt:one","error":{"code":-1}}));
        assert_eq!(
            host.request(&json!({"op":"prompt","id":"one","text":"hello"}))["status"],
            "in_doubt"
        );
    }
}

#[cfg(test)]
mod transport_tests {
    use super::*;
    use std::os::unix::net::UnixStream;

    fn request(socket: &Path, request: Value) -> Value {
        let mut stream = UnixStream::connect(socket).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        writeln!(stream, "{request}").unwrap();
        let mut line = String::new();
        BufReader::new(stream).read_line(&mut line).unwrap();
        serde_json::from_str(&line).unwrap()
    }

    #[test]
    fn mock_acp_process_stays_idle_and_takes_a_second_turn_until_explicit_release() {
        let dir = tempfile::tempdir().unwrap();
        let executable = dir.path().join("devin");
        std::fs::write(
            &executable,
            r#"#!/usr/bin/python3
import sys,json
for line in sys.stdin:
    f=json.loads(line)
    m=f.get('method')
    if m=='initialize': r={'protocolVersion':1}
    elif m=='session/new': r={'sessionId':'mock-spawn-session'}
    elif m=='session/prompt': r={'stopReason':'end_turn'}
    else: continue
    print(json.dumps({'jsonrpc':'2.0','id':f['id'],'result':r}),flush=True)
"#,
        )
        .unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        let runtime = dir.path().join("runtime");
        let launch_id = crate::relay::store::random_uuid();
        let (cli, cwd, folder, id) = (
            executable.clone(),
            dir.path().to_path_buf(),
            runtime.clone(),
            launch_id.clone(),
        );
        let host = std::thread::spawn(move || run(&cli, &cwd, &folder, &id, false));
        let deadline = Instant::now() + Duration::from_secs(10);
        let record = loop {
            if let Some(record) =
                super::super::read_record(&runtime.join(format!("{launch_id}.ready.json")))
            {
                break record;
            }
            assert!(
                Instant::now() < deadline,
                "mock ACP host did not publish readiness"
            );
            std::thread::sleep(Duration::from_millis(20));
        };
        for id in ["first", "second"] {
            let prompt = json!({"op":"prompt","id":id,"text":"hello"});
            assert_eq!(
                request(&record.socket, prompt.clone())["status"],
                "accepted"
            );
            let deadline = Instant::now() + Duration::from_secs(3);
            loop {
                if request(&record.socket, prompt.clone())["status"] == "delivered" {
                    break;
                }
                assert!(Instant::now() < deadline, "mock prompt did not finish");
                std::thread::sleep(Duration::from_millis(10));
            }
            assert_eq!(
                request(&record.socket, json!({"op":"status"}))["state"],
                "idle"
            );
        }
        assert_eq!(
            request(&record.socket, json!({"op":"stop"}))["status"],
            "stopped"
        );
        assert!(host.join().unwrap().is_ok());
        assert!(!record.socket.exists());
        assert!(SystemProcesses::default().process_gone(record.child.pid));
    }
}
