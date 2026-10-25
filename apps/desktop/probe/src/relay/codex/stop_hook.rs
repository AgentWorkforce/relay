//! Agent Relay's Codex Stop hook, which makes relayed messages visible in
//! Conductor's Codex chats.
//!
//! Conductor (conductor.build) listens to a Codex thread only for a turn it
//! started, and stops at that turn's `turn/completed`. A message
//! `codex queue` delivers becomes a turn of its own, which Conductor never
//! records: the agent answers, but the chat shows nothing. Codex runs its
//! Stop hooks as a turn is about to end, and a hook that answers
//! `{"decision": "block", "reason": <text>}` makes Codex go on with that text
//! in the same turn (verified with Codex 0.159), so the reply lands inside
//! the turn Conductor is showing.
//!
//! So for a Conductor chat that is working, the router holds a relayed
//! message here (`hold`) and the hook hands it over as the turn ends
//! (`answer`). One that arrives while the chat is idle is still delivered at
//! once through the queue, and noted (`note_unseen`): at the end of the
//! chat's next turn the hook asks the agent to show those messages and its
//! answers, without acting on them again.
//!
//! The hook runs `agent-relay-probe relay codex-stop-hook`, which hands its
//! input to the relay-send socket (`POST /codex/stop-hook`). The socket
//! answers only a caller whose nearest trusted Codex holds the named
//! thread's writer lock, so a process can collect only its own thread's
//! messages. The setting `codex_stop_hook` adds the hook to
//! `~/.codex/hooks.json` and trusts it through Codex's own app-server
//! (`hooks/list`, `config/value/write`).

use crate::relay::conductor;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};

/// The setting that adds and removes the hook.
pub const SETTING: &str = "codex_stop_hook";

/// The subcommand the hook runs; also how the hook is recognized as ours.
pub const SUBCOMMAND: &str = "relay codex-stop-hook";

/// What a waiting relay message says about the chat it is for.
pub const HELD: &str = "Waiting — handed over when the Conductor chat's turn ends";

/// The most idle deliveries one recap shows.
const RECAP_LIMIT: usize = 10;

/// How long Codex's app-server is given to list or trust hooks.
const APP_SERVER_TIMEOUT: Duration = Duration::from_secs(15);

/// A relayed message waiting for its chat's turn to end.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Held {
    message_id: String,
    text: String,
}

/// A message delivered while its chat was idle, not yet shown in it.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Unseen {
    message_ref: String,
    text: String,
}

#[derive(Default)]
struct State {
    /// By lowercase thread id.
    held: HashMap<String, VecDeque<Held>>,
    /// Handed over by the hook, by message id, with when.
    taken: HashMap<String, Instant>,
    /// By lowercase thread id.
    unseen: HashMap<String, Vec<Unseen>>,
}

/// Messages for Conductor's Codex chats, between the router and the hook.
/// Kept in memory: a held message is also still in the delivery queue, so
/// after a restart its next delivery attempt holds it again.
#[derive(Default)]
pub struct StopHookInbox {
    /// Whether the hook is installed and trusted, so holding a message
    /// cannot leave it waiting for a hook that never runs.
    ready: AtomicBool,
    state: Mutex<State>,
}

impl StopHookInbox {
    pub fn set_ready(&self, ready: bool) {
        self.ready.store(ready, Ordering::SeqCst);
    }

    pub fn is_ready(&self) -> bool {
        self.ready.load(Ordering::SeqCst)
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    /// Holds `text` for `thread`'s Stop hook; once per message.
    pub fn hold(&self, thread: &str, message_id: &str, text: &str) {
        let mut state = self.state();
        if state.taken.contains_key(message_id) {
            return;
        }
        let queue = state.held.entry(thread.to_lowercase()).or_default();
        if !queue.iter().any(|held| held.message_id == message_id) {
            queue.push_back(Held {
                message_id: message_id.to_string(),
                text: text.to_string(),
            });
        }
    }

    pub fn is_held(&self, message_id: &str) -> bool {
        self.state()
            .held
            .values()
            .any(|queue| queue.iter().any(|held| held.message_id == message_id))
    }

    /// When the hook handed `message_id` over, if it did.
    pub fn taken_at(&self, message_id: &str) -> Option<Instant> {
        self.state().taken.get(message_id).copied()
    }

    /// Takes `message_id` back for another route when the hook has not
    /// handed it over; `true` when it was still held.
    pub fn withdraw(&self, message_id: &str) -> bool {
        let mut state = self.state();
        let mut found = false;
        for queue in state.held.values_mut() {
            let before = queue.len();
            queue.retain(|held| held.message_id != message_id);
            found |= queue.len() != before;
        }
        state.held.retain(|_, queue| !queue.is_empty());
        found
    }

    /// Drops every trace of a cancelled message: held, handed over or noted.
    pub fn cancel(&self, message_id: &str) {
        self.forget(message_id);
        let message_ref = crate::relay::delivery::policy::MessageRef::of(message_id);
        let mut state = self.state();
        for unseen in state.unseen.values_mut() {
            unseen.retain(|item| item.message_ref != message_ref);
        }
        state.unseen.retain(|_, unseen| !unseen.is_empty());
    }

    /// Forgets a message once it is delivered.
    pub fn forget(&self, message_id: &str) {
        self.withdraw(message_id);
        self.state().taken.remove(message_id);
    }

    /// Notes a message delivered while `thread`'s chat was idle, for the
    /// recap at the end of its next turn. The hook does not show messages it
    /// handed over itself, so they are never noted.
    pub fn note_unseen(&self, thread: &str, message_id: &str, text: &str) {
        let mut state = self.state();
        if state.taken.contains_key(message_id) {
            return;
        }
        let message_ref = crate::relay::delivery::policy::MessageRef::of(message_id);
        let unseen = state.unseen.entry(thread.to_lowercase()).or_default();
        if unseen.iter().all(|item| item.message_ref != message_ref) {
            unseen.push(Unseen {
                message_ref,
                text: text.to_string(),
            });
            let excess = unseen.len().saturating_sub(RECAP_LIMIT);
            unseen.drain(..excess);
        }
    }

    fn take_held(&self, thread: &str) -> Option<Held> {
        let mut state = self.state();
        let thread = thread.to_lowercase();
        let held = state.held.get_mut(&thread)?.pop_front()?;
        if state.held.get(&thread).is_some_and(VecDeque::is_empty) {
            state.held.remove(&thread);
        }
        state.taken.insert(held.message_id.clone(), Instant::now());
        state
            .taken
            .retain(|_, at| at.elapsed() < Duration::from_secs(60 * 60));
        Some(held)
    }

    /// The idle deliveries for `thread` that have an answer recorded, each
    /// with it; the others stay for a later turn, until Codex records them.
    fn take_answered(
        &self,
        thread: &str,
        reply: &dyn Fn(&str) -> Option<String>,
    ) -> Vec<(Unseen, String)> {
        let thread = thread.to_lowercase();
        let pending = self.state().unseen.remove(&thread).unwrap_or_default();
        let mut answered = Vec::new();
        let mut waiting = Vec::new();
        for item in pending {
            match reply(&item.message_ref)
                .map(|answer| answer.trim().to_string())
                .filter(|answer| !answer.is_empty())
            {
                Some(answer) => answered.push((item, answer)),
                None => waiting.push(item),
            }
        }
        if !waiting.is_empty() {
            let mut state = self.state();
            let unseen = state.unseen.entry(thread).or_default();
            for item in waiting {
                if unseen
                    .iter()
                    .all(|other| other.message_ref != item.message_ref)
                {
                    unseen.push(item);
                }
            }
        }
        answered
    }

    /// The hook's answer for `thread`: the next held message, else (once per
    /// turn, on its first stop) a recap of idle deliveries the agent has
    /// answered, else nothing. `reply` finds the agent's answer to a message
    /// by its ref.
    ///
    /// `shown` is whether Conductor shows the ending turn: a turn a relayed
    /// message started (a `codex queue` delivery) is not shown, so nothing
    /// is handed over at its end, and what waits stays for a turn that is.
    pub fn answer(
        &self,
        thread: &str,
        stop_hook_active: bool,
        shown: bool,
        recorded: &dyn Fn(&str) -> bool,
        reply: &dyn Fn(&str) -> Option<String>,
    ) -> Value {
        if !shown {
            return json!({});
        }
        // A message Codex already recorded was handed over before (a
        // restart forgets that), so it is dropped, never handed over twice.
        while let Some(held) = self.take_held(thread) {
            let message_ref = crate::relay::delivery::policy::MessageRef::of(&held.message_id);
            if !recorded(&message_ref) {
                return block(&with_quote_note(&held.text));
            }
        }
        if stop_hook_active {
            return json!({});
        }
        let answered = self.take_answered(thread, reply);
        if answered.is_empty() {
            return json!({});
        }
        block(&recap(&answered))
    }
}

fn block(reason: &str) -> Value {
    json!({"decision": "block", "reason": reason})
}

/// `text` with Conductor's quote note after its header lines, unless it has
/// it: Conductor shows the agent's reply but not the hook's message.
fn with_quote_note(text: &str) -> String {
    if text.contains(conductor::QUOTE_NOTE) {
        return text.to_string();
    }
    let mut lines: Vec<&str> = text.lines().collect();
    let header = lines
        .iter()
        .take_while(|line| line.starts_with('['))
        .count();
    lines.insert(header, conductor::QUOTE_NOTE);
    lines.join("\n")
}

/// What the hook asks the agent to show at the end of a turn: messages
/// relayed while the chat was idle, which Conductor did not show, each with
/// the answer the agent already gave.
fn recap(answered: &[(Unseen, String)]) -> String {
    let mut text = String::from(
        "[Agent Relay: while this chat was idle, these messages arrived through Agent Relay and \
         you already answered them. The person cannot see them in Conductor's chat. Show each one \
         as a Markdown blockquote, followed by one line summarizing your answer. Do not act on \
         them again.]",
    );
    for (index, (item, answer)) in answered.iter().enumerate() {
        text.push_str(&format!(
            "\n\n{}. Message:\n{}\n\nYour answer:\n{}",
            index + 1,
            item.text.trim(),
            answer
        ));
    }
    text
}

/// Trusts the hook running a command in a Codex home.
type Trust = Box<dyn Fn(&Path, &str) -> Result<(), String> + Send + Sync>;

/// Adds, trusts and removes the hook in a Codex home.
pub struct CodexStopHookSettings {
    /// `~/.codex`.
    codex_home: PathBuf,
    /// Conductor's application data, whose presence shows the row.
    conductor_data: PathBuf,
    /// The shell command the hook runs.
    command: String,
    inbox: std::sync::Arc<StopHookInbox>,
    trust: Trust,
    /// Whether the start-up refresh (or a change) has run, so a hook not
    /// yet trusted again is still reported as on until it has.
    checked: AtomicBool,
}

impl CodexStopHookSettings {
    pub fn new(
        codex_home: PathBuf,
        conductor_data: PathBuf,
        command: String,
        inbox: std::sync::Arc<StopHookInbox>,
    ) -> CodexStopHookSettings {
        CodexStopHookSettings {
            codex_home,
            conductor_data,
            command,
            inbox,
            trust: Box::new(trust_with_app_server),
            checked: AtomicBool::new(false),
        }
    }

    /// The shell command for `executable`, with `--dev` for Agent Relay Dev.
    pub fn command_for(executable: &Path, development: bool) -> String {
        let mut command = format!("{} {SUBCOMMAND}", quoted_program(executable));
        if development {
            command.push_str(" --dev");
        }
        command
    }

    #[cfg(test)]
    fn with_trust(
        mut self,
        trust: impl Fn(&Path, &str) -> Result<(), String> + Send + Sync + 'static,
    ) -> Self {
        self.trust = Box::new(trust);
        self
    }

    fn hooks_file(&self) -> PathBuf {
        self.codex_home.join("hooks.json")
    }

    /// Whether Conductor has run here and Codex has a home: only then is
    /// there a chat this hook could help.
    pub fn applies(&self) -> bool {
        self.conductor_data.is_dir() && self.codex_home.is_dir()
    }

    fn read(&self) -> Result<Value, String> {
        match std::fs::read(self.hooks_file()) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|_| "~/.codex/hooks.json is not valid JSON.".to_string()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
            Err(_) => Err("~/.codex/hooks.json cannot be read.".into()),
        }
    }

    /// Writes `value` atomically, keeping the file's mode, and the first
    /// time a copy of the file as it was beside it.
    fn write(&self, value: &Value) -> Result<(), String> {
        let path = crate::relay::claude_settings::resolve_symlinks(&self.hooks_file());
        let existing = std::fs::read(&path).ok();
        let mut bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
        bytes.push(b'\n');
        crate::relay::claude_settings::write_keeping_file(
            &path,
            existing.as_deref(),
            &bytes,
            ".relay-desktop-backup",
            0o644,
        )
        .map_err(|_| "~/.codex/hooks.json cannot be written.".to_string())
    }

    /// Whether `command` is this build's hook, in any version: Agent Relay
    /// and Agent Relay Dev (`--dev`) each have their own.
    fn is_ours(&self, command: &str) -> bool {
        let development = |command: &str| command.trim_end().ends_with(" --dev");
        command.contains(SUBCOMMAND) && development(command) == development(&self.command)
    }

    fn our_commands<'a>(&self, groups: &'a [Value]) -> Vec<&'a str> {
        groups
            .iter()
            .flat_map(|group| group["hooks"].as_array().into_iter().flatten())
            .filter_map(|hook| hook["command"].as_str())
            .filter(|command| self.is_ours(command))
            .collect()
    }

    /// Removes this build's hooks from `groups`, and any group that held only
    /// them; others' hooks stay where they are. Whether anything changed.
    fn take_out(&self, groups: &mut Vec<Value>) -> bool {
        let before = groups.clone();
        for group in groups.iter_mut() {
            if let Some(hooks) = group["hooks"].as_array_mut() {
                hooks.retain(|hook| !hook["command"].as_str().is_some_and(|c| self.is_ours(c)));
            }
        }
        groups.retain(|group| {
            group["hooks"]
                .as_array()
                .is_none_or(|hooks| !hooks.is_empty())
        });
        *groups != before
    }

    fn entry(&self) -> Value {
        json!({"hooks": [{"type": "command", "command": self.command, "timeout": 10}]})
    }

    pub fn hook_enabled(&self) -> bool {
        self.read().is_ok_and(|value| {
            value["hooks"]["Stop"]
                .as_array()
                .is_some_and(|groups| !self.our_commands(groups).is_empty())
        })
    }

    /// Adds the hook as a group of its own, or brings an older copy up to
    /// date, and trusts it.
    fn install(&self) -> Result<(), String> {
        let mut value = self.read()?;
        if !value.is_object() {
            return Err("~/.codex/hooks.json is not a JSON object.".into());
        }
        let hooks = value
            .as_object_mut()
            .expect("an object")
            .entry("hooks")
            .or_insert_with(|| json!({}));
        let Some(hooks) = hooks.as_object_mut() else {
            return Err("~/.codex/hooks.json has a `hooks` that is not an object.".into());
        };
        let stop = hooks.entry("Stop").or_insert_with(|| json!([]));
        let Some(groups) = stop.as_array_mut() else {
            return Err("~/.codex/hooks.json has a `Stop` that is not a list.".into());
        };
        let entry = self.entry();
        let current = groups.contains(&entry) && self.our_commands(groups).len() == 1;
        if !current {
            self.take_out(groups);
            groups.push(entry);
            self.write(&value)?;
        }
        (self.trust)(&self.codex_home, &self.command)
    }

    fn remove(&self) -> Result<(), String> {
        let mut value = self.read()?;
        let Some(groups) = value["hooks"]["Stop"].as_array_mut() else {
            return Ok(());
        };
        if !self.take_out(groups) {
            return Ok(());
        }
        self.write(&value)
    }

    /// At core start: an installed hook is brought up to date (a moved or
    /// updated app runs a different executable) and trusted again.
    pub fn refresh(&self) {
        let ready = self.applies() && self.hook_enabled() && self.install().is_ok();
        self.inbox.set_ready(ready);
        self.checked.store(true, Ordering::SeqCst);
    }
}

impl crate::relay::agents::SettingsExtension for CodexStopHookSettings {
    fn get(&self) -> Map<String, Value> {
        let mut values = Map::new();
        if self.applies() {
            // On only while it works: an entry Codex does not trust never
            // runs, so it reads as off and turning it on tries again.
            let working = self.inbox.is_ready() || !self.checked.load(Ordering::SeqCst);
            values.insert(SETTING.into(), Value::Bool(self.hook_enabled() && working));
        }
        values
    }

    fn set(&self, key: &str, value: &Value) -> Option<Result<(), String>> {
        if key != SETTING {
            return None;
        }
        let Some(enabled) = value.as_bool() else {
            return Some(Err(format!("{SETTING} must be true or false.")));
        };
        let outcome = if enabled {
            self.install()
        } else {
            self.remove()
        };
        self.inbox.set_ready(enabled && outcome.is_ok());
        self.checked.store(true, Ordering::SeqCst);
        Some(outcome)
    }

    fn default_on(&self) -> Vec<&'static str> {
        if self.applies() && !self.hook_enabled() {
            vec![SETTING]
        } else {
            Vec::new()
        }
    }
}

/// Trusts the hook running `command` in `codex_home`, as Codex's own `/hooks`
/// review does: `hooks/list` gives its key and current hash, and
/// `config/value/write` records that hash in `hooks.state`.
fn trust_with_app_server(codex_home: &Path, command: &str) -> Result<(), String> {
    let executable = codex_for_hooks().ok_or("No Codex to trust the hook with was found.")?;
    let mut session = AppServer::start(&executable, codex_home)?;
    session.request(
        "initialize",
        json!({"clientInfo": {"name": "agent-relay", "version": env!("CARGO_PKG_VERSION")}}),
    )?;
    session.notify("initialized")?;
    let listed = session.request("hooks/list", json!({"cwds": [codex_home]}))?;
    let hook = listed["data"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|entry| entry["hooks"].as_array().into_iter().flatten())
        .find(|hook| hook["command"] == command && hook["eventName"] == "stop")
        .ok_or("Codex does not list Agent Relay's hook.")?;
    if hook["trustStatus"] == "trusted" {
        return Ok(());
    }
    let (Some(key), Some(hash)) = (hook["key"].as_str(), hook["currentHash"].as_str()) else {
        return Err("Codex lists Agent Relay's hook without a key or hash.".into());
    };
    session.request(
        "config/value/write",
        json!({
            "keyPath": "hooks.state",
            "mergeStrategy": "upsert",
            "value": {key: {"trusted_hash": hash}},
        }),
    )?;
    Ok(())
}

/// The Codex whose app-server lists and trusts hooks: Conductor's newest
/// bundled Codex, which is the one that runs them, else one on `PATH`.
fn codex_for_hooks() -> Option<PathBuf> {
    let home = crate::platform::home_dir()?;
    let bundled = home.join("Library/Application Support/com.conductor.app/agent-binaries/codex");
    let mut versions: Vec<(Vec<u64>, PathBuf)> = std::fs::read_dir(&bundled)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let version: Option<Vec<u64>> = name.split('.').map(|part| part.parse().ok()).collect();
            let binary = entry.path().join("codex");
            Some((version?, binary)).filter(|(_, binary)| binary.is_file())
        })
        .collect();
    versions.sort();
    versions
        .pop()
        .map(|(_, binary)| binary)
        .or_else(|| which("codex"))
}

#[cfg(unix)]
fn which(name: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|directory| directory.join(name))
            .find(|path| path.is_file())
    })
}

/// `name` on `PATH` with its `PATHEXT` extension (`codex.cmd`).
#[cfg(windows)]
fn which(name: &str) -> Option<PathBuf> {
    crate::platform::exe::find_on_path(name)
}

/// The program at the start of a hook command, quoted for the shell Codex
/// runs it with: POSIX single quotes on Unix, double quotes for `cmd.exe`
/// on Windows (a Windows path cannot contain a double quote).
#[cfg(unix)]
fn quoted_program(executable: &Path) -> String {
    crate::relay::outbound::shell_quote(&executable.to_string_lossy())
}

#[cfg(windows)]
fn quoted_program(executable: &Path) -> String {
    format!("\"{}\"", executable.to_string_lossy())
}

/// A short-lived `codex app-server` over stdio.
struct AppServer {
    child: std::process::Child,
    stdin: std::process::ChildStdin,
    lines: mpsc::Receiver<String>,
    next_id: u64,
}

impl AppServer {
    fn start(executable: &Path, codex_home: &Path) -> Result<AppServer, String> {
        let mut command = Command::new(executable);
        // No console window flashes up for it on Windows.
        crate::platform::process::hide_window(&mut command);
        let mut child = command
            .arg("app-server")
            .env("CODEX_HOME", codex_home)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "Codex's app-server could not start.".to_string())?;
        let stdin = child
            .stdin
            .take()
            .ok_or("Codex's app-server has no input.")?;
        let stdout = child
            .stdout
            .take()
            .ok_or("Codex's app-server has no output.")?;
        let (sender, lines) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if sender.send(line).is_err() {
                    return;
                }
            }
        });
        Ok(AppServer {
            child,
            stdin,
            lines,
            next_id: 1,
        })
    }

    fn send(&mut self, message: &Value) -> Result<(), String> {
        let mut line = serde_json::to_vec(message).map_err(|error| error.to_string())?;
        line.push(b'\n');
        self.stdin
            .write_all(&line)
            .map_err(|_| "Codex's app-server stopped.".to_string())
    }

    fn notify(&mut self, method: &str) -> Result<(), String> {
        self.send(&json!({"method": method}))
    }

    fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        self.send(&json!({"id": id, "method": method, "params": params}))?;
        let deadline = Instant::now() + APP_SERVER_TIMEOUT;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            let line = self
                .lines
                .recv_timeout(left)
                .map_err(|_| format!("Codex's app-server did not answer {method}."))?;
            let Ok(message) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if message["id"] != json!(id) {
                continue;
            }
            if let Some(error) = message.get("error") {
                return Err(format!(
                    "Codex refused {method}: {}",
                    error["message"].as_str().unwrap_or("no reason given")
                ));
            }
            return Ok(message["result"].clone());
        }
    }
}

impl Drop for AppServer {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::relay::agents::SettingsExtension;
    use std::sync::Arc;

    const THREAD: &str = "01a1235e-70e1-7cb1-8619-e2c8bf3bdb7b";

    #[test]
    fn a_held_message_is_handed_over_once_with_the_quote_note() {
        let inbox = StopHookInbox::default();
        let text = "[via Agent Relay — from @alice to @codex-api · message m1 · ref 0123456789ab]\n[reply: curl relay]\n\nCan you check CI?";
        inbox.hold(&THREAD.to_uppercase(), "m1", text);
        inbox.hold(THREAD, "m1", text);
        assert!(inbox.is_held("m1"));
        let answer = inbox.answer(THREAD, false, true, &|_| false, &|_| None);
        assert_eq!(answer["decision"], "block");
        let reason = answer["reason"].as_str().unwrap();
        assert_eq!(
            reason.lines().collect::<Vec<_>>()[..3],
            [
                "[via Agent Relay — from @alice to @codex-api · message m1 · ref 0123456789ab]",
                "[reply: curl relay]",
                conductor::QUOTE_NOTE
            ]
        );
        assert!(reason.ends_with("Can you check CI?"));
        assert!(!inbox.is_held("m1"));
        assert!(inbox.taken_at("m1").is_some());
        // Held once only, and never held again once handed over.
        assert_eq!(
            inbox.answer(THREAD, true, true, &|_| false, &|_| None),
            json!({})
        );
        inbox.hold(THREAD, "m1", text);
        assert!(!inbox.is_held("m1"));
        inbox.forget("m1");
        assert!(inbox.taken_at("m1").is_none());
    }

    // The live test on 2026-10-09: the recap went into the queued turn that
    // delivered the idle message, which Conductor does not show.
    #[test]
    fn nothing_is_handed_over_at_the_end_of_a_turn_conductor_does_not_show() {
        let inbox = StopHookInbox::default();
        inbox.note_unseen(THREAD, "m1", "[via Agent Relay — from @alice]\n\nping");
        inbox.hold(THREAD, "m2", "[via Agent Relay — ref 0123456789ab]\n\nhi");
        assert_eq!(
            inbox.answer(THREAD, false, false, &|_| false, &|_| None),
            json!({})
        );
        assert!(
            inbox.is_held("m2"),
            "still waiting for a turn that is shown"
        );
        assert_eq!(
            inbox.answer(THREAD, false, true, &|_| false, &|_| None)["decision"],
            "block"
        );
        let recap = inbox.answer(THREAD, true, true, &|_| false, &|_| None);
        assert_eq!(recap, json!({}), "a continuation's stop shows no recap");
        assert!(
            inbox.answer(THREAD, false, true, &|_| false, &|_| Some("pong".into()))["reason"]
                .as_str()
                .unwrap()
                .contains("while this chat was idle")
        );
    }

    // Review on #385: after a restart a message the hook already handed
    // over can be held again; Codex has recorded it, so it is not resent.
    #[test]
    fn a_held_message_codex_already_recorded_is_not_handed_over_again() {
        let inbox = StopHookInbox::default();
        inbox.hold(THREAD, "m1", "[via Agent Relay — ref 0123456789ab]\n\nhi");
        inbox.hold(THREAD, "m2", "[via Agent Relay — ref 0123456789ac]\n\nyo");
        let m1 = crate::relay::delivery::policy::MessageRef::of("m1");
        let answer = inbox.answer(THREAD, true, true, &|r| r == m1, &|_| None);
        assert!(
            answer["reason"].as_str().unwrap().ends_with("yo"),
            "m1 skipped"
        );
        assert_eq!(
            inbox.answer(THREAD, true, true, &|_| true, &|_| None),
            json!({})
        );
    }

    #[test]
    fn a_withdrawn_message_is_not_handed_over() {
        let inbox = StopHookInbox::default();
        inbox.hold(THREAD, "m1", "[via Agent Relay — ref 0123456789ab]\n\nhi");
        assert!(inbox.withdraw("m1"));
        assert!(!inbox.withdraw("m1"));
        assert_eq!(
            inbox.answer(THREAD, false, true, &|_| false, &|_| None),
            json!({})
        );
    }

    #[test]
    fn idle_deliveries_are_recapped_once_answered_at_a_shown_turns_first_stop() {
        let inbox = StopHookInbox::default();
        inbox.note_unseen(THREAD, "m1", "[via Agent Relay — from @alice]\n\nping");
        inbox.note_unseen(THREAD, "m1", "[via Agent Relay — from @alice]\n\nping");
        inbox.note_unseen(THREAD, "m2", "[via Agent Relay — from @bob]\n\nstatus?");
        let m1 = crate::relay::delivery::policy::MessageRef::of("m1");
        let m2 = crate::relay::delivery::policy::MessageRef::of("m2");
        let first = m1.clone();
        let only_m1 = move |r: &str| (r == first).then(|| "pong".to_string());
        // A stop that follows a continuation shows nothing.
        assert_eq!(
            inbox.answer(THREAD, true, true, &|_| false, &only_m1),
            json!({})
        );
        let answer = inbox.answer(THREAD, false, true, &|_| false, &only_m1);
        let reason = answer["reason"].as_str().unwrap();
        assert!(reason.starts_with("[Agent Relay: while this chat was idle"));
        assert!(reason.contains(
            "1. Message:\n[via Agent Relay — from @alice]\n\nping\n\nYour answer:\npong"
        ));
        assert!(
            !reason.contains("status?"),
            "not answered yet: kept for later"
        );
        assert!(!reason.contains("2. Message"), "each message once");
        // The recap is not a relayed message: its turn is not a delivery.
        assert!(crate::relay::delivery::policy::MessageRef::in_text(reason).is_none());
        // Once Codex records the answer, the next shown turn recaps it.
        let both = move |r: &str| (r == m1 || r == m2).then(|| "ok".to_string());
        let later = inbox.answer(THREAD, false, true, &|_| false, &both);
        let reason = later["reason"].as_str().unwrap();
        assert!(reason.contains("status?") && !reason.contains("ping"));
        assert_eq!(
            inbox.answer(THREAD, false, true, &|_| false, &both),
            json!({})
        );
    }

    #[test]
    fn a_cancelled_message_is_neither_handed_over_nor_recapped() {
        let inbox = StopHookInbox::default();
        inbox.hold(THREAD, "m1", "[via Agent Relay — ref 0123456789ab]\n\nhi");
        inbox.note_unseen(THREAD, "m2", "[via Agent Relay — ref 0123456789ac]\n\nyo");
        inbox.cancel("m1");
        inbox.cancel("m2");
        assert_eq!(
            inbox.answer(THREAD, false, true, &|_| false, &|_| Some("x".into())),
            json!({})
        );
    }

    #[test]
    fn a_message_the_hook_handed_over_is_not_recapped() {
        let inbox = StopHookInbox::default();
        inbox.hold(THREAD, "m1", "[via Agent Relay — ref 0123456789ab]\n\nhi");
        inbox.answer(THREAD, false, true, &|_| false, &|_| None);
        inbox.note_unseen(THREAD, "m1", "[via Agent Relay — ref 0123456789ab]\n\nhi");
        assert_eq!(
            inbox.answer(THREAD, false, true, &|_| false, &|_| None),
            json!({})
        );
    }

    /// This build's hook command in the tests' settings, quoted as this
    /// platform quotes it.
    fn ours() -> String {
        CodexStopHookSettings::command_for(Path::new("/Apps/Agent Relay.app/probe"), false)
    }

    fn settings(
        home: &Path,
    ) -> (
        CodexStopHookSettings,
        Arc<Mutex<Vec<String>>>,
        Arc<StopHookInbox>,
    ) {
        let trusted = Arc::new(Mutex::new(Vec::new()));
        let inbox = Arc::new(StopHookInbox::default());
        let log = trusted.clone();
        let settings = CodexStopHookSettings::new(
            home.join(".codex"),
            home.join("conductor-data"),
            CodexStopHookSettings::command_for(Path::new("/Apps/Agent Relay.app/probe"), false),
            inbox.clone(),
        )
        .with_trust(move |_, command| {
            log.lock().unwrap().push(command.to_string());
            Ok(())
        });
        (settings, trusted, inbox)
    }

    #[test]
    fn the_setting_adds_and_removes_only_its_own_hook() {
        let home = tempfile::tempdir().unwrap();
        let (settings, trusted, inbox) = settings(home.path());
        assert!(
            settings.get().is_empty(),
            "no row without Conductor and Codex"
        );
        std::fs::create_dir_all(home.path().join(".codex")).unwrap();
        std::fs::create_dir_all(home.path().join("conductor-data")).unwrap();
        let theirs = json!({"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "notify.sh"}]}],
                                      "SessionStart": [{"hooks": [{"type": "command", "command": "start.sh"}]}]}});
        std::fs::write(home.path().join(".codex/hooks.json"), theirs.to_string()).unwrap();
        assert_eq!(settings.get()[SETTING], false);
        assert_eq!(settings.default_on(), [SETTING]);

        assert_eq!(settings.set(SETTING, &json!(true)), Some(Ok(())));
        assert!(inbox.is_ready());
        let value: Value =
            serde_json::from_slice(&std::fs::read(home.path().join(".codex/hooks.json")).unwrap())
                .unwrap();
        let stop = value["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(stop.len(), 2);
        assert_eq!(stop[0]["hooks"][0]["command"], "notify.sh");
        assert_eq!(stop[1]["hooks"][0]["command"], ours());
        assert_eq!(
            value["hooks"]["SessionStart"],
            theirs["hooks"]["SessionStart"]
        );
        assert_eq!(trusted.lock().unwrap().len(), 1);
        assert_eq!(settings.get()[SETTING], true);
        assert!(settings.default_on().is_empty());
        // Turning it on again adds no second copy.
        assert_eq!(settings.set(SETTING, &json!(true)), Some(Ok(())));
        let value: Value =
            serde_json::from_slice(&std::fs::read(home.path().join(".codex/hooks.json")).unwrap())
                .unwrap();
        assert_eq!(value["hooks"]["Stop"].as_array().unwrap().len(), 2);

        assert_eq!(settings.set(SETTING, &json!(false)), Some(Ok(())));
        assert!(!inbox.is_ready());
        let value: Value =
            serde_json::from_slice(&std::fs::read(home.path().join(".codex/hooks.json")).unwrap())
                .unwrap();
        assert_eq!(value, theirs);
        assert_eq!(
            settings.set(SETTING, &json!("yes")),
            Some(Err("codex_stop_hook must be true or false.".into()))
        );
        assert_eq!(settings.set("other", &json!(true)), None);
    }

    #[test]
    fn an_older_copy_is_replaced_and_a_failed_trust_is_not_ready() {
        let home = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(home.path().join(".codex")).unwrap();
        std::fs::create_dir_all(home.path().join("conductor-data")).unwrap();
        let old = json!({"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "'/Old/probe' relay codex-stop-hook"}]}]}});
        std::fs::write(home.path().join(".codex/hooks.json"), old.to_string()).unwrap();
        let (settings, _, inbox) = settings(home.path());
        settings.refresh();
        assert!(inbox.is_ready());
        let value: Value =
            serde_json::from_slice(&std::fs::read(home.path().join(".codex/hooks.json")).unwrap())
                .unwrap();
        assert_eq!(value["hooks"]["Stop"].as_array().unwrap().len(), 1);
        assert_eq!(value["hooks"]["Stop"][0]["hooks"][0]["command"], ours());

        let settings = settings.with_trust(|_, _| Err("untrusted".into()));
        settings.refresh();
        assert!(
            !inbox.is_ready(),
            "an untrusted hook never runs, so nothing is held for it"
        );
    }

    // Review on #385: other hooks in a group with ours stay; the release
    // and development builds keep their own entries.
    #[test]
    fn only_this_builds_hook_is_touched_even_in_a_shared_group() {
        let home = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(home.path().join(".codex")).unwrap();
        std::fs::create_dir_all(home.path().join("conductor-data")).unwrap();
        let shared = json!({"hooks": {"Stop": [{"hooks": [
            {"type": "command", "command": "notify.sh"},
            {"type": "command", "command": "'/Old/probe' relay codex-stop-hook"},
            {"type": "command", "command": "'/Dev/probe' relay codex-stop-hook --dev"}
        ]}]}});
        std::fs::write(home.path().join(".codex/hooks.json"), shared.to_string()).unwrap();
        let (settings, _, _) = settings(home.path());
        assert_eq!(settings.set(SETTING, &json!(true)), Some(Ok(())));
        let read = || -> Value {
            serde_json::from_slice(&std::fs::read(home.path().join(".codex/hooks.json")).unwrap())
                .unwrap()
        };
        let commands = |value: &Value| -> Vec<String> {
            value["hooks"]["Stop"]
                .as_array()
                .unwrap()
                .iter()
                .flat_map(|group| group["hooks"].as_array().unwrap().clone())
                .map(|hook| hook["command"].as_str().unwrap().to_string())
                .collect()
        };
        assert_eq!(
            commands(&read()),
            [
                "notify.sh".to_string(),
                "'/Dev/probe' relay codex-stop-hook --dev".to_string(),
                ours()
            ]
        );
        assert_eq!(settings.set(SETTING, &json!(false)), Some(Ok(())));
        assert_eq!(
            commands(&read()),
            ["notify.sh", "'/Dev/probe' relay codex-stop-hook --dev"]
        );
    }

    #[test]
    fn a_hook_codex_does_not_trust_reads_as_off() {
        let home = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(home.path().join(".codex")).unwrap();
        std::fs::create_dir_all(home.path().join("conductor-data")).unwrap();
        let (settings, _, _) = settings(home.path());
        let settings = settings.with_trust(|_, _| Err("Codex refused".into()));
        assert_eq!(
            settings.set(SETTING, &json!(true)),
            Some(Err("Codex refused".into()))
        );
        assert!(settings.hook_enabled(), "the entry was written");
        assert_eq!(
            settings.get()[SETTING],
            false,
            "but it never runs, so it is off"
        );
    }

    #[cfg(windows)]
    #[test]
    fn the_windows_command_is_quoted_for_cmd() {
        assert_eq!(
            CodexStopHookSettings::command_for(Path::new(r"C:\a b\probe.exe"), false),
            r#""C:\a b\probe.exe" relay codex-stop-hook"#
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_command_names_the_dev_build() {
        assert_eq!(
            CodexStopHookSettings::command_for(Path::new("/a b/probe"), true),
            "'/a b/probe' relay codex-stop-hook --dev"
        );
    }
}
