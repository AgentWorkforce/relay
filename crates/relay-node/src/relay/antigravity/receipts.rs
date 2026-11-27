//! Transcript-based delivery receipts and final-answer reads for Antigravity.
use super::caller::{read_tail, transcript_path};
use super::AntigravityConfig;
use serde_json::Value;

const RECEIPT_TAIL_BYTES: u64 = 1024 * 1024;

/// Whether the conversation's native transcript recorded a step carrying
/// `message_id` (the Agent Relay reference tag).
pub(super) fn recorded(config: &AntigravityConfig, sid: &str, message_id: &str) -> bool {
    if message_id.is_empty() {
        return false;
    }
    let Some(path) = transcript_path(config, sid) else {
        return false;
    };
    read_tail(&path, RECEIPT_TAIL_BYTES).is_some_and(|tail| tail.contains(message_id))
}

/// The assistant's final completed `PLANNER_RESPONSE` text after `message_ref`
/// appeared in the conversation's transcript.
pub fn final_answer(config: &AntigravityConfig, sid: &str, message_ref: &str) -> Option<String> {
    if message_ref.is_empty() {
        return None;
    }
    let path = transcript_path(config, sid)?;
    let tail = read_tail(&path, RECEIPT_TAIL_BYTES)?;
    let mut seen = false;
    let mut last_answer = None;
    for line in tail.lines() {
        let Ok(row) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if !seen {
            if line.contains(message_ref) {
                seen = true;
            }
            continue;
        }
        if row["source"].as_str() == Some("MODEL")
            && row["type"].as_str() == Some("PLANNER_RESPONSE")
            && row["status"].as_str() == Some("DONE")
        {
            if let Some(text) = row["content"]
                .as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                last_answer = Some(text.to_owned());
            }
        }
    }
    last_answer
}
