//! A fail-closed, advisory text tap for a Relay DM's exact Codex turn.
//!
//! The command watcher sees every loaded thread. Merely seeing a Codex event
//! is therefore never authority to forward it: a verified delivery must arm
//! the exact `(thread, turn, message_id, request_id)` after `turn/start` has
//! confirmed `clientUserMessageId = message_id`. This module does not provide
//! the person-facing ingress or authorize a caller to read its events.

use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};

const MAX_ACTIVE: usize = 32;
const MAX_ITEMS_PER_TURN: usize = 64;
const MAX_BACKLOG: usize = 512;
// Cloud's proposed voice event contract accepts at most 4096 UTF-16 units of
// text per delta. Splitting here avoids an advisory gap at that boundary.
const MAX_EVENT_UNITS: usize = 4096;
const MAX_EVENT_BYTES: usize = 4096;
const MAX_ANSWER_BYTES: usize = 64 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct AnswerDelta {
    pub thread_id: String,
    pub turn_id: String,
    pub message_id: String,
    pub request_id: String,
    pub seq: u64,
    pub text: String,
}

#[derive(Default)]
struct Active {
    message_id: String,
    request_id: String,
    allowed_items: HashSet<String>,
    seq: u64,
    bytes: usize,
}

/// An exact-turn filter and bounded advisory backlog. A missing event means
/// the future stream consumer must reconcile with the durable final DM.
#[derive(Default)]
pub(crate) struct AnswerTap {
    active: HashMap<(String, String), Active>,
    backlog: VecDeque<AnswerDelta>,
}

impl AnswerTap {
    pub fn arm(&mut self, thread: &str, turn: &str, message_id: &str, request_id: &str) -> bool {
        let (Some(thread), Some(turn)) = (uuid(thread), uuid(turn)) else {
            return false;
        };
        if !plain_id(message_id) || !plain_id(request_id) {
            return false;
        }
        let key = (thread, turn);
        if let Some(existing) = self.active.get(&key) {
            // Never let a later request relabel an active turn's text.
            return existing.message_id == message_id && existing.request_id == request_id;
        }
        if self.active.len() >= MAX_ACTIVE {
            return false;
        }
        self.active.insert(
            key,
            Active {
                message_id: message_id.into(),
                request_id: request_id.into(),
                ..Active::default()
            },
        );
        true
    }

    /// Accept only text deltas for an explicitly user-facing agentMessage
    /// item in the armed turn. Reasoning, tool output, plan and unknown-phase
    /// messages are never copied into the backlog.
    pub fn observe(&mut self, message: &Value) {
        let params = &message["params"];
        match message["method"].as_str() {
            Some("thread/status/changed")
                if matches!(
                    params["status"]["type"].as_str(),
                    Some("idle" | "notLoaded" | "systemError")
                ) =>
            {
                if let Some(thread) = uuid_value(&params["threadId"]) {
                    self.active.retain(|(candidate, _), _| candidate != &thread);
                }
                return;
            }
            Some("thread/closed" | "thread/archived") => {
                if let Some(thread) = uuid_value(&params["threadId"]) {
                    self.active.retain(|(candidate, _), _| candidate != &thread);
                }
                return;
            }
            Some("turn/completed") => {
                if let (Some(thread), Some(turn)) = (
                    uuid_value(&params["threadId"]),
                    uuid_value(&params["turn"]["id"]),
                ) {
                    self.active.remove(&(thread, turn));
                }
                return;
            }
            _ => {}
        }
        let (Some(thread), Some(turn)) = (
            uuid_value(&params["threadId"]),
            uuid_value(&params["turnId"]),
        ) else {
            return;
        };
        let key = (thread, turn);
        match message["method"].as_str() {
            Some("item/started") => {
                let Some(active) = self.active.get_mut(&key) else {
                    return;
                };
                let item = &params["item"];
                let Some(item_id) = item["id"].as_str().filter(|id| plain_id(id)) else {
                    return;
                };
                active.allowed_items.remove(item_id);
                // Phase is explicit in current Codex protocol. Unknown and
                // commentary phases are not presumed to be answer text.
                if item["type"] == "agentMessage"
                    && matches!(
                        item["phase"].as_str(),
                        Some("partial_answer" | "final_answer")
                    )
                {
                    if active.allowed_items.len() >= MAX_ITEMS_PER_TURN {
                        // A turn that never reports item completion cannot
                        // grow its retained ID set without bound.
                        self.active.remove(&key);
                        return;
                    }
                    active.allowed_items.insert(item_id.into());
                }
            }
            Some("item/completed") => {
                if let Some(active) = self.active.get_mut(&key) {
                    if let Some(item_id) = params["item"]["id"].as_str() {
                        active.allowed_items.remove(item_id);
                    }
                }
            }
            Some("item/agentMessage/delta") => {
                let Some(active) = self.active.get_mut(&key) else {
                    return;
                };
                let Some(item_id) = params["itemId"].as_str() else {
                    return;
                };
                if !active.allowed_items.contains(item_id) {
                    return;
                }
                let Some(text) = params["delta"].as_str().filter(|text| !text.is_empty()) else {
                    return;
                };
                let chunks = split_utf16(text);
                if active.bytes.saturating_add(text.len()) > MAX_ANSWER_BYTES
                    || self.backlog.len().saturating_add(chunks.len()) > MAX_BACKLOG
                {
                    // Stop advisory streaming on overflow; the durable DM
                    // remains the only complete answer source.
                    self.active.remove(&key);
                    return;
                }
                active.bytes += text.len();
                for chunk in chunks {
                    active.seq += 1;
                    self.backlog.push_back(AnswerDelta {
                        thread_id: key.0.clone(),
                        turn_id: key.1.clone(),
                        message_id: active.message_id.clone(),
                        request_id: active.request_id.clone(),
                        seq: active.seq,
                        text: chunk.into(),
                    });
                }
            }
            _ => {}
        }
    }

    pub fn take(
        &mut self,
        thread: &str,
        turn: &str,
        message_id: &str,
        request_id: &str,
    ) -> Vec<AnswerDelta> {
        let (Some(thread), Some(turn)) = (uuid(thread), uuid(turn)) else {
            return Vec::new();
        };
        let mut selected = Vec::new();
        self.backlog.retain(|event| {
            let matching = event.thread_id == thread
                && event.turn_id == turn
                && event.message_id == message_id
                && event.request_id == request_id;
            if matching {
                selected.push(event.clone());
            }
            !matching
        });
        selected
    }

    pub fn disconnect(&mut self) {
        // A gap across watcher reconnection cannot be replayed from here.
        // Discard text so no later request can see a misleading partial
        // answer; the durable DM remains the fallback.
        self.active.clear();
        self.backlog.clear();
    }
}

fn uuid(value: &str) -> Option<String> {
    crate::relay::store::is_uuid(value).then(|| value.to_ascii_lowercase())
}

fn uuid_value(value: &Value) -> Option<String> {
    value.as_str().and_then(uuid)
}

fn plain_id(value: &str) -> bool {
    (1..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

/// Split without breaking a Unicode scalar or exceeding Cloud's UTF-16-unit
/// limit. Every event remains a contiguous piece of the source delta.
fn split_utf16(text: &str) -> Vec<&str> {
    let mut chunks = Vec::new();
    let mut start = 0;
    let mut units = 0;
    let mut bytes = 0;
    for (at, character) in text.char_indices() {
        let character_units = character.len_utf16();
        let character_bytes = character.len_utf8();
        if units + character_units > MAX_EVENT_UNITS || bytes + character_bytes > MAX_EVENT_BYTES {
            chunks.push(&text[start..at]);
            start = at;
            units = 0;
            bytes = 0;
        }
        units += character_units;
        bytes += character_bytes;
    }
    chunks.push(&text[start..]);
    chunks
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const THREAD: &str = "01a21142-16fe-7e80-b155-63c55d494a65";
    const OTHER: &str = "01a21131-493f-7f80-a01b-d9e5a4779f64";
    const TURN: &str = "019ac390-a744-7d20-a7a2-8d14afc27b8f";
    const OTHER_TURN: &str = "019ac390-a744-7d20-a7a2-8d14afc27b90";

    fn start(thread: &str, turn: &str, item: &str, phase: Value) -> Value {
        json!({"method":"item/started","params":{"threadId":thread,"turnId":turn,
            "item":{"type":"agentMessage","id":item,"phase":phase}}})
    }
    fn delta(thread: &str, turn: &str, item: &str, text: &str) -> Value {
        json!({"method":"item/agentMessage/delta","params":{
            "threadId":thread,"turnId":turn,"itemId":item,"delta":text}})
    }

    #[test]
    fn only_exact_armed_user_facing_answer_items_stream_in_order() {
        let mut tap = AnswerTap::default();
        let item = "msg-1";
        tap.observe(&start(THREAD, TURN, item, json!("final_answer")));
        tap.observe(&delta(THREAD, TURN, item, "before arm"));
        assert!(tap.arm(THREAD, TURN, "relay-1", "voice-1"));
        assert!(!tap.arm(THREAD, TURN, "relay-2", "voice-2"));
        tap.observe(&delta(THREAD, TURN, item, "before item"));
        tap.observe(&start(THREAD, TURN, item, json!("final_answer")));
        tap.observe(&delta(OTHER, TURN, item, "other thread"));
        tap.observe(&delta(THREAD, OTHER_TURN, item, "other turn"));
        tap.observe(&delta(THREAD, TURN, item, "Hello"));
        tap.observe(&delta(THREAD, TURN, item, " there."));
        assert!(tap.take(THREAD, TURN, "relay-1", "wrong").is_empty());
        let events = tap.take(THREAD, TURN, "relay-1", "voice-1");
        assert_eq!(events.iter().map(|e| e.seq).collect::<Vec<_>>(), [1, 2]);
        assert_eq!(
            events.iter().map(|e| e.text.as_str()).collect::<Vec<_>>(),
            ["Hello", " there."]
        );
        assert!(tap.take(THREAD, TURN, "relay-1", "voice-1").is_empty());
    }

    #[test]
    fn reasoning_tool_commentary_unknown_and_other_items_never_stream() {
        let mut tap = AnswerTap::default();
        assert!(tap.arm(THREAD, TURN, "relay-1", "voice-1"));
        for (item, phase) in [
            ("reason", json!("final_answer")),
            ("tool", json!("final_answer")),
            ("commentary", json!("commentary")),
            ("unknown", Value::Null),
        ] {
            let mut started = start(THREAD, TURN, item, phase);
            if item == "reason" {
                started["params"]["item"]["type"] = json!("reasoning");
            }
            if item == "tool" {
                started["params"]["item"]["type"] = json!("commandExecution");
            }
            tap.observe(&started);
            tap.observe(&delta(THREAD, TURN, item, "private"));
        }
        tap.observe(&start(THREAD, TURN, "answer", json!("partial_answer")));
        tap.observe(&delta(THREAD, TURN, "answer", "visible"));
        assert_eq!(
            tap.take(THREAD, TURN, "relay-1", "voice-1")[0].text,
            "visible"
        );
    }

    #[test]
    fn completion_disconnect_and_overflow_fail_closed() {
        let mut tap = AnswerTap::default();
        assert!(tap.arm(THREAD, TURN, "relay-1", "voice-1"));
        tap.observe(&start(THREAD, TURN, "answer", json!("final_answer")));
        tap.observe(&delta(THREAD, TURN, "answer", "first"));
        tap.observe(&json!({"method":"item/completed","params":{
            "threadId":THREAD,"turnId":TURN,"item":{"id":"answer"}}}));
        tap.observe(&delta(THREAD, TURN, "answer", "late"));
        assert_eq!(tap.take(THREAD, TURN, "relay-1", "voice-1").len(), 1);
        tap.disconnect();
        tap.observe(&delta(THREAD, TURN, "answer", "replayed"));
        assert!(tap.take(THREAD, TURN, "relay-1", "voice-1").is_empty());
        assert!(tap.arm(THREAD, TURN, "relay-1", "voice-1"));
        tap.observe(&start(THREAD, TURN, "answer", json!("final_answer")));
        tap.observe(&delta(
            THREAD,
            TURN,
            "answer",
            &"x".repeat(MAX_ANSWER_BYTES + 1),
        ));
        tap.observe(&delta(THREAD, TURN, "answer", "after overflow"));
        assert!(tap.take(THREAD, TURN, "relay-1", "voice-1").is_empty());
    }

    #[test]
    fn large_ascii_and_emoji_deltas_fit_cloud_utf16_limit_without_loss() {
        let mut tap = AnswerTap::default();
        assert!(tap.arm(THREAD, TURN, "relay-1", "voice-1"));
        tap.observe(&start(THREAD, TURN, "answer", json!("final_answer")));
        let text = format!("{}{}", "a".repeat(6000), "🦊".repeat(1500));
        tap.observe(&delta(THREAD, TURN, "answer", &text));
        let events = tap.take(THREAD, TURN, "relay-1", "voice-1");
        assert!(events.len() >= 3);
        assert_eq!(
            events
                .iter()
                .map(|event| event.text.as_str())
                .collect::<String>(),
            text
        );
        assert!(events
            .iter()
            .all(|event| event.text.encode_utf16().count() <= MAX_EVENT_UNITS
                && event.text.len() <= MAX_EVENT_BYTES));
        assert_eq!(
            events.iter().map(|event| event.seq).collect::<Vec<_>>(),
            (1..=events.len() as u64).collect::<Vec<_>>()
        );
    }

    #[test]
    fn missing_item_completions_cannot_grow_capture_without_bound() {
        let mut tap = AnswerTap::default();
        assert!(tap.arm(THREAD, TURN, "relay-1", "voice-1"));
        for index in 0..=MAX_ITEMS_PER_TURN {
            tap.observe(&start(
                THREAD,
                TURN,
                &format!("answer-{index}"),
                json!("final_answer"),
            ));
        }
        assert!(!tap.active.contains_key(&(THREAD.into(), TURN.into())));
        tap.observe(&delta(THREAD, TURN, "answer-0", "never forward"));
        assert!(tap.take(THREAD, TURN, "relay-1", "voice-1").is_empty());
    }

    #[test]
    fn invalid_binding_and_turn_completion_do_not_relabel_text() {
        let mut tap = AnswerTap::default();
        assert!(!tap.arm("wrong", TURN, "relay-1", "voice-1"));
        assert!(!tap.arm(THREAD, TURN, "bad id", "voice-1"));
        assert!(tap.arm(THREAD, TURN, "relay-1", "voice-1"));
        tap.observe(&start(THREAD, TURN, "answer", json!("final_answer")));
        tap.observe(
            &json!({"method":"turn/completed","params":{"threadId":THREAD,"turn":{"id":TURN}}}),
        );
        tap.observe(&delta(THREAD, TURN, "answer", "too late"));
        assert!(tap.take(THREAD, TURN, "relay-1", "voice-1").is_empty());

        assert!(tap.arm(THREAD, TURN, "relay-1", "voice-1"));
        tap.observe(&start(THREAD, TURN, "answer", json!("final_answer")));
        tap.observe(&json!({"method":"thread/status/changed","params":{
            "threadId":THREAD,"status":{"type":"idle"}}}));
        tap.observe(&delta(THREAD, TURN, "answer", "after idle"));
        assert!(tap.take(THREAD, TURN, "relay-1", "voice-1").is_empty());
    }
}
