//! Transcript-based delivery receipts and final-answer reads for Antigravity.
use super::caller::{read_tail, transcript_path};
use super::AntigravityConfig;
use crate::relay::delivery::policy::MessageRef;
use serde_json::Value;
use std::io::{BufRead, BufReader};
use std::path::Path;

const RECEIPT_TAIL_BYTES: u64 = 1024 * 1024;
const MAX_ANSWER_CHARS: usize = 10_000;

fn attributed(text: &str, expected_ref: &str) -> bool {
    if MessageRef::in_text(text).as_deref() == Some(expected_ref) {
        return true;
    }
    // Antigravity may wrap injected system messages in <SYSTEM_MESSAGE>...</SYSTEM_MESSAGE>.
    if let Some((_, rest)) = text.split_once("<SYSTEM_MESSAGE>") {
        let inner = rest.trim_start_matches(['\r', '\n', ' ']);
        let inner = inner.split("</SYSTEM_MESSAGE>").next().unwrap_or(inner);
        if MessageRef::in_text(inner).as_deref() == Some(expected_ref) {
            return true;
        }
    }
    false
}

fn is_receipt_row(row: &Value, expected_ref: &str) -> bool {
    if row["source"].as_str() == Some("MODEL") {
        return false;
    }
    let Some(kind) = row["type"].as_str() else {
        return false;
    };
    if !matches!(kind, "SYSTEM_MESSAGE" | "USER_INPUT" | "EPHEMERAL_MESSAGE") {
        return false;
    }
    row["content"]
        .as_str()
        .is_some_and(|content| attributed(content, expected_ref))
}

fn has_tool_calls(row: &Value) -> bool {
    row["tool_calls"]
        .as_array()
        .is_some_and(|calls| !calls.is_empty())
}

fn parse_lines_for_receipt(text: &str, expected_ref: &str) -> bool {
    text.lines().any(|line| {
        serde_json::from_str::<Value>(line)
            .ok()
            .is_some_and(|row| is_receipt_row(&row, expected_ref))
    })
}

fn stream_for_receipt(path: &Path, expected_ref: &str) -> bool {
    let Ok(file) = std::fs::File::open(path) else {
        return false;
    };
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    while let Ok(read) = reader.read_line(&mut line) {
        if read == 0 {
            break;
        }
        if let Ok(row) = serde_json::from_str::<Value>(&line) {
            if is_receipt_row(&row, expected_ref) {
                return true;
            }
        }
        line.clear();
    }
    false
}

/// Whether the conversation's native transcript recorded a non-model step
/// carrying the exact `MessageRef` for `message_id` (covers direct messages,
/// local notices, and coalesced channel batches).
pub(super) fn recorded(config: &AntigravityConfig, sid: &str, message_id: &str) -> bool {
    if message_id.is_empty() {
        return false;
    }
    let Some(path) = transcript_path(config, sid) else {
        return false;
    };
    let expected_ref = MessageRef::of(message_id);
    if read_tail(&path, RECEIPT_TAIL_BYTES)
        .is_some_and(|tail| parse_lines_for_receipt(&tail, &expected_ref))
    {
        return true;
    }
    let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    if size > RECEIPT_TAIL_BYTES {
        return stream_for_receipt(&path, &expected_ref);
    }
    false
}

#[derive(Default)]
struct AnswerScan {
    seen: bool,
    stopped: bool,
    answer: Option<String>,
}

impl AnswerScan {
    fn feed(&mut self, row: &Value, message_ref: &str) {
        if self.stopped {
            return;
        }
        if is_receipt_row(row, message_ref) {
            self.seen = true;
            self.answer = None;
            return;
        }
        if !self.seen {
            return;
        }
        let kind = row["type"].as_str().unwrap_or("");
        let status = row["status"].as_str().unwrap_or("");
        if kind == "USER_INPUT" {
            self.stopped = true;
            return;
        }
        if matches!(kind, "ERROR_MESSAGE") || matches!(status, "ERROR" | "CANCELED") {
            self.answer = None;
            self.stopped = true;
            return;
        }
        if status != "DONE" {
            // An unfinished step means this turn has not settled yet.
            self.answer = None;
            return;
        }
        if row["source"].as_str() == Some("MODEL") && kind == "PLANNER_RESPONSE" {
            if has_tool_calls(row) {
                // Tool-bearing intermediate response: wait for the terminal turn.
                self.answer = None;
                return;
            }
            if let Some(text) = row["content"]
                .as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                self.answer = Some(text.chars().take(MAX_ANSWER_CHARS).collect());
            }
        }
    }
}

fn scan_text_for_answer(text: &str, message_ref: &str) -> AnswerScan {
    let mut scan = AnswerScan::default();
    for line in text.lines() {
        if let Ok(row) = serde_json::from_str::<Value>(line) {
            scan.feed(&row, message_ref);
            if scan.stopped {
                break;
            }
        }
    }
    scan
}

fn stream_for_answer(path: &Path, message_ref: &str) -> Option<String> {
    let file = std::fs::File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    let mut scan = AnswerScan::default();
    while let Ok(read) = reader.read_line(&mut line) {
        if read == 0 {
            break;
        }
        if let Ok(row) = serde_json::from_str::<Value>(&line) {
            scan.feed(&row, message_ref);
            if scan.stopped {
                break;
            }
        }
        line.clear();
    }
    scan.answer
}

/// The assistant's final completed non-tool `PLANNER_RESPONSE` text within the
/// turn triggered by `message_ref`, stopping at any subsequent `USER_INPUT` or
/// error/cancellation step.
pub fn final_answer(config: &AntigravityConfig, sid: &str, message_ref: &str) -> Option<String> {
    if message_ref.is_empty() {
        return None;
    }
    let path = transcript_path(config, sid)?;
    let tail = read_tail(&path, RECEIPT_TAIL_BYTES)?;
    let scan = scan_text_for_answer(&tail, message_ref);
    if scan.seen {
        return scan.answer;
    }
    let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    if size > RECEIPT_TAIL_BYTES {
        return stream_for_answer(&path, message_ref);
    }
    None
}
