//! Which chat started each command now running under the shared Codex
//! app-server, and which process that command is.
//!
//! Codex's app-server daemon runs every terminal chat's commands as its own
//! children, so a command's ancestry names the daemon, and the daemon holds
//! every one of those chats' writer locks. A command's `CODEX_THREAD_ID`
//! then cannot be checked against the kernel: any chat can set it to
//! another's id, and can copy another chat's `CODEX_TOOL_CALL_ID` too, since
//! same-user processes can read each other's environment.
//!
//! What no chat can forge is the process the app-server itself started for a
//! command. Only the app-server makes its own direct children, and only for a
//! chat's tool call; Codex announces each such command to the chat's
//! subscribers (`item/started`: its tool call id, its command line and when
//! it started). So a caller is vouched for only when its ancestor directly
//! under the app-server runs exactly the announced command line, started
//! when it was announced, and is the one process that command has vouched for
//! (the first to ask binds it).
//!
//! The watcher keeps one proxy connection to the daemon. Every client hears
//! each chat's `thread/status/changed`; the watcher subscribes to a chat
//! (turns-free `thread/resume`) when it starts or turns active and stays
//! subscribed while it is loaded, so a new turn's first command is never
//! missed. It forgets a chat once Codex unloads, closes or archives it.

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
/// How long one read waits before the loop checks its retries and target.
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
/// How long [`vouch`] waits for a just-started command's announcement, which
/// can reach the watcher a moment after the command itself starts.
pub const ANNOUNCE_WAIT: Duration = Duration::from_millis(1500);
/// How far apart the process's kernel start time and the announced start may
/// be. Linux reads its boot time in whole seconds, so this allows for that.
const START_SKEW_MS: i64 = 3_000;
/// The most commands remembered; the oldest go first past it, so a missed
/// completion cannot grow the table without bound.
const MAX_RUNNING: usize = 4096;
/// The first JSON-RPC id the watcher uses (below it are the handshake's).
const FIRST_ID: i64 = 1000;

/// One running command, as the app-server announced it.
#[derive(Debug, Clone)]
struct Announced {
    thread: String,
    /// The command line Codex ran, split as a shell would.
    argv: Vec<String>,
    /// When Codex started it, in milliseconds since the epoch.
    started_ms: i64,
    /// The process (pid, kernel start) it vouched for first.
    bound: Option<(i32, u64)>,
    /// When the watcher heard of it, to drop the oldest first.
    heard: Instant,
}

/// The caller's ancestor directly under the app-server, as the kernel shows
/// it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Spawned {
    pub pid: i32,
    /// The kernel's start value (`ProcessInfo::start`).
    pub start: u64,
    /// The same, in milliseconds since the epoch.
    pub start_ms: i64,
    pub argv: Vec<String>,
}

/// What the watcher knows from one connection to the app-server.
#[derive(Debug, Default)]
pub(crate) struct Watch {
    /// Running commands by tool call id.
    running: HashMap<String, Announced>,
    /// Chats subscribed to, by thread id.
    subscribed: HashSet<String>,
    /// Outstanding resumes: request id → thread.
    resuming: HashMap<i64, String>,
    /// Resumes to try again: thread → (attempt, when).
    retries: HashMap<String, (usize, Instant)>,
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

    /// Subscribes to `thread` unless already subscribed or subscribing.
    fn follow(&mut self, thread: &str) -> Vec<Value> {
        if self.subscribed.contains(thread) || self.resuming.values().any(|t| t == thread) {
            return Vec::new();
        }
        self.retries.remove(thread);
        vec![self.resume(thread)]
    }

    fn forget(&mut self, thread: &str) {
        self.running.retain(|_, command| command.thread != thread);
        self.retries.remove(thread);
    }

    /// The requests that start watching: each loaded chat is subscribed to.
    pub(crate) fn on_loaded(&mut self, loaded: &[String]) -> Vec<Value> {
        loaded
            .iter()
            .filter_map(|thread| thread_id(&Value::from(thread.as_str())))
            .flat_map(|thread| self.follow(&thread))
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
            Some("thread/started") => thread_id(&params["thread"]["id"])
                .map(|thread| self.follow(&thread))
                .unwrap_or_default(),
            Some("thread/status/changed") => {
                let Some(thread) = thread_id(&params["threadId"]) else {
                    return Vec::new();
                };
                match params["status"]["type"].as_str() {
                    Some("active") => self.follow(&thread),
                    // A finished turn's commands are over; the chat stays
                    // followed so its next turn's first command is heard.
                    Some("idle") => {
                        self.running.retain(|_, command| command.thread != thread);
                        Vec::new()
                    }
                    Some("notLoaded" | "systemError") => {
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
                if method == "item/completed" || item["status"] != "inProgress" {
                    self.running.remove(call);
                    return Vec::new();
                }
                let started_ms = item["startedAtMs"]
                    .as_i64()
                    .or_else(|| params["startedAtMs"].as_i64());
                let argv = item["command"]
                    .as_str()
                    .and_then(|line| shell_words::split(line).ok())
                    .filter(|argv| !argv.is_empty());
                let (Some(started_ms), Some(argv)) = (started_ms, argv) else {
                    return Vec::new();
                };
                if self.running.len() >= MAX_RUNNING {
                    if let Some(oldest) = self
                        .running
                        .iter()
                        .min_by_key(|(_, command)| command.heard)
                        .map(|(call, _)| call.clone())
                    {
                        self.running.remove(&oldest);
                    }
                }
                self.running.insert(
                    call.to_string(),
                    Announced {
                        thread,
                        argv,
                        started_ms,
                        bound: None,
                        heard: now,
                    },
                );
                Vec::new()
            }
            _ => Vec::new(),
        }
    }

    fn on_response(&mut self, id: i64, response: &Value, now: Instant) -> Vec<Value> {
        let failed = response.get("error").is_some_and(|error| !error.is_null());
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

    /// Whether `thread` is running the command `call` and `spawned` is the
    /// process the app-server started for it. The first process to match
    /// binds the command; any other is refused from then on.
    pub(crate) fn vouch(&mut self, thread: &str, call: &str, spawned: &Spawned) -> bool {
        let Some(command) = self.running.get_mut(call) else {
            return false;
        };
        let matches = command.thread.eq_ignore_ascii_case(thread)
            && (spawned.start_ms - command.started_ms).abs() <= START_SKEW_MS
            && runs_command(&command.argv, &spawned.argv);
        if !matches {
            return false;
        }
        match command.bound {
            None => {
                command.bound = Some((spawned.pid, spawned.start));
                true
            }
            Some(bound) => bound == (spawned.pid, spawned.start),
        }
    }

    #[cfg(test)]
    pub(crate) fn knows(&self, call: &str) -> bool {
        self.running.contains_key(call)
    }
}

/// Whether a process running `argv` is the command Codex announced as
/// `announced`. Codex runs a command as `<shell> -lc <script>`; the process
/// is that shell (which may show `-c` for `-lc`), or, when the shell replaced
/// itself with a lone simple command, that command's own words.
pub fn runs_command(announced: &[String], argv: &[String]) -> bool {
    if announced.is_empty() || argv.is_empty() {
        return false;
    }
    if announced == argv {
        return true;
    }
    let [shell, flag, script] = announced else {
        return false;
    };
    if !matches!(flag.as_str(), "-c" | "-lc") {
        return false;
    }
    let name = |path: &str| path.rsplit('/').next().unwrap_or(path).to_string();
    let as_shell = argv.len() >= 3
        && name(&argv[0]) == name(shell)
        && matches!(argv[argv.len() - 2].as_str(), "-c" | "-lc")
        && argv[argv.len() - 1] == *script;
    as_shell || shell_words::split(script).is_ok_and(|words| words == argv)
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

fn current_target(shared: &Shared) -> Option<Target> {
    shared
        .target
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
}

/// Starts the watcher once, and points it at `executable` (the shared
/// app-server's own, trusted) with Codex's `home` and `sqlite_home`; a
/// different target makes it reconnect. Called by discovery whenever chats
/// share an app-server, so the watcher runs before their commands do.
pub fn ensure(executable: &Path, home: &Path, sqlite_home: &Path) {
    // Tests seed the watch (`seed`) and never reach a real app-server.
    if cfg!(test) {
        return;
    }
    static STARTED: OnceLock<()> = OnceLock::new();
    let shared = shared();
    *shared.target.lock().unwrap_or_else(|e| e.into_inner()) = Some(Target {
        executable: executable.to_path_buf(),
        home: home.to_path_buf(),
        sqlite_home: sqlite_home.to_path_buf(),
    });
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

/// Whether the shared app-server reports `thread` running the command whose
/// tool call id is `call`, and `spawned` is the process it started for it
/// (see [`Watch::vouch`]), waiting up to `wait` for the announcement. False
/// while the watcher is not connected.
pub fn vouch(thread: &str, call: &str, spawned: &Spawned, wait: Duration) -> bool {
    if !is_call_id(call) {
        return false;
    }
    let shared = shared();
    let deadline = Instant::now() + wait;
    let mut watch = shared.watch.lock().unwrap_or_else(|e| e.into_inner());
    loop {
        if let Some(current) = watch.as_mut() {
            if current.running.contains_key(call) {
                return current.vouch(thread, call, spawned);
            }
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

/// Test only: the watch as connected and reporting `thread` running `call`
/// as `argv`, started at `started_ms`.
#[cfg(test)]
pub(crate) fn seed(thread: &str, call: &str, argv: &[&str], started_ms: i64) {
    let shared = shared();
    let mut watch = shared.watch.lock().unwrap_or_else(|e| e.into_inner());
    watch.get_or_insert_with(Watch::new).running.insert(
        call.to_string(),
        Announced {
            thread: thread.to_lowercase(),
            argv: argv.iter().map(|word| word.to_string()).collect(),
            started_ms,
            bound: None,
            heard: Instant::now(),
        },
    );
    shared.changed.notify_all();
}

fn run(shared: &Shared, runner: &dyn CodexRunner) {
    let mut failures = 0usize;
    loop {
        let outcome = match current_target(shared) {
            Some(target) => runner
                .proxy_in_home(&target.executable, &target.home, &target.sqlite_home)
                .and_then(|mut stream| {
                    watch_until_closed(shared, stream.as_mut(), &target, &mut failures)
                }),
            None => Err(io::Error::new(ErrorKind::NotFound, "no Codex to ask")),
        };
        *shared.watch.lock().unwrap_or_else(|e| e.into_inner()) = None;
        shared.changed.notify_all();
        let retarget = matches!(&outcome, Err(error) if error.kind() == ErrorKind::Interrupted);
        if let Err(error) = outcome {
            if failures == 0 && !retarget {
                crate::relay::diagnostics::write(format_args!(
                    "codex command watch disconnected: {:?}",
                    error.kind()
                ));
            }
        }
        if retarget {
            failures = 0;
            continue;
        }
        std::thread::sleep(RECONNECT[failures.min(RECONNECT.len() - 1)]);
        failures += 1;
    }
}

/// Watches over one proxy connection until it fails, or until the target
/// changes (`Interrupted`, so the caller reconnects at once).
fn watch_until_closed(
    shared: &Shared,
    stream: &mut dyn ProxyStream,
    target: &Target,
    failures: &mut usize,
) -> io::Result<()> {
    let deadline = Instant::now() + CONNECT_TIMEOUT;
    let mut client = Client::open(stream, deadline)?;
    let loaded: Vec<String> = client.loaded(deadline)?.into_iter().collect();
    let mut watch = Watch::new();
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
        if current_target(shared).as_ref() != Some(target) {
            return Err(io::Error::new(
                ErrorKind::Interrupted,
                "the shared app-server changed",
            ));
        }
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
