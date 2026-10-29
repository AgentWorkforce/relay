#![cfg(unix)]

use agent_relay_probe::relay::existing_session::muse::{
    HostManager, MuseMspAdapter, SystemAuthority, SystemControlTransport, SystemMspHost,
};
use agent_relay_probe::relay::existing_session::{
    Binding, Coordinator, Gate, Journal, Outcome, Provider, Request, Transport,
};
use agent_relay_probe::relay::peer::current_uid;
use agent_relay_probe::relay::process::{ProcessTable, SystemProcesses};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::sync::Arc;
use std::time::Duration;

const FINGERPRINT: &str = "sha256:c8d1a2a1866814e220fd396d382a9a75861412feee884b5021b2ee359bd3dc59";

const FAKE_MUSE: &str = r#"#!/usr/bin/env python3
import json, os, sys

SESSION = "0198f0aa-1111-7000-8000-0000000000aa"
FINGERPRINT = "sha256:c8d1a2a1866814e220fd396d382a9a75861412feee884b5021b2ee359bd3dc59"

def send(frame):
    print(json.dumps(frame, separators=(",", ":")), flush=True)

for raw in sys.stdin:
    frame = json.loads(raw)
    method = frame.get("method")
    if method == "initialize":
        send({"jsonrpc":"2.0","id":frame["id"],"result":{
            "serverInfo":{"name":"muse-session-server","version":"1.4.0"},
            "userAgent":"muse-session-server/1.4.0","museHome":os.getcwd(),
            "platformFamily":"unix","platformOs":"linux",
            "schema":{"version":1,"fingerprint":FINGERPRINT},
            "grantedCapabilities":[],"experimentalApi":False,"sessionDurability":"durable"}})
    elif method == "initialized":
        pass
    elif method == "session/resume":
        send({"jsonrpc":"2.0","id":frame["id"],"result":{
            "session":{"sessionId":SESSION,"workspaceRoot":os.getcwd(),
            "modelId":"muse-large-2","providerId":"muse","status":"idle",
            "turnCount":0,"path":"fixture","createdAt":"2026-01-01T00:00:00Z",
            "updatedAt":"2026-01-01T00:00:00Z","forkedFrom":None,"activeTurnId":None},
            "viewCursor":"v:fixture:1","history":{"mode":"inline","items":[]},
            "pendingRequests":[]}})
    elif method == "turn/start":
        p = frame["params"]
        command = p["commandId"]
        text = p["input"][0]["text"]
        send({"jsonrpc":"2.0","id":frame["id"],"result":{"commandId":command,
            "status":"accepted","turnId":command,"startedNewTurn":True,"disposition":"started"}})
        send({"jsonrpc":"2.0","method":"item/completed","params":{"sessionId":SESSION,
            "item":{"itemId":"user","kind":"userMessage","turnId":command,"revision":1,
            "status":"completed","commandId":command,"text":text}}})
    elif method == "view/page":
        send({"jsonrpc":"2.0","id":frame["id"],"result":{"events":[],"nextCursor":None}})
"#;

#[test]
fn managed_muse_process_socket_and_durable_acceptance_round_trip() {
    let directory = tempfile::tempdir().unwrap();
    fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let root = fs::canonicalize(directory.path()).unwrap();
    let executable = root.join("muse");
    fs::write(&executable, FAKE_MUSE).unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
    let process = SystemProcesses::default()
        .process(std::process::id() as i32)
        .unwrap();
    let binding = Binding {
        provider: Provider::Muse,
        transport: Transport::Msp,
        workspace_id: "rw_fixture".into(),
        session_id: "0198f0aa-1111-7000-8000-0000000000aa".into(),
        owner_id: "owner-fixture".into(),
        credential_reference: String::new(),
        owner_uid: current_uid(),
        endpoint_id: "host-generation-fixture".into(),
        auth_id: "account:fixture".into(),
        protocol_id: FINGERPRINT.into(),
        cwd: root.clone(),
        model_id: "muse-large-2".into(),
        agent_version: "1.4.0".into(),
        executable,
        leader_pid: process.pid,
        leader_start: process.start,
        socket_path: root.join("muse-control.sock"),
        socket_device: 0,
        socket_inode: 0,
    };
    let environment = vec![("PATH".into(), std::env::var_os("PATH").unwrap())];
    let engine = SystemMspHost::launch(binding.clone(), &environment, Duration::from_secs(5))
        .expect("fake MSP host initializes and resumes the exact session");
    let manager = Arc::new(HostManager::bind(binding, Box::new(engine)).unwrap());
    let bound = manager.binding().clone();
    let adapter = Arc::new(MuseMspAdapter::new(
        bound.workspace_id.clone(),
        bound.owner_id.clone(),
        bound.owner_uid,
        bound.endpoint_id.clone(),
        bound.auth_id.clone(),
        Arc::new(SystemAuthority::default()),
        Arc::new(SystemControlTransport),
    ));
    let coordinator = Coordinator::new(
        Gate::enabled([Provider::Muse]),
        Journal::new(directory.path().join("journal")).unwrap(),
        vec![adapter],
    )
    .unwrap();
    let server = manager.clone();
    let thread = std::thread::spawn(move || server.serve_one().unwrap());
    let outcome = coordinator.inject(&Request {
        binding: &bound,
        delivery_id: "delivery-fixture",
        message_id: "message-fixture",
        text: "reply through the managed host",
        timeout: Duration::from_secs(5),
    });
    thread.join().unwrap();
    assert!(
        matches!(outcome, Outcome::Delivered { receipt_id } if receipt_id.starts_with("muse-msp:"))
    );
}
