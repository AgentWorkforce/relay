//! Agent Relay's Codex hook: delivers relayed messages into a Codex turn
//! that is running (`turn_hook`), and makes them visible in Conductor's
//! Codex chats.
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
//! The same hook runs after each tool call (PostToolUse) and as any turn
//! ends (Stop), so a message for any other Codex thread that is working is
//! handed over inside its running turn (`turn_hook::TurnInbox`).
//!
//! It also runs as a session starts (SessionStart), and gives a session on
//! the relay its preamble: who it is there, and the exact session-socket
//! commands that list agents and send a DM, so a fresh Codex never reaches
//! for another Agent Relay connector before a relayed message has shown it
//! the local route (`hosted_mcp::codex_preamble`).
//!
//! The hook runs `agent-relay-probe relay codex-stop-hook`, which hands its
//! input to the relay-send socket (`POST /codex/stop-hook`). The socket
//! answers only a caller whose nearest trusted Codex holds the named
//! thread's writer lock, so a process can collect only its own thread's
//! messages. The setting `codex_stop_hook` adds the hook to
//! `~/.codex/hooks.json` for each event and trusts it through Codex's own
//! app-server (`hooks/list`, `config/value/write`).

use super::turn_hook::TurnInbox;
use crate::relay::conductor;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

mod trust;

/// The setting that adds and removes the hook.
pub const SETTING: &str = "codex_stop_hook";

/// The subcommand the hook runs; also how the hook is recognized as ours.
pub const SUBCOMMAND: &str = "relay codex-stop-hook";

/// What a waiting relay message says about the chat it is for.
pub const HELD: &str = "Waiting — handed over when the Conductor chat's turn ends";

/// The Codex hook events the hook runs for, as `hooks.json` names them.
/// At SessionStart it gives the session its Agent Relay preamble
/// (`hosted_mcp::codex_preamble`).
const EVENTS: [&str; 3] = ["Stop", "PostToolUse", "SessionStart"];

/// The most idle deliveries one recap shows.
const RECAP_LIMIT: usize = 10;

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
/// after a restart its next delivery attempt holds it again. Messages for
/// other running turns wait in `turns`, whose claims are kept on disk.
#[derive(Default)]
pub struct StopHookInbox {
    /// Whether the hook is installed and trusted, so holding a message
    /// cannot leave it waiting for a hook that never runs.
    ready: AtomicBool,
    state: Mutex<State>,
    turns: TurnInbox,
}

impl StopHookInbox {
    /// The inbox whose running-turn claims are kept by `turns`.
    pub fn with_turns(turns: TurnInbox) -> StopHookInbox {
        StopHookInbox {
            turns,
            ..StopHookInbox::default()
        }
    }

    /// Messages waiting for a running turn's hook (`turn_hook`).
    pub fn turns(&self) -> &TurnInbox {
        &self.turns
    }

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

/// Writes `hooks.json` atomically, keeping its mode; `backup` is the copy
/// kept beside it the first time.
fn write_hooks(path: &Path, backup: Option<&[u8]>, bytes: &[u8]) -> Result<(), String> {
    crate::relay::claude_settings::write_keeping_file(path, backup, bytes, BACKUP_SUFFIX, 0o644)
        .map_err(|_| "~/.codex/hooks.json cannot be written.".to_string())
}

/// `value` without what adding and taking out the hook makes or drops on
/// its own: an empty list for one of the hook's events and an empty
/// `hooks`. Two files equal this way differ in nothing the person set.
fn without_empty(value: &Value) -> Value {
    let mut value = value.clone();
    if let Some(object) = value.as_object_mut() {
        if let Some(hooks) = object.get_mut("hooks").and_then(Value::as_object_mut) {
            hooks.retain(|event, groups| {
                !(EVENTS.contains(&event.as_str()) && groups.as_array().is_some_and(Vec::is_empty))
            });
        }
        if object
            .get("hooks")
            .is_some_and(|hooks| hooks.as_object().is_some_and(serde_json::Map::is_empty))
        {
            object.remove("hooks");
        }
    }
    value
}

/// Whether `value` is a `hooks.json` with nothing in it: `{}`, or only an
/// empty `hooks`.
fn is_empty_hooks(value: &Value) -> bool {
    value.as_object().is_some_and(|object| {
        object.iter().all(|(key, value)| {
            key == "hooks" && value.as_object().is_some_and(serde_json::Map::is_empty)
        })
    })
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

/// Takes the hook running a command out of a Codex home with the edit it is
/// given, and the trust recorded for it (`trust::untrust_with_app_server`).
type Untrust = Box<
    dyn Fn(&Path, &str, &mut dyn FnMut() -> Result<(), String>) -> Result<(), String> + Send + Sync,
>;

/// The suffix of the one-time copy of `hooks.json` as the person had it.
const BACKUP_SUFFIX: &str = ".relay-desktop-backup";

/// The first line of the Codex rules file Agent Relay writes; a file there
/// without it is not Agent Relay's and is never rewritten or removed.
const RULES_HEADER: &str = "# Agent Relay: written and removed by Agent Relay (codex_stop_hook).";

/// The marker, in the core's data, that `~/.codex/config.toml` did not exist
/// until trusting the hook created it, so taking the hook out again removes
/// the file once nothing else is in it.
const CONFIG_CREATED: &str = "codex-config-created";

/// How many names the sandbox rules may try (`SandboxRules`).
const RULES_NAMES: usize = 9;

/// What lets a session reach its session socket from inside Codex's
/// sandbox, as a Codex rules file (`~/.codex/rules/agent-relay.rules`).
///
/// Codex's default sandbox (`workspace-write` or `read-only`, network off)
/// denies every Unix socket connect on macOS, so the probe's own socket
/// client failed there, and Codex asked to run it outside the sandbox or
/// reached for another Agent Relay connector. Codex runs a command outside
/// its sandbox without asking when every part of it matches an `allow`
/// prefix rule (`exec_policy` in Codex, verified with Codex 0.163).
///
/// A prefix rule constrains only a command's leading words: whatever follows
/// them is allowed too. So the rules name only the probe's self-limiting
/// session commands (`session_cli::ALLOWED_SUBCOMMANDS`: `relay send`,
/// `agents`, `whoami`, `read`, `fetch-attachment`, `connect-send` and
/// `subscribe-channel`), each only with
/// `--socket` naming this core's own session socket. Each of those fixes its
/// own method and route and checks every other argument, so nothing after
/// the prefix reaches another route; `relay socket-request`, which takes any
/// method and path (`PATCH /settings`, `/register`), has no rule and still
/// asks. Nothing else is widened: no network, no other program, no other
/// socket.
///
/// Codex matches a command only when its program is a plain, unquoted word,
/// so a probe whose path needs quoting (the macOS app's helper) is named by
/// the core's space-free link to it (`probe_alias`). A quoted argument is
/// matched as written, so the socket keeps its own path.
#[derive(Clone, Debug)]
pub struct SandboxRules {
    /// The probe executable the reply hints name.
    pub probe: PathBuf,
    /// The relay-send (session) socket this core serves.
    pub socket: PathBuf,
}

impl SandboxRules {
    /// Each rule's pattern: the probe, `relay`, the subcommand, `--socket`
    /// and the socket.
    pub fn patterns(&self) -> Vec<Vec<String>> {
        let probe = self.probe.to_string_lossy().into_owned();
        let socket = self.socket.to_string_lossy().into_owned();
        crate::relay::session_cli::ALLOWED_SUBCOMMANDS
            .iter()
            .map(|subcommand| {
                vec![
                    probe.clone(),
                    "relay".to_string(),
                    subcommand.to_string(),
                    "--socket".to_string(),
                    socket.clone(),
                ]
            })
            .collect()
    }

    /// The rules file's text (Starlark; a JSON string is a Starlark string).
    pub fn text(&self) -> String {
        let mut text = format!(
            "{RULES_HEADER}\n\
             # Lets Agent Relay's own client reach this computer's Agent Relay session socket\n\
             # from Codex's sandbox, so a session can read and answer relayed messages. Each\n\
             # command fixes its own route; no other session route is allowed.\n"
        );
        for pattern in self.patterns() {
            let justification = match pattern[2].as_str() {
                "send" => "Sends a message as this session through Agent Relay",
                "agents" => "Lists the agents this session can message",
                "whoami" => "Shows this session's own name on Agent Relay",
                "read" => "Reads a message Agent Relay relayed to this session",
                "fetch-attachment" => "Fetches an attachment sent to this session",
                "subscribe-channel" => "Joins or leaves one channel as this session",
                _ => "Answers in the Relay Connect room this session joined",
            };
            let words = pattern
                .iter()
                .map(|word| Value::from(word.as_str()).to_string())
                .collect::<Vec<_>>()
                .join(", ");
            text.push_str(&format!(
                "prefix_rule(\n    \
                 pattern = [{words}],\n    \
                 decision = \"allow\",\n    \
                 justification = \"{justification}\",\n\
                 )\n"
            ));
        }
        text
    }
}

/// Adds, trusts and removes the hook in a Codex home.
pub struct CodexStopHookSettings {
    /// `~/.codex`.
    codex_home: PathBuf,
    /// The shell command the hook runs.
    command: String,
    inbox: std::sync::Arc<StopHookInbox>,
    trust: Trust,
    untrust: Untrust,
    /// The sandbox rules written beside the hook, when this core serves a
    /// session socket.
    sandbox: Option<SandboxRules>,
    /// The core's own data folder, which keeps [`CONFIG_CREATED`].
    state_dir: Option<PathBuf>,
    /// The space-free link the rules name when the probe's path needs
    /// quoting.
    alias: Option<std::sync::Arc<crate::relay::probe_alias::ProbeAlias>>,
    /// Whether the start-up refresh (or a change) has run, so a hook not
    /// yet trusted again is still reported as on until it has.
    checked: AtomicBool,
}

impl CodexStopHookSettings {
    /// `codex` is the Codex the core found (`CodexConfig::executable`),
    /// whose app-server trusts the hook when Conductor bundles none.
    pub fn new(
        codex_home: PathBuf,
        command: String,
        codex: Option<PathBuf>,
        inbox: std::sync::Arc<StopHookInbox>,
    ) -> CodexStopHookSettings {
        let untrust_codex = codex.clone();
        CodexStopHookSettings {
            codex_home,
            command,
            inbox,
            trust: Box::new(move |home, command| {
                trust::with_app_server(home, command, codex.as_deref())
            }),
            untrust: Box::new(move |home, command, edit| {
                trust::untrust_with_app_server(home, command, untrust_codex.as_deref(), edit)
            }),
            sandbox: None,
            state_dir: None,
            alias: None,
            checked: AtomicBool::new(false),
        }
    }

    /// Also writes [`SandboxRules`] while the hook is on.
    pub fn with_sandbox_rules(mut self, rules: SandboxRules) -> Self {
        self.sandbox = Some(rules);
        self
    }

    /// Names the probe in the rules by `alias` when its path needs quoting.
    pub fn with_probe_alias(
        mut self,
        alias: std::sync::Arc<crate::relay::probe_alias::ProbeAlias>,
    ) -> Self {
        self.alias = Some(alias);
        self
    }

    /// Keeps whether trusting the hook created `config.toml` in `state_dir`.
    pub fn with_state_dir(mut self, state_dir: PathBuf) -> Self {
        self.state_dir = Some(state_dir);
        self
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

    #[cfg(test)]
    fn with_untrust(
        mut self,
        untrust: impl Fn(&Path, &str, &mut dyn FnMut() -> Result<(), String>) -> Result<(), String>
            + Send
            + Sync
            + 'static,
    ) -> Self {
        self.untrust = Box::new(untrust);
        self
    }

    fn development(&self) -> bool {
        self.command.trim_end().ends_with(" --dev")
    }

    /// The names the sandbox rules may have, in order: `agent-relay.rules`,
    /// then `agent-relay-2.rules` and on when a file of the person's holds
    /// the name (`agent-relay-dev…` for Agent Relay Dev).
    fn rules_files(&self) -> Vec<PathBuf> {
        let stem = if self.development() {
            "agent-relay-dev"
        } else {
            "agent-relay"
        };
        let folder = self.codex_home.join("rules");
        std::iter::once(folder.join(format!("{stem}.rules")))
            .chain((2..=RULES_NAMES).map(|n| folder.join(format!("{stem}-{n}.rules"))))
            .collect()
    }

    fn config_file(&self) -> PathBuf {
        self.codex_home.join("config.toml")
    }

    fn config_marker(&self) -> Option<PathBuf> {
        let name = if self.development() {
            format!("{CONFIG_CREATED}.dev")
        } else {
            CONFIG_CREATED.to_string()
        };
        self.state_dir.as_ref().map(|dir| dir.join(name))
    }

    /// Writes the sandbox rules, unless they are already there as written.
    /// A file of that name that is not Agent Relay's is left alone.
    fn write_rules(&self) -> Result<(), String> {
        let Some(rules) = &self.sandbox else {
            return Ok(());
        };
        let rules = match &self.alias {
            Some(alias) => SandboxRules {
                probe: alias.acquire(crate::relay::probe_alias::User::Codex),
                socket: rules.socket.clone(),
            },
            None => rules.clone(),
        };
        let text = rules.text();
        // Agent Relay's own file, else the first free name: a file of the
        // person's is never rewritten, and never leaves the hook on without
        // the rules that let its replies out of the sandbox. Every other
        // file of Agent Relay's (an older build's rules, which may allow
        // more) goes.
        let mut ours = Vec::new();
        let mut current = None;
        let mut free = None;
        for path in self.rules_files() {
            match std::fs::symlink_metadata(&path) {
                // Free only when nothing is there at all: a link, dangling
                // or not, is the person's and never replaced.
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    free.get_or_insert(path);
                    continue;
                }
                // Codex reads only a plain rules file, and Agent Relay
                // writes nothing else.
                Ok(metadata) if metadata.file_type().is_file() => {}
                _ => continue,
            }
            match std::fs::read_to_string(&path) {
                Ok(written) if written == text && current.is_none() => current = Some(path),
                Ok(written) if written.starts_with(RULES_HEADER) => ours.push(path),
                _ => {}
            }
        }
        let path = match current {
            Some(path) => path,
            None => {
                let path = match ours.first() {
                    Some(_) => ours.remove(0),
                    None => free.ok_or_else(|| {
                        "~/.codex/rules has no free name for Agent Relay's sandbox rules."
                            .to_string()
                    })?,
                };
                crate::relay::claude_settings::write_keeping_file(
                    &path,
                    None,
                    text.as_bytes(),
                    BACKUP_SUFFIX,
                    0o644,
                )
                .map_err(|_| "~/.codex/rules cannot be written.".to_string())?;
                path
            }
        };
        for stale in ours.into_iter().filter(|stale| *stale != path) {
            match std::fs::remove_file(&stale) {
                Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                    return Err("~/.codex/rules has an older Agent Relay rules file that cannot be removed.".into());
                }
                _ => {}
            }
        }
        Ok(())
    }

    /// Removes Agent Relay's rules file, and the `rules` folder when that
    /// leaves it empty.
    ///
    /// A rules file that cannot be removed is an error, so turning the hook
    /// off can be tried again once the folder is writable.
    fn remove_rules(&self) -> Result<(), String> {
        let mut removed = false;
        for path in self.rules_files() {
            // Agent Relay writes a plain file; a link is the person's.
            let ours = std::fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_file())
                && std::fs::read_to_string(&path).is_ok_and(|text| text.starts_with(RULES_HEADER));
            if !ours {
                continue;
            }
            match std::fs::remove_file(&path) {
                Ok(()) => removed = true,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err("~/.codex/rules/agent-relay.rules cannot be removed.".into()),
            }
        }
        if removed {
            // Only an empty folder goes; anything else in it stays.
            let _ = std::fs::remove_dir(self.codex_home.join("rules"));
        }
        Ok(())
    }

    /// Removes `config.toml` when trusting the hook created it and nothing
    /// is in it now.
    fn tidy_config(&self) {
        let Some(marker) = self.config_marker() else {
            return;
        };
        if !marker.exists() {
            return;
        }
        let config = self.config_file();
        match std::fs::read_to_string(&config) {
            Ok(text) if text.trim().is_empty() => {
                if std::fs::remove_file(&config).is_ok() {
                    let _ = std::fs::remove_file(&marker);
                }
            }
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => {}
            // Gone already, or the person's own settings are in it now.
            _ => {
                let _ = std::fs::remove_file(&marker);
            }
        }
    }

    fn hooks_file(&self) -> PathBuf {
        self.codex_home.join("hooks.json")
    }

    /// Whether Codex has a home here: only then is there a session this
    /// hook could help.
    pub fn applies(&self) -> bool {
        self.codex_home.is_dir()
    }

    fn read(&self) -> Result<Value, String> {
        match std::fs::read(self.hooks_file()) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|_| "~/.codex/hooks.json is not valid JSON.".to_string()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
            Err(_) => Err("~/.codex/hooks.json cannot be read.".into()),
        }
    }

    /// Writes `value` atomically, keeping the file's mode. With `backup`,
    /// the first time a copy of the file as the person had it goes beside
    /// it, so taking the hook out can put that back byte for byte; a file
    /// that already holds this hook is never the person's own copy.
    fn write(&self, value: &Value, backup: bool) -> Result<(), String> {
        let path = crate::relay::claude_settings::resolve_symlinks(&self.hooks_file());
        let existing = std::fs::read(&path).ok().filter(|existing| {
            backup
                && serde_json::from_slice::<Value>(existing)
                    .is_ok_and(|value| !self.holds_ours(&value))
        });
        let mut bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
        bytes.push(b'\n');
        write_hooks(&path, existing.as_deref(), &bytes)
    }

    /// Whether `value` holds this build's hook for any event.
    fn holds_ours(&self, value: &Value) -> bool {
        value["hooks"].as_object().is_some_and(|hooks| {
            hooks.values().any(|groups| {
                groups
                    .as_array()
                    .is_some_and(|groups| !self.our_commands(groups).is_empty())
            })
        })
    }

    /// `value` with this build's hooks taken out, and each event they
    /// leave with no hooks; whether anything changed.
    fn without_ours(&self, mut value: Value) -> (Value, bool) {
        let mut changed = false;
        if let Some(hooks) = value["hooks"].as_object_mut() {
            for event in EVENTS {
                let Some(groups) = hooks.get_mut(event).and_then(Value::as_array_mut) else {
                    continue;
                };
                if self.take_out(groups) {
                    changed = true;
                    // An event left with no hooks is as if it were absent.
                    if groups.is_empty() {
                        hooks.remove(event);
                    }
                }
            }
        }
        (value, changed)
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

    /// Whether this build's hook is in the file, for either event: an
    /// older copy for Stop alone is on, and brought up to date.
    pub fn hook_enabled(&self) -> bool {
        self.read().is_ok_and(|value| {
            EVENTS.iter().any(|event| {
                value["hooks"][*event]
                    .as_array()
                    .is_some_and(|groups| !self.our_commands(groups).is_empty())
            })
        })
    }

    /// Adds the hook for each event as a group of its own, or brings an
    /// older copy up to date, and trusts it.
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
        let entry = self.entry();
        let mut changed = false;
        for event in EVENTS {
            let groups = hooks.entry(event).or_insert_with(|| json!([]));
            let Some(groups) = groups.as_array_mut() else {
                return Err(format!(
                    "~/.codex/hooks.json has a `{event}` that is not a list."
                ));
            };
            let current = groups.contains(&entry) && self.our_commands(groups).len() == 1;
            if !current {
                self.take_out(groups);
                groups.push(entry.clone());
                changed = true;
            }
        }
        if changed {
            self.write(&value, true)?;
        }
        self.write_rules()?;
        let config_existed = std::fs::symlink_metadata(self.config_file()).is_ok();
        (self.trust)(&self.codex_home, &self.command)?;
        if !config_existed && self.config_file().exists() {
            if let Some(marker) = self.config_marker() {
                if let Some(folder) = marker.parent() {
                    let _ = crate::platform::fs::create_private_dir_all(folder);
                }
                let _ = std::fs::write(marker, b"");
            }
        }
        Ok(())
    }

    /// Takes the hook out of `hooks.json`, its trust out of `config.toml`
    /// and the sandbox rules out of `rules`, leaving the Codex home as it
    /// was before the hook was added: a `hooks.json` the hook created is
    /// removed once it holds nothing else, the person's own is put back
    /// byte for byte when they have not changed it since, and only the
    /// trust entries for this hook are taken out.
    ///
    /// A `hooks.json` that cannot be read or parsed is an error, not an
    /// absent hook: the hook may still be in it, so nothing else is taken
    /// out and the setting stays on for another try.
    fn remove(&self) -> Result<(), String> {
        if self.holds_ours(&self.read()?) {
            (self.untrust)(&self.codex_home, &self.command, &mut || {
                self.take_out_of_file()
            })?;
        }
        self.remove_rules()?;
        self.release_alias();
        self.tidy_config();
        Ok(())
    }

    /// Takes this build's hook out of `hooks.json`; see [`Self::remove`].
    fn take_out_of_file(&self) -> Result<(), String> {
        let (value, changed) = self.without_ours(self.read()?);
        if !changed {
            return Ok(());
        }
        let path = crate::relay::claude_settings::resolve_symlinks(&self.hooks_file());
        let mut backup = path.clone().into_os_string();
        backup.push(BACKUP_SUFFIX);
        let backup = PathBuf::from(backup);
        let mut keep_file = false;
        if let Ok(original) = std::fs::read(&backup) {
            match serde_json::from_slice::<Value>(&original) {
                // The person's file as it was, unchanged since: it goes
                // back exactly, and the copy is no longer needed.
                Ok(saved)
                    if !self.holds_ours(&saved)
                        && without_empty(&saved) == without_empty(&value) =>
                {
                    write_hooks(&path, None, &original)?;
                    let _ = std::fs::remove_file(&backup);
                    return Ok(());
                }
                // An earlier build copied a file that already held this
                // hook: the copy has nothing the file does not.
                Ok(saved)
                    if self.holds_ours(&saved) && self.without_ours(saved.clone()).0 == value =>
                {
                    let _ = std::fs::remove_file(&backup);
                }
                // The person changed the file since: theirs stays, and so
                // does the copy.
                _ => keep_file = true,
            }
        }
        if !keep_file && is_empty_hooks(&value) {
            return match std::fs::remove_file(&path) {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(_) => Err("~/.codex/hooks.json cannot be removed.".into()),
            };
        }
        self.write(&value, false)
    }

    /// The rules no longer need the probe's link.
    fn release_alias(&self) {
        if let Some(alias) = &self.alias {
            alias.release(crate::relay::probe_alias::User::Codex);
        }
    }

    /// At core start: an installed hook is brought up to date (a moved or
    /// updated app runs a different executable) and trusted again. With the
    /// hook off, a link left for its rules goes.
    pub fn refresh(&self) {
        let enabled = self.applies() && self.hook_enabled();
        if !enabled {
            self.release_alias();
        }
        let ready = enabled && self.install().is_ok();
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
            CodexStopHookSettings::command_for(Path::new("/Apps/Agent Relay.app/probe"), false),
            None,
            inbox.clone(),
        )
        .with_trust(move |_, command| {
            log.lock().unwrap().push(command.to_string());
            Ok(())
        })
        .with_untrust(|_, _, edit| edit());
        (settings, trusted, inbox)
    }

    /// What trusting the hook adds to `config.toml` in these tests, as
    /// Codex's app-server would.
    const TRUST_TABLE: &str =
        "\n[hooks.state.\"hooks.json:stop:0:0\"]\ntrusted_hash = \"sha256:1\"\n";

    /// Settings with the sandbox rules and a state folder, whose trust and
    /// untrust edit `config.toml` the way Codex's app-server does: adding
    /// [`TRUST_TABLE`] (creating the file when there is none) and taking
    /// exactly that back out after the hook has left `hooks.json`.
    fn full_settings(home: &Path) -> CodexStopHookSettings {
        let config = home.join(".codex/config.toml");
        let untrust_config = config.clone();
        CodexStopHookSettings::new(
            home.join(".codex"),
            ours(),
            None,
            Arc::new(StopHookInbox::default()),
        )
        .with_sandbox_rules(SandboxRules {
            probe: PathBuf::from("/Apps/Agent Relay.app/probe"),
            socket: PathBuf::from("/Users/me/Library/Application Support/x/run/relay.sock"),
        })
        .with_state_dir(home.join("app-data"))
        .with_trust(move |_, _| {
            let mut text = std::fs::read_to_string(&config).unwrap_or_default();
            if !text.contains(TRUST_TABLE) {
                text.push_str(TRUST_TABLE);
                std::fs::write(&config, text).unwrap();
            }
            Ok(())
        })
        .with_untrust(move |home, _, edit| {
            assert!(
                std::fs::read_to_string(home.join("hooks.json"))
                    .unwrap()
                    .contains(SUBCOMMAND),
                "the hook's keys are listed while it is still there"
            );
            edit()?;
            let text = std::fs::read_to_string(&untrust_config).unwrap();
            std::fs::write(&untrust_config, text.replace(TRUST_TABLE, "")).unwrap();
            Ok(())
        })
    }

    /// Every file under `dir`, relative, with its bytes.
    fn tree(dir: &Path) -> Vec<(String, Vec<u8>)> {
        let mut files = Vec::new();
        let mut stack = vec![dir.to_path_buf()];
        while let Some(next) = stack.pop() {
            for entry in std::fs::read_dir(&next).unwrap().flatten() {
                let path = entry.path();
                if path.is_dir() {
                    files.push((
                        format!("{}/", path.strip_prefix(dir).unwrap().display()),
                        Vec::new(),
                    ));
                    stack.push(path);
                } else {
                    let bytes = std::fs::read(&path).unwrap();
                    files.push((path.strip_prefix(dir).unwrap().display().to_string(), bytes));
                }
            }
        }
        files.sort();
        files
    }

    // The relay init end-to-end run on 2026-10-29: --uninstall left an empty
    // hooks.json, its .relay-desktop-backup and the trust entries.
    #[test]
    fn turning_the_hook_off_after_a_fresh_install_leaves_the_codex_home_as_it_was() {
        let home = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(home.path().join(".codex")).unwrap();
        std::fs::write(home.path().join(".codex/auth.json"), "{}").unwrap();
        let before = tree(&home.path().join(".codex"));
        let settings = full_settings(home.path());

        assert_eq!(settings.set(SETTING, &json!(true)), Some(Ok(())));
        let hooks: Value =
            serde_json::from_slice(&std::fs::read(home.path().join(".codex/hooks.json")).unwrap())
                .unwrap();
        for event in EVENTS {
            assert_eq!(
                hooks["hooks"][event][0]["hooks"][0]["command"],
                ours(),
                "{event}"
            );
        }
        let rules =
            std::fs::read_to_string(home.path().join(".codex/rules/agent-relay.rules")).unwrap();
        assert!(rules.starts_with(RULES_HEADER));
        assert!(home.path().join("app-data").join(CONFIG_CREATED).exists());
        // Brought up to date at start: no copy of Agent Relay's own file.
        settings.refresh();
        assert_eq!(settings.set(SETTING, &json!(true)), Some(Ok(())));

        assert_eq!(settings.set(SETTING, &json!(false)), Some(Ok(())));
        assert_eq!(tree(&home.path().join(".codex")), before);
        assert!(!home.path().join("app-data").join(CONFIG_CREATED).exists());
    }

    // A Codex home set up by a build from before the SessionStart entry
    // gains it at start, and turning the hook off still leaves the home as
    // it was before the hook was ever added.
    #[test]
    fn an_install_from_before_session_start_is_updated_and_still_comes_out_cleanly() {
        let home = tempfile::tempdir().unwrap();
        let codex = home.path().join(".codex");
        std::fs::create_dir_all(&codex).unwrap();
        std::fs::write(codex.join("auth.json"), "{}").unwrap();
        let before = tree(&codex);
        let entry = json!([{"hooks": [{"type": "command", "command": ours(), "timeout": 10}]}]);
        let older = json!({"hooks": {"Stop": entry, "PostToolUse": entry}});
        std::fs::write(
            codex.join("hooks.json"),
            serde_json::to_vec_pretty(&older).unwrap(),
        )
        .unwrap();
        let settings = full_settings(home.path());

        settings.refresh();
        let value: Value =
            serde_json::from_slice(&std::fs::read(codex.join("hooks.json")).unwrap()).unwrap();
        assert_eq!(value["hooks"]["SessionStart"], entry);
        assert!(
            !codex.join("hooks.json.relay-desktop-backup").exists(),
            "Agent Relay's own file is not the person's copy"
        );

        assert_eq!(settings.set(SETTING, &json!(false)), Some(Ok(())));
        assert_eq!(tree(&codex), before);
    }

    #[test]
    fn the_persons_own_hooks_config_and_rules_come_back_byte_for_byte() {
        let home = tempfile::tempdir().unwrap();
        let codex = home.path().join(".codex");
        std::fs::create_dir_all(codex.join("rules")).unwrap();
        // Their own formatting, which a JSON round trip would not keep.
        std::fs::write(
            codex.join("hooks.json"),
            "{ \"hooks\": {\"Stop\": [ {\"hooks\": [{\"type\":\"command\",\"command\":\"notify.sh\"}]} ],\n  \"SessionStart\": [] } }",
        )
        .unwrap();
        std::fs::write(
            codex.join("config.toml"),
            "# mine\nmodel = \"gpt-5\"   # trailing\n\n[hooks.state.\"/mine:stop:0:0\"]\ntrusted_hash = \"sha256:mine\"\n",
        )
        .unwrap();
        std::fs::write(
            codex.join("rules/default.rules"),
            "prefix_rule(pattern = [\"git\", \"status\"])\n",
        )
        .unwrap();
        let before = tree(&codex);
        let settings = full_settings(home.path());

        assert_eq!(settings.set(SETTING, &json!(true)), Some(Ok(())));
        assert!(codex.join("hooks.json.relay-desktop-backup").exists());
        assert!(codex.join("rules/agent-relay.rules").exists());
        assert!(!home.path().join("app-data").join(CONFIG_CREATED).exists());

        assert_eq!(settings.set(SETTING, &json!(false)), Some(Ok(())));
        assert_eq!(tree(&codex), before);
    }

    #[test]
    fn a_hooks_file_the_person_changed_since_keeps_their_change() {
        let home = tempfile::tempdir().unwrap();
        let codex = home.path().join(".codex");
        std::fs::create_dir_all(&codex).unwrap();
        let settings = full_settings(home.path());
        assert_eq!(settings.set(SETTING, &json!(true)), Some(Ok(())));
        let mut value: Value =
            serde_json::from_slice(&std::fs::read(codex.join("hooks.json")).unwrap()).unwrap();
        value["hooks"]["SessionStart"] =
            json!([{"hooks": [{"type": "command", "command": "start.sh"}]}]);
        std::fs::write(codex.join("hooks.json"), value.to_string()).unwrap();

        assert_eq!(settings.set(SETTING, &json!(false)), Some(Ok(())));
        let value: Value =
            serde_json::from_slice(&std::fs::read(codex.join("hooks.json")).unwrap()).unwrap();
        assert_eq!(
            value,
            json!({"hooks": {"SessionStart": [{"hooks": [{"type": "command", "command": "start.sh"}]}]}})
        );
        assert!(!codex.join("hooks.json.relay-desktop-backup").exists());
    }

    // What an earlier build left: a copy taken of a file that already held
    // the hook, which has nothing of the person's.
    #[test]
    fn an_earlier_builds_copy_of_its_own_file_goes_with_the_hook() {
        let home = tempfile::tempdir().unwrap();
        let codex = home.path().join(".codex");
        std::fs::create_dir_all(&codex).unwrap();
        let settings = full_settings(home.path());
        assert_eq!(settings.set(SETTING, &json!(true)), Some(Ok(())));
        std::fs::copy(
            codex.join("hooks.json"),
            codex.join("hooks.json.relay-desktop-backup"),
        )
        .unwrap();

        assert_eq!(settings.set(SETTING, &json!(false)), Some(Ok(())));
        assert!(!codex.join("hooks.json").exists());
        assert!(!codex.join("hooks.json.relay-desktop-backup").exists());
    }

    // Codex 0.163 matches its rules only against an unquoted program, so
    // the macOS app's helper (a path with spaces) asked for every read and
    // reply: the rules and hints name the core's link to it instead, the
    // socket stays quoted, and turning the hook off takes the link out.
    #[test]
    #[cfg(unix)]
    fn a_probe_path_with_a_space_is_named_by_its_link() {
        use crate::relay::probe_alias::{ProbeAlias, DIR};
        let home = tempfile::tempdir().unwrap();
        let codex = home.path().join(".codex");
        std::fs::create_dir_all(&codex).unwrap();
        let before = tree(&codex);
        let real = PathBuf::from("/Apps/Agent Relay.app/probe");
        let alias = Arc::new(ProbeAlias::new(
            real.clone(),
            home.path(),
            &home.path().join("app-data"),
            false,
        ));
        let settings = full_settings(home.path()).with_probe_alias(alias.clone());
        assert_eq!(settings.set(SETTING, &json!(true)), Some(Ok(())));
        let link = home.path().join(DIR).join("agent-relay-probe");
        assert_eq!(std::fs::read_link(&link).unwrap(), real);
        let named = link.display().to_string();
        let rules = std::fs::read_to_string(codex.join("rules/agent-relay.rules")).unwrap();
        assert_eq!(
            rules.matches("prefix_rule(").count(),
            crate::relay::session_cli::ALLOWED_SUBCOMMANDS.len()
        );
        let socket = "/Users/me/Library/Application Support/x/run/relay.sock";
        for subcommand in crate::relay::session_cli::ALLOWED_SUBCOMMANDS {
            assert!(rules.contains(&format!(
                "pattern = [\"{named}\", \"relay\", \"{subcommand}\", \"--socket\", \"{socket}\"]"
            )));
        }
        assert!(!rules.contains("socket-request"));
        assert!(!rules.contains("Agent Relay.app"));
        // The hints start with the link as one plain word, as the rules'
        // program; the socket is a quoted argument, which Codex matches.
        let reply = crate::relay::session_cli::SessionCommand::Send {
            recipient: crate::relay::session_cli::Recipient::To("alice".into()),
            reply_to: Some("m1".into()),
            thread: None,
        }
        .command_line(&link, Path::new(socket), Some("your reply"))
        .unwrap();
        assert!(reply.starts_with(&format!("{named} relay send --socket '{socket}' ")));
        let read =
            crate::relay::message_pointer::socket_reader(Some(&link), Path::new(socket)).unwrap();
        assert_eq!(read, format!("{named} relay read --socket '{socket}'"));
        // A core start brings it back after the link went missing.
        std::fs::remove_file(&link).unwrap();
        settings.refresh();
        assert_eq!(std::fs::read_link(&link).unwrap(), real);

        assert_eq!(settings.set(SETTING, &json!(false)), Some(Ok(())));
        assert!(std::fs::symlink_metadata(&link).is_err());
        assert!(!home.path().join(DIR).exists());
        assert_eq!(tree(&codex), before);
    }

    #[test]
    fn the_sandbox_rules_allow_only_this_probes_socket_commands() {
        let rules = SandboxRules {
            probe: PathBuf::from("/Apps/Agent Relay.app/probe"),
            socket: PathBuf::from("/s/relay.sock"),
        }
        .text();
        let count = crate::relay::session_cli::ALLOWED_SUBCOMMANDS.len();
        assert_eq!(rules.matches("prefix_rule(").count(), count);
        for subcommand in crate::relay::session_cli::ALLOWED_SUBCOMMANDS {
            assert!(rules.contains(&format!(
                "pattern = [\"/Apps/Agent Relay.app/probe\", \"relay\", \"{subcommand}\", \"--socket\", \"/s/relay.sock\"]"
            )), "{subcommand}");
        }
        // `socket-request` takes any method and path; a prefix rule could
        // not keep a relayed message from steering it to `PATCH /settings`.
        assert!(!rules.contains("socket-request"));
        assert_eq!(rules.matches("decision = \"allow\"").count(), count);
    }

    /// The commands a relayed message could steer Codex into, and whether
    /// Codex's own policy engine runs each without a prompt.
    fn hostile_and_intended(probe: &str, socket: &str) -> Vec<(Vec<String>, bool)> {
        let on = |words: &[&str]| -> Vec<String> {
            [probe, "relay"]
                .iter()
                .chain(words.iter())
                .map(|word| word.replace("SOCK", socket))
                .collect()
        };
        let mut cases = vec![
            (
                on(&["send", "--socket", "SOCK", "--to", "alice", "--body", "hi"]),
                true,
            ),
            (on(&["agents", "--socket", "SOCK"]), true),
            (on(&["whoami", "--socket", "SOCK"]), true),
            (
                on(&["subscribe-channel", "--socket", "SOCK", "swarm", "--remove"]),
                true,
            ),
            (on(&["read", "--socket", "SOCK", "0123456789ab"]), true),
            (
                on(&["fetch-attachment", "--socket", "SOCK", "file_1"]),
                true,
            ),
            (
                on(&[
                    "connect-send",
                    "--socket",
                    "SOCK",
                    "--to",
                    "host",
                    "--body",
                    "hi",
                ]),
                true,
            ),
            (
                on(&[
                    "send",
                    "--socket",
                    "/tmp/other.sock",
                    "--to",
                    "a",
                    "--body",
                    "x",
                ]),
                false,
            ),
            (
                on(&["settings", "--socket", "SOCK", "auto_join_general=true"]),
                false,
            ),
            (on(&["subscribe", "--socket", "SOCK", "acme/api#1"]), false),
        ];
        for (method, route) in crate::relay::outbound::SESSION_ROUTES {
            cases.push((
                on(&[
                    "socket-request",
                    "--socket",
                    "SOCK",
                    "--method",
                    method,
                    "--path",
                    route,
                    "--body",
                    "{}",
                ]),
                false,
            ));
        }
        cases
    }

    // The same check with Codex's own policy engine, when Codex is
    // installed (`codex execpolicy check`, verified with Codex 0.163): the
    // rules allow the self-limiting commands and nothing that reaches a
    // setting or registration route.
    #[test]
    fn codex_itself_allows_only_the_self_limiting_commands() {
        let Ok(codex) = which_codex() else {
            eprintln!("codex is not installed; skipped");
            return;
        };
        let home = tempfile::tempdir().unwrap();
        let probe = "/tmp/arc/bin/agent-relay-probe";
        let socket = "/Users/me/Library/Application Support/x/run/relay.sock";
        let file = home.path().join("agent-relay.rules");
        std::fs::write(
            &file,
            SandboxRules {
                probe: probe.into(),
                socket: socket.into(),
            }
            .text(),
        )
        .unwrap();
        for (command, allowed) in hostile_and_intended(probe, socket) {
            let output = std::process::Command::new(&codex)
                .env("CODEX_HOME", home.path())
                .args(["execpolicy", "check", "--rules"])
                .arg(&file)
                .args(&command)
                .output()
                .unwrap();
            assert!(output.status.success(), "{command:?}");
            let verdict: Value = serde_json::from_slice(&output.stdout).unwrap();
            assert_eq!(
                verdict["decision"] == "allow",
                allowed,
                "{command:?}: {verdict}"
            );
        }
    }

    fn which_codex() -> Result<PathBuf, ()> {
        let path = std::env::var_os("PATH").ok_or(())?;
        std::env::split_paths(&path)
            .map(|dir| dir.join("codex"))
            .find(|candidate| candidate.is_file())
            .ok_or(())
    }

    // An older core's rules (`relay socket-request`, which reached every
    // session route) are replaced on upgrade, also under a second name,
    // and turning the hook off still leaves `~/.codex` as it was.
    #[test]
    fn an_older_cores_rules_are_replaced_on_upgrade() {
        let home = tempfile::tempdir().unwrap();
        let codex = home.path().join(".codex");
        std::fs::create_dir_all(codex.join("rules")).unwrap();
        std::fs::write(codex.join("auth.json"), "{}").unwrap();
        std::fs::write(
            codex.join("rules/default.rules"),
            "prefix_rule(pattern = [\"git\", \"status\"])\n",
        )
        .unwrap();
        let before = tree(&codex);
        let older = format!(
            "{RULES_HEADER}\nprefix_rule(\n    pattern = [\"/Apps/Agent Relay.app/probe\", \"relay\", \"socket-request\", \"--socket\", \"/s\"],\n    decision = \"allow\",\n)\n"
        );
        std::fs::write(codex.join("rules/agent-relay.rules"), &older).unwrap();
        std::fs::write(codex.join("rules/agent-relay-2.rules"), &older).unwrap();
        let settings = full_settings(home.path());
        assert_eq!(settings.set(SETTING, &json!(true)), Some(Ok(())));
        let rules = std::fs::read_to_string(codex.join("rules/agent-relay.rules")).unwrap();
        assert!(!rules.contains("socket-request"), "{rules}");
        assert!(rules.contains("\"relay\", \"send\""));
        assert!(!codex.join("rules/agent-relay-2.rules").exists());
        // Already current: a refresh leaves it, and finds no stale copy.
        std::fs::write(codex.join("rules/agent-relay-3.rules"), &older).unwrap();
        settings.refresh();
        assert!(!codex.join("rules/agent-relay-3.rules").exists());
        assert_eq!(
            std::fs::read_to_string(codex.join("rules/agent-relay.rules")).unwrap(),
            rules
        );

        assert_eq!(settings.set(SETTING, &json!(false)), Some(Ok(())));
        assert_eq!(tree(&codex), before);
    }

    // Review on #2019: a file of the person's under the name must not leave
    // the hook on without the rules its replies need.
    #[test]
    fn a_rules_file_that_is_not_agent_relays_is_left_alone_and_the_rules_go_beside_it() {
        let home = tempfile::tempdir().unwrap();
        let codex = home.path().join(".codex");
        std::fs::create_dir_all(codex.join("rules")).unwrap();
        std::fs::write(codex.join("rules/agent-relay.rules"), "# mine\n").unwrap();
        let settings = full_settings(home.path());
        assert_eq!(settings.set(SETTING, &json!(true)), Some(Ok(())));
        assert_eq!(
            std::fs::read_to_string(codex.join("rules/agent-relay.rules")).unwrap(),
            "# mine\n"
        );
        let ours = std::fs::read_to_string(codex.join("rules/agent-relay-2.rules")).unwrap();
        assert!(ours.starts_with(RULES_HEADER));
        // Brought up to date in place, not copied to a third name.
        assert_eq!(settings.set(SETTING, &json!(true)), Some(Ok(())));
        assert!(!codex.join("rules/agent-relay-3.rules").exists());

        assert_eq!(settings.set(SETTING, &json!(false)), Some(Ok(())));
        assert_eq!(
            std::fs::read_to_string(codex.join("rules/agent-relay.rules")).unwrap(),
            "# mine\n"
        );
        assert!(!codex.join("rules/agent-relay-2.rules").exists());
    }

    // Review on #2019: a dangling link of the person's is not a free name.
    #[cfg(unix)]
    #[test]
    fn a_dangling_link_under_a_rules_name_is_left_alone() {
        let home = tempfile::tempdir().unwrap();
        let codex = home.path().join(".codex");
        std::fs::create_dir_all(codex.join("rules")).unwrap();
        std::fs::write(codex.join("rules/agent-relay.rules"), "# mine\n").unwrap();
        let link = codex.join("rules/agent-relay-2.rules");
        std::os::unix::fs::symlink(home.path().join("nowhere.rules"), &link).unwrap();
        let settings = full_settings(home.path());
        assert_eq!(settings.set(SETTING, &json!(true)), Some(Ok(())));
        assert!(std::fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(!home.path().join("nowhere.rules").exists());
        let ours = std::fs::read_to_string(codex.join("rules/agent-relay-3.rules")).unwrap();
        assert!(ours.starts_with(RULES_HEADER));
        assert_eq!(settings.set(SETTING, &json!(false)), Some(Ok(())));
        assert!(std::fs::symlink_metadata(&link).is_ok());
        assert!(!codex.join("rules/agent-relay-3.rules").exists());
    }

    // Review on #2019: Codex skips a linked rules file, so a link to the
    // very same rules does not count as having them.
    #[cfg(unix)]
    #[test]
    fn a_link_to_matching_rules_is_not_taken_for_them() {
        let home = tempfile::tempdir().unwrap();
        let codex = home.path().join(".codex");
        std::fs::create_dir_all(codex.join("rules")).unwrap();
        let settings = full_settings(home.path());
        let text = settings.sandbox.as_ref().unwrap().text();
        std::fs::write(home.path().join("copy.rules"), &text).unwrap();
        let link = codex.join("rules/agent-relay.rules");
        std::os::unix::fs::symlink(home.path().join("copy.rules"), &link).unwrap();
        assert_eq!(settings.set(SETTING, &json!(true)), Some(Ok(())));
        let plain = codex.join("rules/agent-relay-2.rules");
        assert!(std::fs::symlink_metadata(&plain)
            .unwrap()
            .file_type()
            .is_file());
        assert_eq!(std::fs::read_to_string(&plain).unwrap(), text);
        assert_eq!(settings.set(SETTING, &json!(false)), Some(Ok(())));
        assert!(std::fs::symlink_metadata(&link).is_ok(), "the link stays");
        assert!(!plain.exists());
    }

    // Review on #2019: rules that cannot be removed leave the setting to
    // try again, and a second try finishes the job.
    #[cfg(unix)]
    #[test]
    fn rules_that_cannot_be_removed_are_an_error_and_a_retry_removes_them() {
        use std::os::unix::fs::PermissionsExt;
        let home = tempfile::tempdir().unwrap();
        let codex = home.path().join(".codex");
        std::fs::create_dir_all(&codex).unwrap();
        let settings = full_settings(home.path());
        assert_eq!(settings.set(SETTING, &json!(true)), Some(Ok(())));
        let rules = codex.join("rules");
        std::fs::set_permissions(&rules, std::fs::Permissions::from_mode(0o500)).unwrap();
        // Root ignores the mode: there is nothing to refuse it, so the
        // retry path cannot be shown.
        if std::fs::write(rules.join(".probe"), b"").is_ok() {
            let _ = std::fs::remove_file(rules.join(".probe"));
            std::fs::set_permissions(&rules, std::fs::Permissions::from_mode(0o700)).unwrap();
            return;
        }
        let outcome = settings.set(SETTING, &json!(false));
        std::fs::set_permissions(&rules, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(matches!(outcome, Some(Err(_))), "{outcome:?}");
        assert!(rules.join("agent-relay.rules").exists());

        assert_eq!(settings.set(SETTING, &json!(false)), Some(Ok(())));
        assert!(!rules.exists());
        assert!(!codex.join("hooks.json").exists());
    }

    #[test]
    fn with_every_rules_name_taken_turning_on_fails() {
        let home = tempfile::tempdir().unwrap();
        let codex = home.path().join(".codex");
        std::fs::create_dir_all(codex.join("rules")).unwrap();
        let settings = full_settings(home.path());
        for path in settings.rules_files() {
            std::fs::write(path, "# mine\n").unwrap();
        }
        assert!(matches!(settings.set(SETTING, &json!(true)), Some(Err(_))));
    }

    // Review on #2019: an unreadable hooks.json may still hold the hook, so
    // turning it off is an error and nothing else is taken out.
    #[test]
    fn an_unreadable_hooks_file_is_an_error_when_turning_off() {
        let home = tempfile::tempdir().unwrap();
        let codex = home.path().join(".codex");
        std::fs::create_dir_all(&codex).unwrap();
        let settings = full_settings(home.path());
        assert_eq!(settings.set(SETTING, &json!(true)), Some(Ok(())));
        let broken = format!("{{ {} ", ours());
        std::fs::write(codex.join("hooks.json"), &broken).unwrap();
        assert!(matches!(settings.set(SETTING, &json!(false)), Some(Err(_))));
        assert_eq!(
            std::fs::read_to_string(codex.join("hooks.json")).unwrap(),
            broken
        );
        assert!(
            codex.join("rules/agent-relay.rules").exists(),
            "the rules stay with the hook"
        );
    }

    // Review on #2019: adding the hook makes `hooks` and its events, and
    // taking it out leaves an empty `hooks`: none of that is the person's.
    #[test]
    fn an_empty_hooks_file_comes_back_byte_for_byte() {
        for original in [
            "{}",
            "{ }\n",
            "{\"hooks\": {}}",
            "{\"hooks\": {\"Stop\": []}}",
            "{\"hooks\": {\"Stop\": [], \"PostToolUse\": []}, \"x\": 1}",
            "{\"hooks\": {\"SessionStart\": []}}",
        ] {
            let home = tempfile::tempdir().unwrap();
            let codex = home.path().join(".codex");
            std::fs::create_dir_all(&codex).unwrap();
            std::fs::write(codex.join("hooks.json"), original).unwrap();
            let settings = full_settings(home.path());
            assert_eq!(settings.set(SETTING, &json!(true)), Some(Ok(())));
            assert_eq!(settings.set(SETTING, &json!(false)), Some(Ok(())));
            assert_eq!(
                std::fs::read_to_string(codex.join("hooks.json")).unwrap(),
                original
            );
            assert!(
                !codex.join("hooks.json.relay-desktop-backup").exists(),
                "{original}"
            );
        }
    }

    #[test]
    fn the_setting_adds_and_removes_only_its_own_hook() {
        let home = tempfile::tempdir().unwrap();
        let (settings, trusted, inbox) = settings(home.path());
        assert!(settings.get().is_empty(), "no row without Codex");
        std::fs::create_dir_all(home.path().join(".codex")).unwrap();
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
        // After each tool call too, for messages to a running turn.
        let after_tools = value["hooks"]["PostToolUse"].as_array().unwrap();
        assert_eq!(after_tools.len(), 1);
        assert_eq!(after_tools[0], stop[1]);
        // And as a session starts, for its Agent Relay preamble, after the
        // person's own SessionStart hook.
        let start = value["hooks"]["SessionStart"].as_array().unwrap();
        assert_eq!(start.len(), 2);
        assert_eq!(start[0], theirs["hooks"]["SessionStart"][0]);
        assert_eq!(start[1], stop[1]);
        assert_eq!(trusted.lock().unwrap().len(), 1);
        assert_eq!(settings.get()[SETTING], true);
        assert!(settings.default_on().is_empty());
        // Turning it on again adds no second copy.
        assert_eq!(settings.set(SETTING, &json!(true)), Some(Ok(())));
        let value: Value =
            serde_json::from_slice(&std::fs::read(home.path().join(".codex/hooks.json")).unwrap())
                .unwrap();
        assert_eq!(value["hooks"]["Stop"].as_array().unwrap().len(), 2);
        assert_eq!(value["hooks"]["PostToolUse"].as_array().unwrap().len(), 1);
        assert_eq!(value["hooks"]["SessionStart"].as_array().unwrap().len(), 2);
        assert_eq!(trusted.lock().unwrap().len(), 2, "trusted again");

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
        assert_eq!(
            value["hooks"]["PostToolUse"][0]["hooks"][0]["command"],
            ours(),
            "an older copy for Stop alone gains the PostToolUse entry"
        );
        assert_eq!(
            value["hooks"]["SessionStart"][0]["hooks"][0]["command"],
            ours(),
            "and the SessionStart entry"
        );

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
