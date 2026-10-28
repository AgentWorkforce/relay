//! A Gateway on loopback that checks the handshake the way OpenClaw does,
//! and can play any supported release: the protocol it accepts, the closed
//! schemas of the methods Agent Relay calls, and what its session history
//! records.
use super::*;
use std::collections::{BTreeSet, HashMap};
use std::net::TcpListener;
use std::sync::mpsc;
use std::thread::JoinHandle;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Behaviour {
    Answer,
    /// Reads `chat.send` and closes without a response.
    DropAfterSend,
    /// Answers the connect with a retryable startup error.
    Starting,
}

/// Every field OpenClaw 2026.10.4's `chat.history` accepts
/// (`ChatHistoryParamsSchema`, a closed object).
pub(super) const CHAT_HISTORY_FIELDS: [&str; 11] = [
    "sessionKey",
    "agentId",
    "cursor",
    "limit",
    "maxBytes",
    "offset",
    "pendingBefore",
    "inputRunIds",
    "messageId",
    "sessionId",
    "maxChars",
];

pub(super) const CURRENT: Release = Release::new(2026, 10, 4);

fn at(release: Release, year: u32, month: u32, day: u32) -> bool {
    release >= Release::new(year, month, day)
}

/// The fields a release's closed schema for `method` accepts, as its npm
/// dist defines them; `None` when the release has no such method.
pub(super) fn schema(release: Release, method: &str) -> Option<Vec<&'static str>> {
    let mut fields: Vec<&'static str> = match method {
        "chat.history" if at(release, 2026, 8, 1) => CHAT_HISTORY_FIELDS.to_vec(),
        "chat.history" => {
            let mut fields = vec!["sessionKey", "limit"];
            if at(release, 2026, 4, 1) {
                fields.push("maxChars");
            }
            if at(release, 2026, 6, 1) {
                fields.push("agentId");
            }
            if at(release, 2026, 7, 1) {
                fields.push("offset");
            }
            fields
        }
        "chat.send" => {
            let mut fields = vec![
                "sessionKey",
                "message",
                "thinking",
                "deliver",
                "attachments",
                "timeoutMs",
                "systemInputProvenance",
                "systemProvenanceReceipt",
                "idempotencyKey",
            ];
            if at(release, 2026, 6, 5) {
                fields.push("suppressCommandInterpretation");
            }
            fields
        }
        "sessions.create" if !at(release, 2026, 3, 22) => return None,
        "sessions.create" => {
            let mut fields = vec![
                "key",
                "agentId",
                "label",
                "model",
                "parentSessionKey",
                "task",
                "message",
            ];
            if at(release, 2026, 7, 1) {
                fields.extend(["fork", "emitCommandHooks", "worktree"]);
            }
            if at(release, 2026, 8, 1) {
                fields.extend(["idempotencyKey", "permissionMode", "toolOverrides"]);
            }
            if at(release, 2026, 9, 1) {
                fields.push("displayName");
            }
            fields
        }
        "sessions.patch" => {
            let mut fields = vec!["key", "label", "model", "thinkingLevel"];
            if at(release, 2026, 8, 1) {
                fields.extend(["agentId", "permissionMode", "toolOverrides"]);
            }
            fields
        }
        "sessions.list" => vec!["limit", "agentId", "search", "includeGlobal"],
        "agent.wait" => vec!["runId", "timeoutMs"],
        "agents.list" => vec![],
        _ => return None,
    };
    fields.sort_unstable();
    Some(fields)
}

/// What the fake Gateway holds: each session's transcript and its runs.
pub(super) struct State {
    pub(super) sessions: HashMap<String, Vec<Value>>,
    /// Runs started and not yet finished, with their session and text.
    pub(super) running: HashMap<String, (String, String)>,
    pub(super) finished: BTreeSet<String>,
    /// Sends answer at once unless held, as a slow model would not.
    pub(super) hold: bool,
    /// Every `chat.send` the Gateway ran (not the ones it deduplicated).
    pub(super) runs: Vec<String>,
    pub(super) uptime_ms: u64,
    /// When each session's last run started (`sessions.list` `startedAt`).
    pub(super) started: HashMap<String, u64>,
    /// `chat.send` is refused, as a session's send policy would.
    pub(super) refuse_sends: bool,
    /// The tool steps each run takes before it answers.
    pub(super) steps: usize,
}

impl Default for State {
    fn default() -> State {
        State {
            sessions: HashMap::new(),
            running: HashMap::new(),
            finished: BTreeSet::new(),
            hold: false,
            runs: Vec::new(),
            uptime_ms: 60_000,
            started: HashMap::new(),
            refuse_sends: false,
            steps: 1,
        }
    }
}

pub(super) struct FakeGateway {
    pub(super) port: u16,
    pub(super) requests: mpsc::Receiver<Value>,
    pub(super) state: Arc<Mutex<State>>,
    pub(super) release: Release,
    thread: Option<JoinHandle<()>>,
}

struct Served {
    release: Release,
    token: &'static str,
    behaviour: Behaviour,
    /// A fixed `chat.history` answer instead of the transcript.
    history: Option<Value>,
    state: Arc<Mutex<State>>,
}

fn error(id: &Value, code: &str, message: &str) -> Value {
    json!({ "type": "res", "id": id, "ok": false, "error": { "code": code, "message": message } })
}

fn verified_connect(params: &Value, token: &str, nonce: &str, ts: u64) -> bool {
    let device = &params["device"];
    let decode = |field: &str| {
        device[field]
            .as_str()
            .and_then(|text| URL_SAFE_NO_PAD.decode(text).ok())
            .unwrap_or_default()
    };
    let (public, signature) = (decode("publicKey"), decode("signature"));
    let scopes: Vec<&str> = params["scopes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    let payload = format!(
        "v3|{}|{}|{}|{}|{}|{}|{}|{}|{}|",
        device["id"].as_str().unwrap_or_default(),
        params["client"]["id"].as_str().unwrap_or_default(),
        params["client"]["mode"].as_str().unwrap_or_default(),
        params["role"].as_str().unwrap_or_default(),
        scopes.join(","),
        device["signedAt"].as_u64().unwrap_or_default(),
        params["auth"]["token"].as_str().unwrap_or_default(),
        device["nonce"].as_str().unwrap_or_default(),
        params["client"]["platform"].as_str().unwrap_or_default(),
    );
    let verified = ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, &public)
        .verify(payload.as_bytes(), &signature)
        .is_ok();
    verified
        && device["id"] == hex(&Sha256::digest(&public)).as_str()
        && device["nonce"] == nonce
        && device["signedAt"] == ts
        && params["auth"]["token"] == token
}

impl Served {
    fn protocol(&self) -> u64 {
        if at(self.release, 2026, 5, 12) {
            4
        } else {
            3
        }
    }

    fn methods(&self) -> Vec<&'static str> {
        [
            "agents.list",
            "chat.send",
            "chat.history",
            "sessions.create",
            "sessions.patch",
            "sessions.list",
            "agent.wait",
        ]
        .into_iter()
        .filter(|method| schema(self.release, method).is_some())
        .collect()
    }

    fn connect(&self, id: &Value, params: &Value, nonce: &str, ts: u64) -> Value {
        if self.behaviour == Behaviour::Starting {
            return json!({
                "type": "res", "id": id, "ok": false,
                "error": { "code": "UNAVAILABLE", "message": "starting", "details": { "reason": "startup-sidecars" } }
            });
        }
        let protocol = self.protocol();
        let offered = params["minProtocol"].as_u64().unwrap_or(99)
            ..=params["maxProtocol"].as_u64().unwrap_or(0);
        if !offered.contains(&protocol) {
            return error(id, "INVALID_REQUEST", "protocol mismatch");
        }
        if !verified_connect(params, self.token, nonce, ts) {
            return json!({ "type": "res", "id": id, "ok": false, "error": { "code": "INVALID_REQUEST", "message": "device signature invalid", "details": { "code": "DEVICE_AUTH_SIGNATURE_INVALID" } } });
        }
        let uptime = self.state.lock().unwrap().uptime_ms;
        json!({ "type": "res", "id": id, "ok": true, "payload": {
            "type": "hello-ok",
            "protocol": protocol,
            "server": { "version": self.release.to_string(), "connId": "c-1" },
            "features": { "methods": self.methods(), "events": [] },
            "snapshot": { "uptimeMs": uptime },
            "auth": { "role": "operator", "scopes": SCOPES, "deviceToken": "issued-token" }
        } })
    }

    fn user_turn(&self, key: &str, run: &str, text: &str) -> Value {
        let mut turn = json!({ "role": "user", "content": [{ "type": "text", "text": text }], "timestamp": now_ms() });
        if at(self.release, 2026, 5, 26) {
            turn["__openclaw"] = json!({ "idempotencyKey": format!("{}:user", run.to_lowercase()), "id": format!("u-{key}") });
        }
        turn
    }

    fn answer(&self, run: &str, text: &str) -> Value {
        let mut answer = json!({ "role": "assistant", "content": [{ "type": "text", "text": text }], "stopReason": "stop", "timestamp": now_ms() });
        // Entries name their run from 2026.8.1; a released Gateway marks
        // `runTerminal` only on mirrored entries, so a plain run has none.
        if at(self.release, 2026, 8, 1) {
            answer["__openclaw"] = json!({ "runId": run });
        }
        answer
    }

    fn send(&self, params: &Value) -> Value {
        let key = params["sessionKey"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        let run = params["idempotencyKey"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        let text = params["message"].as_str().unwrap_or_default().to_string();
        let mut state = self.state.lock().unwrap();
        if state.running.contains_key(&run) {
            return json!({ "runId": run, "status": "in_flight" });
        }
        if state.refuse_sends {
            return json!({ "refused": true });
        }
        state.runs.push(run.clone());
        state.started.insert(key.clone(), now_ms());
        // From 2026.5.26 the user turn is written when the run starts;
        // earlier this fake writes it only when the run ends, the latest
        // a real Gateway does.
        if at(self.release, 2026, 5, 26) {
            let turn = self.user_turn(&key, &run, &text);
            state.sessions.entry(key.clone()).or_default().push(turn);
        }
        state.running.insert(run.clone(), (key, text));
        let hold = state.hold;
        drop(state);
        if !hold {
            self.finish(&run);
        }
        json!({ "runId": run, "status": "started" })
    }

    pub(super) fn finish(&self, run: &str) {
        finish(&self.state, self.release, run);
    }

    fn history(&self, params: &Value) -> Value {
        if let Some(history) = &self.history {
            return history.clone();
        }
        let key = params["sessionKey"].as_str().unwrap_or_default();
        let state = self.state.lock().unwrap();
        let mut messages = state.sessions.get(key).cloned().unwrap_or_default();
        let limit = params["limit"].as_u64().unwrap_or(200) as usize;
        messages.drain(..messages.len().saturating_sub(limit));
        let mut history = json!({ "sessionKey": key, "messages": messages });
        if at(self.release, 2026, 6, 1) {
            let active = state.running.values().any(|(session, _)| session == key);
            history["sessionInfo"] = json!({ "hasActiveRun": active });
        }
        history
    }

    fn list(&self, params: &Value) -> Value {
        let search = params["search"].as_str().unwrap_or_default();
        let state = self.state.lock().unwrap();
        let rows: Vec<Value> = state
            .sessions
            .keys()
            .chain(state.running.values().map(|(key, _)| key))
            .filter(|key| key.contains(search))
            .collect::<BTreeSet<_>>()
            .into_iter()
            .map(|key| {
                let mut row = json!({ "key": key });
                let active = state.running.values().any(|(session, _)| session == key);
                if at(self.release, 2026, 5, 2) {
                    row["hasActiveRun"] = Value::Bool(active);
                }
                if at(self.release, 2026, 3, 22) {
                    row["status"] = json!(if active { "running" } else { "done" });
                    row["startedAt"] = json!(state.started.get(key.as_str()));
                }
                row
            })
            .collect();
        json!({ "sessions": rows })
    }

    fn wait(&self, params: &Value) -> Value {
        let run = params["runId"].as_str().unwrap_or_default();
        let done = self.state.lock().unwrap().finished.contains(run);
        json!({ "runId": run, "status": if done { "ok" } else { "timeout" } })
    }

    fn respond(&self, id: &Value, method: &str, params: &Value) -> Option<Value> {
        let Some(fields) = schema(self.release, method) else {
            return Some(error(id, "INVALID_REQUEST", "unknown method"));
        };
        // Closed schemas: one unknown field fails the whole request.
        if let Some(unknown) = params
            .as_object()
            .and_then(|given| given.keys().find(|field| !fields.contains(&field.as_str())))
        {
            return Some(error(
                id,
                "INVALID_REQUEST",
                &format!("invalid {method} params: unexpected property '{unknown}'"),
            ));
        }
        let payload = match method {
            "agents.list" => json!({ "agents": [
                { "id": "main", "identity": { "name": "Robin" } },
                { "id": "Bad Id" },
                { "id": "work" }
            ] }),
            "sessions.create" | "sessions.patch" => json!({ "key": params["key"] }),
            "chat.send" if self.behaviour == Behaviour::DropAfterSend => return None,
            "chat.send" => {
                let sent = self.send(params);
                if sent["refused"] == true {
                    return Some(error(
                        id,
                        "INVALID_REQUEST",
                        "send blocked by session policy",
                    ));
                }
                sent
            }
            "chat.history" => self.history(params),
            "sessions.list" => self.list(params),
            "agent.wait" => self.wait(params),
            _ => return Some(error(id, "INVALID_REQUEST", "unknown method")),
        };
        Some(json!({ "type": "res", "id": id, "ok": true, "payload": payload }))
    }

    fn serve(&self, stream: std::net::TcpStream, tx: &mpsc::Sender<Value>) -> bool {
        let Ok(mut socket) = tungstenite::accept(stream) else {
            return false;
        };
        let nonce = "nonce-1";
        let ts = now_ms();
        let challenge = json!({ "type": "event", "event": "connect.challenge", "payload": { "nonce": nonce, "ts": ts } });
        if socket
            .send(tungstenite::Message::Text(challenge.to_string()))
            .is_err()
        {
            return true;
        }
        while let Ok(tungstenite::Message::Text(text)) = socket.read() {
            let Ok(frame) = serde_json::from_str::<Value>(&text) else {
                break;
            };
            let id = frame["id"].clone();
            let method = frame["method"].as_str().unwrap_or_default().to_string();
            let params = frame["params"].clone();
            if tx.send(frame).is_err() {
                return false;
            }
            let response = if method == "connect" {
                Some(self.connect(&id, &params, nonce, ts))
            } else {
                self.respond(&id, &method, &params)
            };
            let Some(response) = response else { break };
            if socket
                .send(tungstenite::Message::Text(response.to_string()))
                .is_err()
            {
                break;
            }
        }
        true
    }
}

/// Ends `run`: its answer is the message's last line, or `NO_REPLY` for a
/// message that asks for silence.
pub(super) fn finish(state: &Arc<Mutex<State>>, release: Release, run: &str) {
    let served = Served {
        release,
        token: "",
        behaviour: Behaviour::Answer,
        history: None,
        state: state.clone(),
    };
    let mut state = state.lock().unwrap();
    let Some((key, text)) = state.running.remove(run) else {
        return;
    };
    let steps = state.steps;
    let reply = if text.contains("SILENT") {
        "NO_REPLY".to_string()
    } else {
        format!("Answer: {}", text.lines().last().unwrap_or_default())
    };
    let session = state.sessions.entry(key.clone()).or_default();
    if !at(release, 2026, 5, 26) {
        session.push(served.user_turn(&key, run, &text));
    }
    let mut step = json!({ "role": "assistant", "content": [{ "type": "toolCall", "name": "read" }, { "type": "text", "text": "Looking." }], "stopReason": "toolUse" });
    if at(release, 2026, 8, 1) {
        step["__openclaw"] = json!({ "runId": run });
    }
    let result =
        json!({ "role": "toolResult", "content": [{ "type": "text", "text": "file contents" }] });
    for _ in 0..steps {
        session.push(step.clone());
        session.push(result.clone());
    }
    session.push(served.answer(run, &reply));
    state.finished.insert(run.to_string());
}

impl FakeGateway {
    /// The current release with a fixed `chat.history` answer.
    pub(super) fn start(token: &'static str, behaviour: Behaviour, history: Value) -> FakeGateway {
        FakeGateway::serve(CURRENT, token, behaviour, Some(history))
    }

    /// `release`, keeping a transcript per session.
    pub(super) fn release(release: Release) -> FakeGateway {
        FakeGateway::serve(release, "secret-token", Behaviour::Answer, None)
    }

    /// `release`, behaving as `behaviour`.
    pub(super) fn serve_release(release: Release, behaviour: Behaviour) -> FakeGateway {
        FakeGateway::serve(release, "secret-token", behaviour, None)
    }

    fn serve(
        release: Release,
        token: &'static str,
        behaviour: Behaviour,
        history: Option<Value>,
    ) -> FakeGateway {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, requests) = mpsc::channel();
        let state = Arc::new(Mutex::new(State::default()));
        let served = Served {
            release,
            token,
            behaviour,
            history,
            state: state.clone(),
        };
        let thread = std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { return };
                if !served.serve(stream, &tx) {
                    return;
                }
            }
        });
        FakeGateway {
            port,
            requests,
            state,
            release,
            thread: Some(thread),
        }
    }

    pub(super) fn methods(&self) -> Vec<Value> {
        self.requests.try_iter().collect()
    }

    /// Holds every run started from now on until [`FakeGateway::finish`].
    pub(super) fn hold(&self) {
        self.state.lock().unwrap().hold = true;
    }

    pub(super) fn finish(&self, run: &str) {
        finish(&self.state, self.release, run);
    }

    /// Forgets every running turn and finished run, as a restart does.
    pub(super) fn restart(&self) {
        let mut state = self.state.lock().unwrap();
        // Restart detection compares millisecond timestamps. A fake restart
        // must happen strictly after the runs it forgets, even on a fast runner.
        let last_started = state.started.values().copied().max();
        while last_started.is_some_and(|started| now_ms() <= started) {
            std::thread::sleep(Duration::from_millis(1));
        }
        state.running.clear();
        state.finished.clear();
        state.uptime_ms = 0;
    }

    /// A run the person started in `key` themselves, not through the relay.
    pub(super) fn person_run(&self, key: &str, run: &str) {
        let mut state = self.state.lock().unwrap();
        state.started.insert(key.to_string(), now_ms());
        state.running.insert(
            run.to_string(),
            (key.to_string(), "the person's own".into()),
        );
    }

    pub(super) fn runs(&self) -> Vec<String> {
        self.state.lock().unwrap().runs.clone()
    }
}

impl Drop for FakeGateway {
    fn drop(&mut self) {
        // The accept loop ends when its listener's process does; detach.
        drop(self.thread.take());
    }
}
