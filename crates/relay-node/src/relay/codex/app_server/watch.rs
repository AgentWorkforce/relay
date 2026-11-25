//! Which chat started each command now running under the shared Codex
//! app-server.
//!
//! Codex's app-server daemon runs every terminal chat's commands as its own
//! children, so a command's ancestry names the daemon, and the daemon holds
//! every one of those chats' writer locks. A command's `CODEX_THREAD_ID`
//! then cannot be checked against the kernel: any chat can set it to
//! another's id. What a chat cannot forge is the identity of a command that
//! another chat is running. Codex gives each command its tool call's id
//! (`CODEX_TOOL_CALL_ID`, the `commandExecution` item's id) and announces it
//! to the chat's subscribers (`item/started`, `item/completed`).
//!
//! This watcher keeps one proxy connection to the daemon. Every client hears
//! each chat's `thread/status/changed`; while a chat is `active` (a turn is
//! running) the watcher subscribes to it with a turns-free `thread/resume`,
//! records the commands it starts, and unsubscribes once the chat is idle.
//! [`runs`] then answers whether a chat is running a command with a given
//! tool call id. Only Codex's read model of a chat's running items is
//! trusted; nothing a command says about itself is.

use super::Client;
use crate::relay::codex::runner::{CodexRunner, ProxyStream, SystemRunner};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// How long the handshake and the first listing may take.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// How long one read waits before the loop checks its retries.
const READ_SLICE: Duration = Duration::from_millis(250);
/// The waits before reconnecting after the proxy failed, longest last.
const RECONNECT: [Duration; 4] = [
    Duration::from_secs(1),
    Duration::from_secs(5),
    Duration::from_secs(15),
    Duration::from_secs(30),
];
/// A chat can turn active before Codex has written its rollout, and a resume
/// then fails ("no rollout found"): the waits before trying again.
const RESUME_RETRY: [Duration; 5] = [
    Duration::from_millis(100),
    Duration::from_millis(250),
    Duration::from_millis(500),
    Duration::from_secs(1),
    Duration::from_secs(2),
];
/// How long [`runs`] waits for a just-started command's announcement, which
/// can reach the watcher a moment after the command itself starts.
pub const ANNOUNCE_WAIT: Duration = Duration::from_millis(1500);
/// The most commands remembered; the oldest go first past it, so a missed
/// completion cannot grow the table without bound.
const MAX_RUNNING: usize = 4096;
/// The first JSON-RPC id the watcher uses (below it are the handshake's).
const FIRST_ID: i64 = 1000;

/// What the watcher knows from one connection to the app-server.
#[derive(Debug, Default)]
pub(crate) struct Watch {
    /// Running commands: tool call id → (thread, when announced).
    running: HashMap<String, (String, Instant)>,
    /// Chats subscribed to, by thread id.
    subscribed: HashSet<String>,
    /// Outstanding resumes: request id → thread.
    resuming: HashMap<i64, String>,
    /// Resumes to try again: thread → (attempt, when).
    retries: HashMap<String, (usize, Instant)>,
    /// Outstanding chat reads made at connect: request id → thread.
    reading: HashMap<i64, String>,
    next_id: i64,
}

impl Watch {
    fn new() -> Watch {
        Watch {
            next_id: FIRST_ID,
            ..Watch::default()
        }
    }

    fn request(&mut self, method: &str, params: Value) -> (i64, Value) {
        let id = self.next_id;
        self.next_id += 1;
        (id, json!({"method": method, "id": id, "params": params}))
    }

    fn resume(&mut self, thread: &str) -> Value {
        let (id, request) = self.request(
            "thread/resume",
            json!({"threadId": thread, "excludeTurns": true}),
        );
        self.resuming.insert(id, thread.to_string());
        request
    }

    fn forget(&mut self, thread: &str) {
        self.running.retain(|_, (owner, _)| owner != thread);
        self.retries.remove(thread);
    }

    /// The requests that start watching: a read of each loaded chat, so one
    /// already mid-turn is subscribed to.
    pub(crate) fn on_loaded(&mut self, loaded: &[String]) -> Vec<Value> {
        loaded
            .iter()
            .map(|thread| {
                let (id, request) = self.request("thread/read", json!({"threadId": thread}));
                self.reading.insert(id, thread.to_lowercase());
                request
            })
            .collect()
    }

    /// Applies one message from the app-server; the requests it calls for.
    pub(crate) fn on_message(&mut self, message: &Value, now: Instant) -> Vec<Value> {
        if let Some(id) = message["id"]
            .as_i64()
            .filter(|_| message.get("method").is_none())
        {
            return self.on_response(id, message, now);
        }
        let params = &message["params"];
        match message["method"].as_str() {
            Some("thread/status/changed") => {
                let Some(thread) = thread_id(&params["threadId"]) else {
                    return Vec::new();
                };
                match params["status"]["type"].as_str() {
                    Some("active") if !self.subscribed.contains(&thread) => {
                        self.retries.remove(&thread);
                        vec![self.resume(&thread)]
                    }
                    Some("idle" | "notLoaded" | "systemError") => {
                        self.forget(&thread);
                        if self.subscribed.remove(&thread) {
                            vec![
                                self.request("thread/unsubscribe", json!({"threadId": thread}))
                                    .1,
                            ]
                        } else {
                            Vec::new()
                        }
                    }
                    _ => Vec::new(),
                }
            }
            Some("thread/closed" | "thread/archived") => {
                if let Some(thread) = thread_id(&params["threadId"]) {
                    self.forget(&thread);
                    self.subscribed.remove(&thread);
                }
                Vec::new()
            }
            Some(method @ ("item/started" | "item/completed")) => {
                let item = &params["item"];
                let (Some(thread), Some(call)) = (
                    thread_id(&params["threadId"]),
                    item["id"].as_str().filter(|id| is_call_id(id)),
                ) else {
                    return Vec::new();
                };
                if item["type"] != "commandExecution" {
                    return Vec::new();
                }
                if method == "item/started" && item["status"] == "inProgress" {
                    if self.running.len() >= MAX_RUNNING {
                        if let Some(oldest) = self
                            .running
                            .iter()
                            .min_by_key(|(_, (_, at))| *at)
                            .map(|(call, _)| call.clone())
                        {
                            self.running.remove(&oldest);
                        }
                    }
                    self.running.insert(call.to_string(), (thread, now));
                } else {
                    self.running.remove(call);
                }
                Vec::new()
            }
            _ => Vec::new(),
        }
    }

    fn on_response(&mut self, id: i64, response: &Value, now: Instant) -> Vec<Value> {
        let failed = response.get("error").is_some_and(|error| !error.is_null());
        if let Some(thread) = self.reading.remove(&id) {
            let active = response["result"]["thread"]["status"]["type"] == "active";
            return if !failed && active && !self.subscribed.contains(&thread) {
                vec![self.resume(&thread)]
            } else {
                Vec::new()
            };
        }
        let Some(thread) = self.resuming.remove(&id) else {
            return Vec::new();
        };
        if !failed {
            self.retries.remove(&thread);
            self.subscribed.insert(thread);
            return Vec::new();
        }
        let attempt = self
            .retries
            .get(&thread)
            .map_or(0, |(attempt, _)| attempt + 1);
        if let Some(wait) = RESUME_RETRY.get(attempt) {
            self.retries.insert(thread, (attempt, now + *wait));
        } else {
            self.retries.remove(&thread);
        }
        Vec::new()
    }

    /// The resumes whose wait has passed.
    pub(crate) fn due(&mut self, now: Instant) -> Vec<Value> {
        let due: Vec<String> = self
            .retries
            .iter()
            .filter(|(thread, (_, at))| *at <= now && !self.subscribed.contains(*thread))
            .map(|(thread, _)| thread.clone())
            .collect();
        due.iter()
            .map(|thread| {
                // Keep the attempt count: a failure counts on from it.
                if let Some((_, at)) = self.retries.get_mut(thread) {
                    *at = now + Duration::from_secs(3600);
                }
                self.resume(thread)
            })
            .collect()
    }

    pub(crate) fn runs(&self, thread: &str, call: &str) -> bool {
        self.running
            .get(call)
            .is_some_and(|(owner, _)| owner.eq_ignore_ascii_case(thread))
    }
}

fn thread_id(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::to_lowercase)
        .filter(|id| crate::relay::store::is_uuid(id))
}

/// A tool call id as Codex writes one: short, and nothing but letters,
/// digits, `-` and `_`.
pub fn is_call_id(id: &str) -> bool {
    (1..=128).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// The watcher shared by every caller lookup in this process.
struct Shared {
    /// What the current connection knows; `None` while disconnected.
    watch: Mutex<Option<Watch>>,
    /// Signalled whenever the watch changes.
    changed: Condvar,
    /// The Codex to run `app-server proxy` with, and its homes.
    target: Mutex<Option<Target>>,
}

#[derive(Clone, PartialEq, Eq)]
struct Target {
    executable: PathBuf,
    home: PathBuf,
    sqlite_home: PathBuf,
}

fn shared() -> &'static Arc<Shared> {
    static SHARED: OnceLock<Arc<Shared>> = OnceLock::new();
    SHARED.get_or_init(|| {
        Arc::new(Shared {
            watch: Mutex::new(None),
            changed: Condvar::new(),
            target: Mutex::new(None),
        })
    })
}

/// Starts the watcher once, and points it at `executable` (a trusted Codex)
/// with Codex's `home` and `sqlite_home`. Called by discovery whenever chats
/// share an app-server, so the watcher runs before their commands do.
pub fn ensure(executable: &Path, home: &Path, sqlite_home: &Path) {
    // Tests seed the watch (`seed`) and never reach a real app-server.
    if cfg!(test) {
        return;
    }
    static STARTED: OnceLock<()> = OnceLock::new();
    let shared = shared();
    let target = Target {
        executable: executable.to_path_buf(),
        home: home.to_path_buf(),
        sqlite_home: sqlite_home.to_path_buf(),
    };
    {
        let mut current = shared.target.lock().unwrap_or_else(|e| e.into_inner());
        if current.as_ref() != Some(&target) {
            *current = Some(target);
        }
    }
    STARTED.get_or_init(|| {
        let shared = Arc::clone(shared);
        let spawned = std::thread::Builder::new()
            .name("codex-command-watch".into())
            .spawn(move || run(&shared, &SystemRunner));
        if let Err(error) = spawned {
            crate::relay::diagnostics::write(format_args!(
                "codex command watch did not start: {error}"
            ));
        }
    });
}

/// Whether the shared app-server reports `thread` running a command whose
/// tool call id is `call` now, waiting up to `wait` for its announcement.
/// False while the watcher is not connected.
pub fn runs(thread: &str, call: &str, wait: Duration) -> bool {
    if !is_call_id(call) {
        return false;
    }
    let shared = shared();
    let deadline = Instant::now() + wait;
    let mut watch = shared.watch.lock().unwrap_or_else(|e| e.into_inner());
    loop {
        if watch.as_ref().is_some_and(|w| w.runs(thread, call)) {
            return true;
        }
        let now = Instant::now();
        if now >= deadline {
            return false;
        }
        watch = shared
            .changed
            .wait_timeout(watch, deadline - now)
            .unwrap_or_else(|e| e.into_inner())
            .0;
    }
}

/// Test only: the watch as connected and reporting `thread` running `call`.
#[cfg(test)]
pub(crate) fn seed(thread: &str, call: &str) {
    let shared = shared();
    let mut watch = shared.watch.lock().unwrap_or_else(|e| e.into_inner());
    watch
        .get_or_insert_with(Watch::new)
        .running
        .insert(call.to_string(), (thread.to_lowercase(), Instant::now()));
    shared.changed.notify_all();
}

fn run(shared: &Shared, runner: &dyn CodexRunner) {
    let mut failures = 0usize;
    loop {
        let target = shared
            .target
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let outcome = match target {
            Some(target) => runner
                .proxy_in_home(&target.executable, &target.home, &target.sqlite_home)
                .and_then(|mut stream| watch_until_closed(shared, stream.as_mut(), &mut failures)),
            None => Err(io::Error::new(ErrorKind::NotFound, "no Codex to ask")),
        };
        *shared.watch.lock().unwrap_or_else(|e| e.into_inner()) = None;
        shared.changed.notify_all();
        if let Err(error) = outcome {
            if failures == 0 {
                crate::relay::diagnostics::write(format_args!(
                    "codex command watch disconnected: {:?}",
                    error.kind()
                ));
            }
        }
        std::thread::sleep(RECONNECT[failures.min(RECONNECT.len() - 1)]);
        failures += 1;
    }
}

/// Watches over one proxy connection until it fails.
fn watch_until_closed(
    shared: &Shared,
    stream: &mut dyn ProxyStream,
    failures: &mut usize,
) -> io::Result<()> {
    let deadline = Instant::now() + CONNECT_TIMEOUT;
    let mut client = Client::open(stream, deadline)?;
    let loaded = client.loaded(deadline)?;
    let mut watch = Watch::new();
    let loaded: Vec<String> = loaded.into_iter().collect();
    for request in watch.on_loaded(&loaded) {
        client.send(&request, deadline)?;
    }
    *shared.watch.lock().unwrap_or_else(|e| e.into_inner()) = Some(watch);
    *failures = 0;
    crate::relay::diagnostics::write(format_args!(
        "codex command watch connected: {} loaded chats",
        loaded.len()
    ));
    loop {
        match client.read(Instant::now() + READ_SLICE) {
            Ok(()) => {}
            Err(error) if error.kind() == ErrorKind::TimedOut => {}
            Err(error) => return Err(error),
        }
        let messages: Vec<Value> = client
            .responses
            .drain(..)
            .chain(client.notifications.drain(..))
            .collect();
        // Server requests (approvals) are never this watcher's to answer.
        client.requests.clear();
        let now = Instant::now();
        let outgoing = {
            let mut guard = shared.watch.lock().unwrap_or_else(|e| e.into_inner());
            let Some(watch) = guard.as_mut() else {
                return Err(io::Error::other("the watch was reset"));
            };
            let mut outgoing: Vec<Value> = messages
                .iter()
                .flat_map(|message| watch.on_message(message, now))
                .collect();
            outgoing.extend(watch.due(now));
            outgoing
        };
        if !messages.is_empty() {
            shared.changed.notify_all();
        }
        let send_by = Instant::now() + Duration::from_secs(5);
        for request in outgoing {
            client.send(&request, send_by)?;
        }
    }
}

#[cfg(test)]
mod tests;
