//! What a Codex thread's session file (its "rollout", one JSON event per
//! line) says about turns: whether one is running, how a turn ended, and
//! which turn a relayed message became.
//!
//! The rollout is the only place Codex durably records these, so delivery
//! reads it to stay out of a busy thread, to settle a handoff (a message is
//! delivered once its turn is recorded) and to find the final answer.

use super::threads;
use super::CodexConfig;
use crate::relay::delivery::policy::MessageRef;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TurnOutcome {
    Completed { reply: Option<String> },
    Aborted { reason: Option<String> },
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RolloutSummary {
    /// The turn that has started and not yet completed or aborted.
    pub active_turn: Option<String>,
    /// How each finished turn ended.
    pub outcomes: HashMap<String, TurnOutcome>,
    /// The turn each recorded user message belongs to, by the client id it
    /// was sent with.
    pub turn_by_client_message: HashMap<String, String>,
    /// The turn each relayed user message belongs to, by the reference in
    /// its attribution line (`MessageRef`). This is how a message that went
    /// in through `codex queue`, which assigns its own client id, is found.
    pub turn_by_message_ref: HashMap<String, String>,
    /// Turns a relayed message started: a `codex queue` delivery is a turn
    /// of its own, unlike one Agent Relay's Stop hook hands over inside a
    /// turn already running (`HookPrompt`).
    pub relay_turns: std::collections::HashSet<String>,
    /// Relayed messages written into the history as a hidden delivery
    /// (`compact::hidden_items`) writes them, still waiting for their turn:
    /// the next turn that shows no message of its own.
    pub hidden_refs: Vec<String>,
    /// Hidden messages tied to the running turn until it shows a message of
    /// its own: a turn the person starts gives them back to `hidden_refs`.
    provisional: Vec<String>,
    /// Whether the running turn started with a visible `UserMessage`.
    active_shows_message: bool,
    /// Whether the running turn completed anything else yet: a `UserMessage`
    /// after that is the person steering a turn already under way, not the
    /// message that started it.
    active_under_way: bool,
}

/// Lines that can matter; most lines are model output and are skipped
/// without parsing JSON.
const MARKERS: [&[u8]; 5] = [
    b"\"task_started\"",
    b"\"task_complete\"",
    b"\"turn_aborted\"",
    b"\"client_id\"",
    b"\"item_completed\"",
];

/// A hidden relay message's history item: a `response_item` carrying a relay
/// attribution. Checked on bytes, so model output is not parsed.
fn hidden_relay_item(line: &[u8]) -> bool {
    contains(line, b"\"response_item\"")
        && (contains(line, b"[via Agent Relay") || contains(line, b"[Relay Connect"))
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

/// Which file a path names now: its device and inode on Unix. Windows has
/// no stable inode in std, so its creation time stands in: a rollout
/// replaced by a new file under the same name gets a new one.
#[cfg(unix)]
fn file_identity(metadata: &std::fs::Metadata) -> (u64, u64) {
    use std::os::unix::fs::MetadataExt;
    (metadata.dev(), metadata.ino())
}

#[cfg(windows)]
fn file_identity(metadata: &std::fs::Metadata) -> (u64, u64) {
    metadata
        .created()
        .ok()
        .and_then(|created| created.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or((0, 0), |since| {
            (since.as_secs(), u64::from(since.subsec_nanos()))
        })
}

/// What was read of one rollout.
struct Cached {
    identity: (u64, u64),
    offset: u64,
    summary: RolloutSummary,
}

/// How many rollouts' summaries are kept.
const CACHED_ROLLOUTS: usize = 256;

static ROLLOUTS: std::sync::LazyLock<std::sync::Mutex<HashMap<PathBuf, Cached>>> =
    std::sync::LazyLock::new(Default::default);

fn text(value: &Value) -> Option<String> {
    value.as_str().map(str::to_string)
}

impl RolloutSummary {
    pub fn parse(contents: &[u8]) -> RolloutSummary {
        let mut summary = RolloutSummary::default();
        for line in contents.split(|byte| *byte == b'\n') {
            summary.consume(line);
        }
        summary
    }

    /// The summary of the file at `path`, or `None` when it cannot be read.
    pub fn read(path: &Path) -> Option<RolloutSummary> {
        Self::load(path).ok()
    }

    /// The summary of the file at `path`. Codex only appends to a rollout,
    /// so the summary of what was read before is kept and only the bytes
    /// written since are read and parsed; a replaced or shortened file is
    /// read again from the start.
    pub fn load(path: &Path) -> std::io::Result<RolloutSummary> {
        use std::io::{Read, Seek, SeekFrom};
        let mut file = std::fs::File::open(path)?;
        let metadata = file.metadata()?;
        let identity = file_identity(&metadata);
        let mut cache = ROLLOUTS.lock().unwrap_or_else(|e| e.into_inner());
        let mut entry = cache
            .remove(path)
            .filter(|e| e.identity == identity && e.offset <= metadata.len())
            .unwrap_or(Cached {
                identity,
                offset: 0,
                summary: RolloutSummary::default(),
            });
        file.seek(SeekFrom::Start(entry.offset))?;
        let mut added = Vec::new();
        file.read_to_end(&mut added)?;
        // Whole lines advance the kept summary; a line still being written
        // is read into this answer only, and again next time.
        let complete = added
            .iter()
            .rposition(|b| *b == b'\n')
            .map_or(0, |at| at + 1);
        for line in added[..complete].split(|b| *b == b'\n') {
            entry.summary.consume(line);
        }
        entry.offset += complete as u64;
        let mut summary = entry.summary.clone();
        summary.consume(&added[complete..]);
        if cache.len() >= CACHED_ROLLOUTS {
            cache.clear();
        }
        cache.insert(path.to_path_buf(), entry);
        Ok(summary)
    }

    /// The turn a message started, by the client id it was sent with (the
    /// app's window or app-server) or by the reference in its text (the
    /// queue).
    pub fn turn_for(&self, message_id: &str) -> Option<&str> {
        self.turn_by_client_message
            .get(message_id)
            .or_else(|| {
                self.turn_by_message_ref
                    .get(&crate::relay::delivery::policy::MessageRef::of(message_id))
            })
            .map(String::as_str)
    }

    pub fn is_idle(&self) -> bool {
        self.active_turn.is_none()
    }

    /// The reply of the turn the message carrying `message_ref` became, once
    /// that turn completed. A spawned agent's requester sends plain input,
    /// with no reference in its text: its turn is found by the client id it
    /// was started with, the full message id the reference is made from.
    pub fn reply_to(&self, message_ref: &str) -> Option<&str> {
        let turn = self.turn_by_message_ref.get(message_ref).or_else(|| {
            self.turn_by_client_message
                .iter()
                .find(|(client, _)| {
                    crate::relay::delivery::policy::MessageRef::of(client) == message_ref
                })
                .map(|(_, turn)| turn)
        })?;
        match self.outcomes.get(turn)? {
            TurnOutcome::Completed { reply } => reply.as_deref(),
            TurnOutcome::Aborted { .. } => None,
        }
    }

    fn consume(&mut self, line: &[u8]) {
        if !MARKERS.iter().any(|marker| contains(line, marker)) && !hidden_relay_item(line) {
            return;
        }
        let Ok(row) = serde_json::from_slice::<Value>(line) else {
            return;
        };
        if row["type"] == "response_item" {
            self.consume_history_item(&row["payload"]);
            return;
        }
        if row["type"] != "event_msg" {
            return;
        }
        let payload = &row["payload"];
        let Some(turn) = payload["turn_id"].as_str().map(str::to_string) else {
            return;
        };
        match payload["type"].as_str() {
            Some("task_started") => {
                self.active_turn = Some(turn.clone());
                self.active_shows_message = false;
                self.active_under_way = false;
                self.provisional.clear();
                for reference in std::mem::take(&mut self.hidden_refs) {
                    self.tie_hidden(reference, &turn);
                }
            }
            Some("task_complete") => {
                let reply = text(&payload["last_agent_message"]);
                self.finish(turn, TurnOutcome::Completed { reply });
            }
            Some("turn_aborted") => {
                let reason = text(&payload["reason"]);
                self.finish(turn, TurnOutcome::Aborted { reason });
            }
            Some("item_completed") if payload["item"]["type"] == "UserMessage" => {
                let item = &payload["item"];
                if let Some(client) = item["client_id"].as_str() {
                    self.turn_by_client_message
                        .insert(client.to_string(), turn.clone());
                }
                let reference = item["content"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|content| content["text"].as_str())
                    .find_map(MessageRef::in_text);
                // Only the message that started the turn says the turn was not
                // a hidden one; steering into a hidden turn keeps its match.
                if self.active_turn.as_deref() == Some(turn.as_str()) && !self.active_under_way {
                    self.active_shows_message = true;
                    self.give_back_hidden(&turn, reference.as_deref());
                }
                if let Some(reference) = reference {
                    self.relay_turns.insert(turn.clone());
                    self.turn_by_message_ref.insert(reference, turn);
                }
            }
            // A message Agent Relay's Stop hook handed over as a turn ended
            // (`codex::stop_hook`): Codex continues that same turn with it.
            Some("item_completed") if payload["item"]["type"] == "HookPrompt" => {
                let reference = payload["item"]["fragments"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|fragment| fragment["text"].as_str())
                    .find_map(MessageRef::in_text);
                if let Some(reference) = reference {
                    self.turn_by_message_ref.insert(reference, turn);
                }
            }
            // Anything else the turn completed: it is under way.
            Some("item_completed") => {
                if self.active_turn.as_deref() == Some(turn.as_str()) {
                    self.active_under_way = true;
                }
            }
            _ => {}
        }
    }

    /// A hidden relay message in the history: it belongs to the running turn
    /// while that turn shows no message of its own (a window writes it with
    /// the turn it starts), else it waits for the next such turn. A visible
    /// message's own history item is matched again by its `UserMessage`.
    fn consume_history_item(&mut self, payload: &Value) {
        if payload["type"] == "message" && payload["role"] == "developer" {
            self.consume_hook_context(payload);
            return;
        }
        if payload["type"] != "message" || payload["role"] != "user" {
            return;
        }
        let reference = payload["content"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|content| content["text"].as_str())
            .filter(|text| {
                text.starts_with("[via Agent Relay") || text.starts_with("[Relay Connect")
            })
            .find_map(MessageRef::in_text);
        // A message already tied to a turn keeps it (a visible message's own
        // history item can follow its UserMessage): the first match wins.
        let Some(reference) = reference.filter(|r| !self.turn_by_message_ref.contains_key(r))
        else {
            return;
        };
        match self.active_turn.clone() {
            Some(turn) if !self.active_shows_message => self.tie_hidden(reference, &turn),
            _ => {
                if !self.hidden_refs.contains(&reference) {
                    self.hidden_refs.push(reference);
                }
            }
        }
    }

    /// A message Agent Relay's PostToolUse hook handed over as additional
    /// context (`codex::turn_hook`): Codex writes it as a developer message
    /// of the running turn, the text as given, with no event of its own. It
    /// is recorded in that turn, which it did not start.
    fn consume_hook_context(&mut self, payload: &Value) {
        let reference = payload["content"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|content| content["text"].as_str())
            .find_map(MessageRef::in_text);
        let (Some(reference), Some(turn)) = (reference, self.active_turn.clone()) else {
            return;
        };
        self.turn_by_message_ref.entry(reference).or_insert(turn);
    }

    /// Ties a hidden message to `turn` until that turn shows its own message.
    fn tie_hidden(&mut self, reference: String, turn: &str) {
        self.relay_turns.insert(turn.to_string());
        self.turn_by_message_ref
            .insert(reference.clone(), turn.to_string());
        if !self.provisional.contains(&reference) {
            self.provisional.push(reference);
        }
    }

    /// `turn` showed a message (carrying `shown`, if a relay message): the
    /// hidden messages tied to it were not its, unless it is one of them,
    /// and wait for the next turn that shows nothing.
    fn give_back_hidden(&mut self, turn: &str, shown: Option<&str>) {
        for reference in std::mem::take(&mut self.provisional) {
            if Some(reference.as_str()) == shown {
                continue;
            }
            if self.turn_by_message_ref.get(&reference).map(String::as_str) == Some(turn) {
                self.turn_by_message_ref.remove(&reference);
            }
            if !self.hidden_refs.contains(&reference) {
                self.hidden_refs.push(reference);
            }
        }
        if shown.is_none() {
            self.relay_turns.remove(turn);
        }
    }

    fn finish(&mut self, turn: String, outcome: TurnOutcome) {
        if self.active_turn.as_deref() == Some(turn.as_str()) {
            self.active_turn = None;
            self.provisional.clear();
            self.active_shows_message = false;
        }
        self.outcomes.insert(turn, outcome);
    }
}

/// Where Codex keeps `thread`'s rollout: the thread row's `rollout_path`,
/// else the one `sessions/**/rollout-*-<thread>.jsonl` under Codex home
/// (builds whose state database has no rollout column).
pub fn rollout_path(config: &CodexConfig, thread: &str) -> Option<PathBuf> {
    if !crate::relay::store::is_uuid(thread) {
        return None;
    }
    if let Some(path) = threads::rollout_column(config, thread) {
        return Some(PathBuf::from(path));
    }
    let suffix = format!("-{}.jsonl", thread.to_lowercase());
    find_rollout(&config.home.join("sessions"), &suffix, 0)
}

/// Codex files rollouts as `sessions/<year>/<month>/<day>/`.
const SESSION_DEPTH: usize = 4;

fn find_rollout(directory: &Path, suffix: &str, depth: usize) -> Option<PathBuf> {
    if depth > SESSION_DEPTH {
        return None;
    }
    let entries = std::fs::read_dir(directory).ok()?;
    let mut directories = Vec::new();
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if kind.is_file() && name.starts_with("rollout-") && name.to_lowercase().ends_with(suffix) {
            return Some(entry.path());
        }
        if kind.is_dir() {
            directories.push(entry.path());
        }
    }
    directories.sort();
    directories
        .iter()
        .rev()
        .find_map(|child| find_rollout(child, suffix, depth + 1))
}

/// Whether a message carrying `message_ref` is recorded as a turn of
/// `thread`.
pub fn recorded(config: &CodexConfig, thread: &str, message_ref: &str) -> bool {
    rollout_path(config, thread)
        .and_then(|path| RolloutSummary::read(&path))
        .is_some_and(|summary| summary.turn_by_message_ref.contains_key(message_ref))
}

/// Whether a hidden delivery of the message carrying `message_ref` is in
/// `thread`'s history, still waiting for its turn.
pub fn hidden_waiting(config: &CodexConfig, thread: &str, message_ref: &str) -> bool {
    rollout_path(config, thread)
        .and_then(|path| RolloutSummary::read(&path))
        .is_some_and(|summary| summary.hidden_refs.iter().any(|r| r == message_ref))
}

/// The references of every hidden delivery in `thread`'s history still
/// waiting for its turn.
pub fn hidden_refs(config: &CodexConfig, thread: &str) -> Vec<String> {
    rollout_path(config, thread)
        .and_then(|path| RolloutSummary::read(&path))
        .map(|summary| summary.hidden_refs)
        .unwrap_or_default()
}

/// Whether a relayed message started `turn` of `thread`, as a `codex queue`
/// delivery does. Conductor does not show such a turn.
pub fn started_by_relay(config: &CodexConfig, thread: &str, turn: &str) -> bool {
    rollout_path(config, thread)
        .and_then(|path| RolloutSummary::read(&path))
        .is_some_and(|summary| summary.relay_turns.contains(turn))
}

/// Whether `thread` has no turn running. A thread with no rollout yet is
/// idle; one whose rollout cannot be read is not.
pub fn idle(config: &CodexConfig, thread: &str) -> bool {
    let Some(path) = rollout_path(config, thread) else {
        return true;
    };
    match RolloutSummary::load(&path) {
        Ok(summary) => summary.is_idle(),
        Err(error) => error.kind() == std::io::ErrorKind::NotFound,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::relay::delivery::final_answer::capped;

    const FIXTURE: &str = include_str!("../../../tests/fixtures/codex/rollout.jsonl");
    const REF: &str = "123456abcdef";
    const THREAD: &str = "01a0e91e-da81-7632-8367-789d27af58bd";

    fn config(home: &Path) -> CodexConfig {
        CodexConfig {
            home: home.to_path_buf(),
            sqlite_home: home.to_path_buf(),
            executable: None,
            ipc_socket: home.join("ipc/ipc.sock"),
        }
    }

    // CodexQueueCommandTests.testRolloutFindsAQueuedMessagesTurnByItsRef.
    #[test]
    fn a_queued_messages_turn_is_found_by_its_ref() {
        let reference = MessageRef::of("msg-1");
        let lines = [
            r#"{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-9"}}"#.to_string(),
            format!(
                r#"{{"type":"event_msg","payload":{{"type":"item_completed","turn_id":"turn-9","item":{{"type":"UserMessage","client_id":"codex-made-this-up","content":[{{"type":"text","text":"[via Agent Relay — from Alice · ref {reference}]\n\nhello"}}]}}}}}}"#
            ),
            r#"{"type":"event_msg","payload":{"type":"task_complete","turn_id":"turn-9","last_agent_message":"hi Alice"}}"#.to_string(),
        ];
        let summary = RolloutSummary::parse(lines.join("\n").as_bytes());
        assert_eq!(
            summary
                .turn_by_message_ref
                .get(&reference)
                .map(String::as_str),
            Some("turn-9")
        );
        assert_eq!(
            summary
                .turn_by_client_message
                .get("codex-made-this-up")
                .map(String::as_str),
            Some("turn-9")
        );
        assert_eq!(
            summary.outcomes.get("turn-9"),
            Some(&TurnOutcome::Completed {
                reply: Some("hi Alice".into())
            })
        );
        assert!(summary.is_idle());
        assert!(
            summary.relay_turns.contains("turn-9"),
            "a queued message's own turn"
        );
    }

    /// A hidden delivery's history item, as `thread/inject_items` or a
    /// window's `context.responseItems` writes it.
    fn hidden(message_id: &str) -> String {
        format!(
            r#"{{"type":"response_item","payload":{{"type":"message","role":"user","content":[{{"type":"input_text","text":"[via Agent Relay — from @alice (alice@host-1) to @codex-a · message {message_id} · ref {}]\n[reply: send_relay_message to=\"alice@host-1\"]\n\nhi"}}]}}}}"#,
            MessageRef::of(message_id)
        )
    }

    fn developer_note() -> String {
        r#"{"type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"Messages marked [via Agent Relay] come from peer agents."}]}}"#.to_string()
    }

    fn started(turn: &str) -> String {
        format!(r#"{{"type":"event_msg","payload":{{"type":"task_started","turn_id":"{turn}"}}}}"#)
    }

    fn completed(turn: &str, reply: &str) -> String {
        format!(
            r#"{{"type":"event_msg","payload":{{"type":"task_complete","turn_id":"{turn}","last_agent_message":"{reply}"}}}}"#
        )
    }

    // A hidden relay message is written to the history before its turn
    // starts, and the turn shows no message: the next turn is still its.
    #[test]
    fn a_hidden_messages_turn_is_found_by_its_ref() {
        let lines = [
            developer_note(),
            hidden("hidden-1"),
            started("turn-h1"),
            r#"{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Sent HIDDEN-1 on the relay."}]}}"#.to_string(),
            completed("turn-h1", "Sent HIDDEN-1 on the relay."),
        ];
        let summary = RolloutSummary::parse(lines.join("\n").as_bytes());
        let reference = MessageRef::of("hidden-1");
        assert_eq!(summary.turn_for("hidden-1"), Some("turn-h1"));
        assert!(summary.relay_turns.contains("turn-h1"));
        assert_eq!(
            summary.reply_to(&reference),
            Some("Sent HIDDEN-1 on the relay.")
        );
        assert!(summary.hidden_refs.is_empty());
        assert!(summary.is_idle());
    }

    // A visible message is written inside its own turn and is read from its
    // UserMessage item; a hidden one before the next turn is that turn's,
    // whichever comes first.
    #[test]
    fn hidden_and_visible_messages_each_find_their_own_turn() {
        let visible_ref = MessageRef::of("visible-1");
        let visible = |turn: &str| {
            [
                format!(
                    r#"{{"type":"response_item","payload":{{"type":"message","role":"user","content":[{{"type":"input_text","text":"[via Agent Relay — from Bob · ref {visible_ref}]\n\nyo"}}]}}}}"#
                ),
                format!(
                    r#"{{"type":"event_msg","payload":{{"type":"item_completed","turn_id":"{turn}","item":{{"type":"UserMessage","client_id":"visible-1","content":[{{"type":"text","text":"[via Agent Relay — from Bob · ref {visible_ref}]\n\nyo"}}]}}}}}}"#
                ),
            ]
        };
        let [v1, v2] = visible("turn-v");
        let lines = [
            started("turn-v"),
            v1,
            v2,
            completed("turn-v", "yo back"),
            hidden("hidden-2"),
            started("turn-h2"),
            completed("turn-h2", "ok"),
        ];
        let summary = RolloutSummary::parse(lines.join("\n").as_bytes());
        assert_eq!(summary.turn_for("visible-1"), Some("turn-v"));
        assert_eq!(summary.turn_for("hidden-2"), Some("turn-h2"));
        let [v1, v2] = visible("turn-v2");
        let lines = [
            hidden("hidden-3"),
            started("turn-h3"),
            completed("turn-h3", "ok"),
            started("turn-v2"),
            v1,
            v2,
            completed("turn-v2", "yo back"),
        ];
        let summary = RolloutSummary::parse(lines.join("\n").as_bytes());
        assert_eq!(summary.turn_for("hidden-3"), Some("turn-h3"));
        assert_eq!(summary.turn_for("visible-1"), Some("turn-v2"));
        assert!(!summary.relay_turns.is_empty());
    }

    // Two hidden messages, each followed by its own turn, are each found;
    // two written before one turn (a turn that failed to start) both belong
    // to the turn that then ran, which read them both.
    #[test]
    fn hidden_messages_back_to_back_find_their_turns() {
        let lines = [
            hidden("hidden-4"),
            started("turn-4"),
            completed("turn-4", "one"),
            hidden("hidden-5"),
            started("turn-5"),
            completed("turn-5", "two"),
        ];
        let summary = RolloutSummary::parse(lines.join("\n").as_bytes());
        assert_eq!(summary.turn_for("hidden-4"), Some("turn-4"));
        assert_eq!(summary.turn_for("hidden-5"), Some("turn-5"));
        let lines = [
            hidden("hidden-6"),
            hidden("hidden-7"),
            started("turn-67"),
            completed("turn-67", "both"),
        ];
        let summary = RolloutSummary::parse(lines.join("\n").as_bytes());
        assert_eq!(summary.turn_for("hidden-6"), Some("turn-67"));
        assert_eq!(summary.turn_for("hidden-7"), Some("turn-67"));
    }

    /// The person's own message, shown in `turn`.
    fn persons_message(turn: &str) -> String {
        format!(
            r#"{{"type":"event_msg","payload":{{"type":"item_completed","turn_id":"{turn}","item":{{"type":"UserMessage","client_id":"person-1","content":[{{"type":"text","text":"please fix the build"}}]}}}}}}"#
        )
    }

    // #550 review: a requester's native turn carries no reference in its
    // text; its answer is found by the client id it was started with.
    #[test]
    fn a_native_turn_is_answered_by_its_client_message_id() {
        let lines = [
            started("turn-n"),
            format!(
                r#"{{"type":"event_msg","payload":{{"type":"item_completed","turn_id":"turn-n","item":{{"type":"UserMessage","client_id":"msg-123","content":[{{"type":"text","text":"Please check CI"}}]}}}}}}"#
            ),
            completed("turn-n", "CI is green"),
        ];
        let summary = RolloutSummary::parse(lines.join("\n").as_bytes());
        assert_eq!(
            summary.reply_to(&MessageRef::of("msg-123")),
            Some("CI is green")
        );
        assert_eq!(summary.reply_to(&MessageRef::of("msg-999")), None);
    }

    // Bugbot #510: a window can write the hidden items with the turn it
    // starts, after task_started; the turn, which shows nothing, is theirs.
    #[test]
    fn a_hidden_message_written_inside_its_turn_is_found() {
        let lines = [
            started("turn-w"),
            developer_note(),
            hidden("hidden-w"),
            completed("turn-w", "Sent HIDDEN-W on the relay."),
        ];
        let summary = RolloutSummary::parse(lines.join("\n").as_bytes());
        assert_eq!(summary.turn_for("hidden-w"), Some("turn-w"));
        assert!(summary.relay_turns.contains("turn-w"));
        assert_eq!(
            summary.reply_to(&MessageRef::of("hidden-w")),
            Some("Sent HIDDEN-W on the relay.")
        );
    }

    // Bugbot #510: a hidden message whose own turn never started is not the
    // turn the person starts next; it waits for the next turn that shows
    // nothing, and the person's reply is never taken for its answer.
    #[test]
    fn a_persons_turn_does_not_take_a_waiting_hidden_message() {
        let lines = [
            hidden("hidden-p"),
            started("turn-person"),
            persons_message("turn-person"),
            completed("turn-person", "fixed the build"),
        ];
        let summary = RolloutSummary::parse(lines.join("\n").as_bytes());
        assert_eq!(summary.turn_for("hidden-p"), None);
        assert_eq!(summary.reply_to(&MessageRef::of("hidden-p")), None);
        assert!(!summary.relay_turns.contains("turn-person"));
        assert_eq!(summary.hidden_refs, [MessageRef::of("hidden-p")]);
        let mut lines = lines.to_vec();
        lines.extend([started("turn-relay"), completed("turn-relay", "Sent it.")]);
        let summary = RolloutSummary::parse(lines.join("\n").as_bytes());
        assert_eq!(summary.turn_for("hidden-p"), Some("turn-relay"));
        assert_eq!(
            summary.reply_to(&MessageRef::of("hidden-p")),
            Some("Sent it.")
        );
        assert!(summary.hidden_refs.is_empty());
    }

    // A hidden item written inside a turn that already shows the person's
    // message is not that turn's either.
    #[test]
    fn a_hidden_message_inside_a_persons_turn_waits() {
        let lines = [
            started("turn-person"),
            persons_message("turn-person"),
            hidden("hidden-q"),
            completed("turn-person", "done"),
            started("turn-relay"),
            completed("turn-relay", "Sent Q."),
        ];
        let summary = RolloutSummary::parse(lines.join("\n").as_bytes());
        assert_eq!(summary.turn_for("hidden-q"), Some("turn-relay"));
        assert!(!summary.relay_turns.contains("turn-person"));
    }

    /// An agent item completed in `turn`, as Codex records its work.
    fn agent_item(turn: &str) -> String {
        format!(
            r#"{{"type":"event_msg","payload":{{"type":"item_completed","turn_id":"{turn}","item":{{"type":"AgentMessage","content":[{{"type":"Text","text":"On it."}}]}}}}}}"#
        )
    }

    // Greptile #510: the person steering into a running hidden turn adds a
    // UserMessage after the turn is under way; the turn stays the relay
    // message's, and its answer is still found.
    #[test]
    fn steering_into_a_hidden_turn_keeps_its_relay_message() {
        let lines = [
            hidden("hidden-s"),
            started("turn-s"),
            agent_item("turn-s"),
            persons_message("turn-s"),
            completed("turn-s", "Sent S, and fixed the build."),
        ];
        let summary = RolloutSummary::parse(lines.join("\n").as_bytes());
        assert_eq!(summary.turn_for("hidden-s"), Some("turn-s"));
        assert!(summary.relay_turns.contains("turn-s"));
        assert_eq!(
            summary.reply_to(&MessageRef::of("hidden-s")),
            Some("Sent S, and fixed the build.")
        );
        assert!(summary.hidden_refs.is_empty());
    }

    // Bugbot #510: a visible relay message's history item written after its
    // UserMessage does not wait for another turn, which would take it over.
    #[test]
    fn a_settled_message_is_not_moved_to_a_later_turn() {
        let reference = MessageRef::of("visible-2");
        let text = format!("[via Agent Relay — from Bob · ref {reference}]\\n\\nyo");
        let lines = [
            started("turn-v"),
            format!(
                r#"{{"type":"event_msg","payload":{{"type":"item_completed","turn_id":"turn-v","item":{{"type":"UserMessage","client_id":"visible-2","content":[{{"type":"text","text":"{text}"}}]}}}}}}"#
            ),
            format!(
                r#"{{"type":"response_item","payload":{{"type":"message","role":"user","content":[{{"type":"input_text","text":"{text}"}}]}}}}"#
            ),
            completed("turn-v", "yo back"),
            started("turn-later"),
            completed("turn-later", "something else"),
        ];
        let summary = RolloutSummary::parse(lines.join("\n").as_bytes());
        assert_eq!(summary.turn_for("visible-2"), Some("turn-v"));
        assert_eq!(summary.reply_to(&reference), Some("yo back"));
        assert!(summary.hidden_refs.is_empty());
        assert!(!summary.relay_turns.contains("turn-later"));
    }

    // A hidden item read before its turn starts is kept across reads, so the
    // cached, appended-to summary still ties it to the turn written later.
    #[test]
    fn a_hidden_message_waits_across_appended_reads() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rollout.jsonl");
        std::fs::write(&path, format!("{}\n", hidden("hidden-8"))).unwrap();
        let first = RolloutSummary::load(&path).unwrap();
        assert_eq!(first.turn_for("hidden-8"), None);
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        use std::io::Write;
        writeln!(file, "{}", started("turn-8")).unwrap();
        let second = RolloutSummary::load(&path).unwrap();
        assert_eq!(second.turn_for("hidden-8"), Some("turn-8"));
    }

    // A Stop hook continues the person's turn: Codex records the relayed
    // message as a HookPrompt in that turn, and its reply ends the turn.
    #[test]
    fn a_message_a_stop_hook_handed_over_is_found_in_that_turn() {
        let reference = MessageRef::of("msg-2");
        let lines = [
            r#"{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-3"}}"#.to_string(),
            format!(
                r#"{{"type":"event_msg","payload":{{"type":"item_completed","thread_id":"t","turn_id":"turn-3","item":{{"type":"HookPrompt","id":"m","fragments":[{{"text":"[via Agent Relay — from @alice to @codex-api · message msg-2 · ref {reference}]\n\nhello","hookRunId":"stop:7:/h/hooks.json"}}]}}}}}}"#
            ),
            r#"{"type":"event_msg","payload":{"type":"task_complete","turn_id":"turn-3","last_agent_message":"> hello\n\nhi Alice"}}"#.to_string(),
        ];
        let summary = RolloutSummary::parse(lines.join("\n").as_bytes());
        assert_eq!(
            summary
                .turn_by_message_ref
                .get(&reference)
                .map(String::as_str),
            Some("turn-3")
        );
        assert_eq!(summary.reply_to(&reference), Some("> hello\n\nhi Alice"));
        assert!(
            summary.relay_turns.is_empty(),
            "the person's turn, continued"
        );
    }

    // Codex 0.159, 2026-10-26: a PostToolUse hook's additionalContext is
    // written as a developer message of the running turn, with no event of
    // its own. The message is recorded in that turn, which it did not start.
    #[test]
    fn a_message_a_post_tool_use_hook_handed_over_is_found_in_that_turn() {
        let reference = MessageRef::of("msg-4");
        let context = |reference: &str| {
            format!(
                r#"{{"timestamp":"2026-10-26T06:59:47.223Z","ordinal":15,"type":"response_item","payload":{{"type":"message","id":"msg_01a1","role":"developer","content":[{{"type":"input_text","text":"[via Agent Relay — from @alice · ref {reference}]\n\nCheck CI too."}}],"internal_chat_message":true}}}}"#
            )
        };
        let lines = [
            started("turn-4"),
            format!(
                r#"{{"type":"event_msg","payload":{{"type":"item_completed","turn_id":"turn-4","item":{{"type":"UserMessage","content":[{{"type":"text","text":"run the tests"}}]}}}}}}"#
            ),
            r#"{"type":"event_msg","payload":{"type":"item_completed","turn_id":"turn-4","item":{"type":"CommandExecution"}}}"#.to_string(),
            context(&reference),
            completed("turn-4", "Tests pass; CI is green."),
            // Outside a turn it belongs to none.
            context(&MessageRef::of("msg-5")),
        ];
        let summary = RolloutSummary::parse(lines.join("\n").as_bytes());
        assert_eq!(summary.turn_for("msg-4"), Some("turn-4"));
        assert_eq!(
            summary.reply_to(&reference),
            Some("Tests pass; CI is green.")
        );
        assert!(
            summary.relay_turns.is_empty(),
            "the person's turn, continued"
        );
        assert!(summary.hidden_refs.is_empty());
        assert_eq!(summary.turn_for("msg-5"), None);
        // Codex's own developer notes are not relay messages.
        let note =
            RolloutSummary::parse([started("turn-6"), developer_note()].join("\n").as_bytes());
        assert!(note.turn_by_message_ref.is_empty());
    }

    // InjectableRepliesTests.testCodexCompletionRequiresMatchingRefAndCompletedTurn.
    #[test]
    fn a_final_answer_needs_the_matching_ref_and_a_completed_turn() {
        let answer = |text: &str, reference: &str| {
            RolloutSummary::parse(text.as_bytes())
                .reply_to(reference)
                .and_then(capped)
        };
        assert_eq!(answer(FIXTURE, REF).as_deref(), Some("Codex answer"));
        assert_eq!(answer(FIXTURE, "000000000000"), None);
        assert_eq!(
            answer(&FIXTURE.replace("task_complete", "turn_aborted"), REF),
            None
        );
        let running: Vec<&str> = FIXTURE.lines().collect();
        assert_eq!(answer(&running[..running.len() - 1].join("\n"), REF), None);
    }

    // test_injectable._codex_idle: only the active turn's end makes it idle.
    #[test]
    fn only_the_active_turns_end_makes_it_idle() {
        let started = r#"{"type":"event_msg","payload":{"type":"task_started","turn_id":"b"}}"#;
        let other_ends = r#"{"type":"event_msg","payload":{"type":"task_complete","turn_id":"a"}}"#;
        let summary = RolloutSummary::parse(format!("{started}\n{other_ends}\n").as_bytes());
        assert_eq!(summary.active_turn.as_deref(), Some("b"));
        let aborted = r#"{"type":"event_msg","payload":{"type":"turn_aborted","turn_id":"b","reason":"interrupted"}}"#;
        let summary = RolloutSummary::parse(format!("{started}\n{aborted}").as_bytes());
        assert!(summary.is_idle());
        assert_eq!(
            summary.outcomes.get("b"),
            Some(&TurnOutcome::Aborted {
                reason: Some("interrupted".into())
            })
        );
    }

    // CodexIncomingRoutes.recorded / idle and test_rollout_reference_is_found_without_threads_table.
    #[test]
    fn the_rollout_is_found_without_a_threads_table() {
        let home = tempfile::tempdir().unwrap();
        let config = config(home.path());
        // No rollout yet: idle, nothing recorded.
        assert!(idle(&config, THREAD));
        assert!(!recorded(&config, THREAD, REF));
        let day = home.path().join("sessions/2026/09/30");
        std::fs::create_dir_all(&day).unwrap();
        let rollout = day.join(format!("rollout-2026-09-30T12-00-00-{THREAD}.jsonl"));
        let lines: Vec<&str> = FIXTURE.lines().collect();
        std::fs::write(&rollout, lines[..2].join("\n")).unwrap();
        assert_eq!(rollout_path(&config, THREAD), Some(rollout.clone()));
        assert!(recorded(&config, THREAD, REF));
        assert!(!recorded(&config, THREAD, "000000000000"));
        assert!(!idle(&config, THREAD));
        std::fs::write(&rollout, FIXTURE).unwrap();
        assert!(idle(&config, THREAD));
        assert_eq!(rollout_path(&config, "not-a-thread"), None);
    }

    // CodexBridge.rolloutURL: the thread row names the rollout.
    #[test]
    fn the_thread_row_names_the_rollout() {
        let home = tempfile::tempdir().unwrap();
        let config = config(home.path());
        let elsewhere = home.path().join("elsewhere.jsonl");
        std::fs::write(&elsewhere, FIXTURE).unwrap();
        let db = rusqlite::Connection::open(home.path().join("state_5.sqlite")).unwrap();
        db.execute_batch("create table threads (id text, rollout_path text)")
            .unwrap();
        db.execute(
            "insert into threads values (?1, ?2)",
            (THREAD, elsewhere.to_str().unwrap()),
        )
        .unwrap();
        assert_eq!(rollout_path(&config, THREAD), Some(elsewhere));
        assert!(recorded(&config, THREAD, REF));
        // A rollout that cannot be read is not idle.
        std::fs::create_dir(home.path().join("dir.jsonl")).unwrap();
        db.execute(
            "update threads set rollout_path = ?1",
            [home.path().join("dir.jsonl").to_str().unwrap()],
        )
        .unwrap();
        assert!(!idle(&config, THREAD));
    }

    // Review: a growing rollout is read from where the last read stopped.
    #[test]
    fn a_growing_rollout_is_read_incrementally() {
        use std::io::Write;
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join("rollout.jsonl");
        let lines: Vec<&str> = FIXTURE.lines().collect();
        std::fs::write(&path, format!("{}\n{}", lines[0], &lines[1][..20])).unwrap();
        let first = RolloutSummary::load(&path).unwrap();
        assert!(!first.is_idle());
        assert!(first.turn_by_message_ref.is_empty());
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        write!(file, "{}\n{}", &lines[1][20..], lines[2]).unwrap();
        let grown = RolloutSummary::load(&path).unwrap();
        assert_eq!(grown, RolloutSummary::parse(FIXTURE.as_bytes()));
        assert_eq!(grown.reply_to(REF), Some("Codex answer"));
        // A file replaced by a shorter one is read from the start.
        std::fs::remove_file(&path).unwrap();
        std::fs::write(&path, lines[0]).unwrap();
        assert_eq!(
            RolloutSummary::load(&path).unwrap(),
            RolloutSummary::parse(lines[0].as_bytes())
        );
        assert!(ROLLOUTS
            .lock()
            .unwrap()
            .get(&path)
            .is_some_and(|c| c.offset == 0));
    }
}
