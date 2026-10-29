//! A bridge client and the in-process plugins the agent runtime is tested
//! with: sessions, an injector and Agent Relay Cloud, all fakes. No broker,
//! PTY runtime or agent harness is started.

#![allow(dead_code)]

use agent_relay_probe::relay::cloud_session::{CloudAccess, CloudAccount, CloudError};
use agent_relay_probe::relay::inject::{InjectOutcome, Injector};
use agent_relay_probe::relay::managed_sessions::ManagedAuthority;
use agent_relay_probe::relay::sessions::{
    CallerMiss, DiscoveredSession, SessionDirectory, UnreadableSessionFile,
};
use agent_relay_probe::relay::store::Target;
use agent_relay_probe::relay::transport::{CoreReadHalf, CoreStream, CoreWriteHalf};
use futures_util::future::BoxFuture;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

pub const WAIT: Duration = Duration::from_secs(10);

pub struct Client {
    reader: BufReader<CoreReadHalf>,
    writer: CoreWriteHalf,
    next_id: u64,
    pub events: Vec<Value>,
}

impl Client {
    pub async fn connect(socket: &Path) -> Client {
        let stream = CoreStream::connect(socket).await.unwrap();
        let (read, writer) = stream.into_split();
        let mut client = Client {
            reader: BufReader::new(read),
            writer,
            next_id: 0,
            events: Vec::new(),
        };
        let hello = client.call("hello", json!({"bridge_version": 2})).await;
        assert!(hello.get("result").is_some(), "{hello}");
        client
    }

    async fn line(&mut self) -> Option<Value> {
        let mut line = String::new();
        let read = tokio::time::timeout(WAIT, self.reader.read_line(&mut line))
            .await
            .expect("the daemon answers")
            .unwrap();
        (read > 0).then(|| serde_json::from_str(&line).unwrap())
    }

    /// The whole response line.
    pub async fn call(&mut self, method: &str, params: Value) -> Value {
        self.next_id += 1;
        let id = self.next_id;
        let request = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        self.writer
            .write_all(format!("{request}\n").as_bytes())
            .await
            .unwrap();
        loop {
            let line = self.line().await.expect("a response before close");
            if line.get("id") == Some(&json!(id)) {
                return line;
            }
            self.events.push(line);
        }
    }

    /// The result, asserting there was no error.
    pub async fn ok(&mut self, method: &str, params: Value) -> Value {
        let response = self.call(method, params).await;
        assert!(
            response.get("error").is_none(),
            "{method} failed: {response}"
        );
        response["result"].clone()
    }

    /// The error's kind, asserting there was one.
    pub async fn error(&mut self, method: &str, params: Value) -> (String, String) {
        let response = self.call(method, params).await;
        let error = &response["error"];
        assert!(error.is_object(), "{method} succeeded: {response}");
        (
            error["data"]["kind"].as_str().unwrap().to_string(),
            error["message"].as_str().unwrap().to_string(),
        )
    }
}

/// Sessions on a pretend computer: what discovery finds (`.0`), which
/// session each calling pid runs inside (`.1`), the fleet's ownership
/// (`.2`: the owned targets, or the error reading the fleet), the running
/// sessions whose registry file does not parse (`.3`, by the pid calling
/// from inside each), and the live probe-owned authority of each managed
/// target (`.4`).
pub struct FakeSessions(
    pub Mutex<Vec<DiscoveredSession>>,
    pub Mutex<HashMap<i32, DiscoveredSession>>,
    pub Mutex<Result<Vec<Target>, String>>,
    pub Mutex<HashMap<i32, UnreadableSessionFile>>,
    pub Mutex<Vec<(Target, ManagedAuthority)>>,
    /// How long listing the sessions takes: a computer whose discovery waits
    /// on the Codex app or a fleet broker.
    pub Mutex<Duration>,
    /// The targets their provider records as archived.
    pub Mutex<HashSet<Target>>,
    /// Listed sessions that require manual activation.
    pub Mutex<HashSet<Target>>,
);

impl Default for FakeSessions {
    fn default() -> FakeSessions {
        FakeSessions::with(Vec::new())
    }
}

impl FakeSessions {
    pub fn with(sessions: Vec<DiscoveredSession>) -> FakeSessions {
        FakeSessions(
            Mutex::new(sessions),
            Mutex::default(),
            Mutex::new(Ok(Vec::new())),
            Mutex::default(),
            Mutex::default(),
            Mutex::default(),
            Mutex::default(),
            Mutex::default(),
        )
    }

    /// Makes the provider record `target` as archived.
    pub fn archive(&self, target: Target) {
        self.6.lock().unwrap().insert(target);
    }

    /// Makes `pid` a process inside `session`.
    pub fn call_from(&self, pid: i32, session: DiscoveredSession) {
        self.1.lock().unwrap().insert(pid, session);
    }

    /// Makes `pid` a process inside a running session whose registry file
    /// is `file`, which does not parse.
    pub fn call_from_unreadable(&self, pid: i32, file: UnreadableSessionFile) {
        self.3.lock().unwrap().insert(pid, file);
    }
}

impl SessionDirectory for FakeSessions {
    fn sessions(&self) -> Vec<DiscoveredSession> {
        let delay = *self.5.lock().unwrap();
        if !delay.is_zero() {
            std::thread::sleep(delay);
        }
        self.0.lock().unwrap().clone()
    }

    fn auto_activation_sessions(&self) -> Vec<DiscoveredSession> {
        let excluded = self.7.lock().unwrap();
        self.sessions()
            .into_iter()
            .filter(|s| s.live && !excluded.contains(&s.target))
            .collect()
    }

    fn set_title(&self, source: &str, id: &str, title: &str) -> Result<String, String> {
        let mut sessions = self.0.lock().unwrap();
        let session = sessions.iter_mut().find(|s| s.target.kind.source() == source && s.target.id == id)
            .ok_or("session missing")?;
        session.title = title.to_owned();
        Ok(title.to_owned())
    }

    fn archived(&self, targets: &[Target]) -> HashSet<Target> {
        let archived = self.6.lock().unwrap();
        targets
            .iter()
            .filter(|target| archived.contains(*target))
            .cloned()
            .collect()
    }

    fn caller(&self, pid: i32) -> Result<DiscoveredSession, CallerMiss> {
        if let Some(file) = self.3.lock().unwrap().get(&pid) {
            return Err(CallerMiss::Unreadable(file.clone()));
        }
        self.1
            .lock()
            .unwrap()
            .get(&pid)
            .cloned()
            .ok_or(CallerMiss::NotASession)
    }

    fn unreadable_session_files(&self) -> Vec<UnreadableSessionFile> {
        let mut files: Vec<_> = self.3.lock().unwrap().values().cloned().collect();
        files.sort_by_key(|file| file.pid);
        files
    }

    fn fleet_owned(&self, target: &Target) -> Result<bool, String> {
        self.2
            .lock()
            .unwrap()
            .as_ref()
            .map(|owned| owned.contains(target))
            .map_err(Clone::clone)
    }

    fn managed_authority(&self, target: &Target) -> Option<ManagedAuthority> {
        self.4
            .lock()
            .unwrap()
            .iter()
            .find(|(managed, _)| managed == target)
            .map(|(_, authority)| authority.clone())
    }
}

pub fn session(
    kind: agent_relay_probe::relay::store::SessionKind,
    id: &str,
    directory: &str,
) -> DiscoveredSession {
    DiscoveredSession {
        target: Target::new(kind, id),
        title: "Fix tests".into(),
        directory: Some(directory.into()),
        updated_at_ms: None,
        live: true,
        host: None,
        holder: None,
    }
}

#[derive(Clone, Debug)]
pub struct Injected {
    pub target: Target,
    pub message_id: String,
    pub text: String,
}

/// Records every injection; answers with queued outcomes (then
/// `Delivered`). `hold` blocks an injection until released.
#[derive(Default)]
pub struct FakeInjector {
    pub injected: Mutex<Vec<Injected>>,
    pub outcomes: Mutex<VecDeque<InjectOutcome>>,
    pub hint: Mutex<Option<String>>,
    pub note: Mutex<Option<String>>,
    pub answers: Mutex<HashMap<String, String>>,
    pub hold: AtomicBool,
    pub holding: AtomicBool,
    pub cancelled: Mutex<Vec<(Target, String)>>,
    pub codex_stall: Mutex<Option<agent_relay_probe::relay::claude::inbox::InboxStall>>,
}

impl FakeInjector {
    pub fn injected(&self) -> Vec<Injected> {
        self.injected.lock().unwrap().clone()
    }

    pub fn then(&self, outcome: InjectOutcome) {
        self.outcomes.lock().unwrap().push_back(outcome);
    }

    pub fn cancelled(&self) -> Vec<(Target, String)> {
        self.cancelled.lock().unwrap().clone()
    }
}

impl Injector for FakeInjector {
    fn codex_inbox_stall(
        &self,
        _: &Target,
    ) -> Option<agent_relay_probe::relay::claude::inbox::InboxStall> {
        self.codex_stall.lock().unwrap().clone()
    }
    fn inject(&self, target: &Target, message_id: &str, text: &str) -> InjectOutcome {
        self.injected.lock().unwrap().push(Injected {
            target: target.clone(),
            message_id: message_id.into(),
            text: text.into(),
        });
        while self.hold.load(Ordering::SeqCst) {
            self.holding.store(true, Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(5));
        }
        self.holding.store(false, Ordering::SeqCst);
        self.outcomes
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or(InjectOutcome::Delivered)
    }

    fn cancel(&self, target: &Target, message_id: &str) {
        self.cancelled
            .lock()
            .unwrap()
            .push((target.clone(), message_id.into()));
    }

    fn host_note(&self, _: &Target) -> Option<String> {
        self.note.lock().unwrap().clone()
    }

    fn reply_hint(
        &self,
        _: &Target,
        to: Option<&str>,
        address: Option<&str>,
        reply_to: &str,
    ) -> Option<String> {
        self.hint.lock().unwrap().as_ref().map(|hint| {
            format!(
                "{hint} to={} address={} reply_to={reply_to}",
                to.unwrap_or("-"),
                address.unwrap_or("-")
            )
        })
    }

    fn final_answer(&self, _: &Target, message_ref: &str) -> Option<String> {
        self.answers.lock().unwrap().get(message_ref).cloned()
    }
}

/// Agent Relay Cloud for a signed-in person: canned answers by
/// `METHOD path`, every call recorded.
pub struct FakeCloud {
    pub account: Mutex<Option<CloudAccount>>,
    pub answers: Mutex<HashMap<String, Result<Value, CloudError>>>,
    pub calls: Mutex<Vec<(String, String, Option<Value>)>>,
}

impl FakeCloud {
    pub fn new(user_id: &str) -> FakeCloud {
        FakeCloud {
            account: Mutex::new(Some(CloudAccount {
                site_url: "https://agentrelay.com".into(),
                workspace_id: "50587328-441d-4acb-b8f3-dbe1b3c5de99".into(),
                user_id: Some(user_id.into()),
            })),
            answers: Mutex::new(HashMap::new()),
            calls: Mutex::new(Vec::new()),
        }
    }

    pub fn answer(&self, method: &str, path: &str, answer: Result<Value, CloudError>) {
        self.answers
            .lock()
            .unwrap()
            .insert(format!("{method} {path}"), answer);
    }

    pub fn paths(&self) -> Vec<String> {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .map(|(m, p, _)| format!("{m} {p}"))
            .collect()
    }
}

impl CloudAccess for FakeCloud {
    /// A signed-in harness has its install attached.
    fn agent_owner(&self) -> Option<agent_relay_probe::relay::cloud_session::AgentOwner> {
        let account = self.account()?;
        Some(agent_relay_probe::relay::cloud_session::AgentOwner {
            user_id: account.user_id?,
            workspace_id: Some(account.workspace_id),
        })
    }

    fn account(&self) -> Option<CloudAccount> {
        self.account.lock().unwrap().clone()
    }

    fn request(
        &self,
        method: &'static str,
        path: String,
        body: Option<Value>,
    ) -> BoxFuture<'_, Result<Value, CloudError>> {
        self.calls
            .lock()
            .unwrap()
            .push((method.into(), path.clone(), body));
        let answer = self
            .answers
            .lock()
            .unwrap()
            .get(&format!("{method} {path}"))
            .cloned()
            .unwrap_or(Err(CloudError::Status {
                status: 404,
                message: None,
            }));
        Box::pin(async move { answer })
    }
}

/// Polls `condition` until it holds.
pub async fn eventually(what: &str, condition: impl Fn() -> bool) {
    eventually_for(what, WAIT, condition).await;
}

/// Polls `condition` with an explicit margin for integration paths that must
/// cross a daemon restart while the test suite is running in parallel.
pub async fn eventually_for(what: &str, wait: Duration, condition: impl Fn() -> bool) {
    let deadline = tokio::time::Instant::now() + wait;
    while !condition() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out waiting for {what}"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}
