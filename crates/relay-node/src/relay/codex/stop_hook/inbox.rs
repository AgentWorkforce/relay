//! What the Codex hook hands over: relayed messages held for a Conductor
//! chat's turn end, and idle deliveries recapped there
//! (`super::CodexStopHookSettings` installs the hook that drains them).

use super::super::turn_hook::TurnInbox;
use crate::relay::conductor;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// The most threads remembered as already guided; past it the record starts
/// over, so a long-lived core holds a bounded set and a forgotten thread at
/// worst gets the command once more.
const GUIDED_LIMIT: usize = 4096;

/// The most idle deliveries one recap shows.
pub(super) const RECAP_LIMIT: usize = 10;

/// A relayed message waiting for its chat's turn to end.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Held {
    message_id: String,
    text: String,
}

/// A message delivered while its chat was idle, not yet shown in it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Unseen {
    message_ref: String,
    text: String,
}

#[derive(Default)]
pub(super) struct State {
    /// Lowercase thread ids already given the one registration command an
    /// unregistered chat gets (context, not a reason to keep a turn open).
    /// Bounded by [`GUIDED_LIMIT`].
    registration_guidance: HashSet<String>,
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
    pub(crate) fn needs_registration_guidance(&self, thread: &str) -> bool {
        !self
            .state()
            .registration_guidance
            .contains(&thread.to_lowercase())
    }

    /// Called only after the kernel-backed thread check succeeds.
    pub(crate) fn take_registration_guidance(&self, thread: &str) -> bool {
        let mut state = self.state();
        if state.registration_guidance.len() >= GUIDED_LIMIT {
            state.registration_guidance.clear();
        }
        state.registration_guidance.insert(thread.to_lowercase())
    }

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

pub(super) fn block(reason: &str) -> Value {
    json!({"decision": "block", "reason": reason})
}

/// `text` with Conductor's quote note after its header lines, unless it has
/// it: Conductor shows the agent's reply but not the hook's message.
pub(super) fn with_quote_note(text: &str) -> String {
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
pub(super) fn recap(answered: &[(Unseen, String)]) -> String {
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
