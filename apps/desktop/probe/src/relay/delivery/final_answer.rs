//! A session's final answer to an injected message, read from its
//! transcript, for the automatic answer an agent may send back.
//!
//! Finding a session's transcript belongs to its injector (`Injector::
//! final_answer`); what counts as a final answer in a Claude Code transcript
//! is defined here.

use crate::relay::delivery::policy::MessageRef;
use serde_json::Value;
use std::collections::HashSet;

const CAP: usize = 4_000;
const TRUNCATED: &str = "\n\n[truncated]";

/// `text` trimmed and held to 4,000 characters, or `None` when empty.
pub fn capped(text: &str) -> Option<String> {
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    if text.chars().count() <= CAP {
        return Some(text.into());
    }
    let keep = CAP - TRUNCATED.chars().count();
    Some(format!(
        "{}{TRUNCATED}",
        text.chars().take(keep).collect::<String>()
    ))
}

/// Whether a user row is the turn `reference` names: by the one attribution
/// in its text, or, for a native turn, which carries none, by its id
/// (`MessageRef::native_uuid`). `None` when it is ambiguous.
fn names_turn(row: &Value, refs: &[String], reference: &str) -> Option<bool> {
    let native = row["uuid"].as_str() == Some(&MessageRef::native_uuid(reference));
    if !native && !refs.iter().any(|r| r == reference) {
        return Some(false);
    }
    (refs.len() == usize::from(!native)).then_some(true)
}

/// The answer to the turn whose user prompt carried `reference`, from a
/// Claude Code JSONL transcript. Claude's format is not a stable API, so
/// only an unambiguous user attribution followed by a final assistant text
/// is accepted: tool results continue a turn, another user prompt ends it,
/// and anything unknown fails closed. Sub-agent turns (`isSidechain`) belong
/// to the main turn's work and are skipped. `idle` says the session has
/// finished its turn, so an answer without `end_turn` is final.
pub fn claude(transcript: &[u8], reference: &str, idle: bool) -> Option<String> {
    let mut turn = ClaudeTurn::default();
    for line in transcript.split(|byte| *byte == b'\n') {
        if line.is_empty() {
            continue;
        }
        let Ok(row) = serde_json::from_slice::<Value>(line) else {
            if turn.matched {
                return None;
            }
            continue;
        };
        let Some(kind) = row["type"]
            .as_str()
            .filter(|k| *k == "user" || *k == "assistant")
        else {
            continue;
        };
        if row["isSidechain"] == true {
            continue;
        }
        let Some((message, blocks)) = message_blocks(&row) else {
            if turn.matched {
                return None;
            }
            continue;
        };
        if kind == "user" {
            if !turn.user(&row, &blocks, reference)? {
                return turn.result(false);
            }
        } else if turn.matched {
            turn.assistant(message, &blocks)?;
        }
    }
    turn.result(idle)
}

fn message_blocks(row: &Value) -> Option<(&Value, Vec<Value>)> {
    let message = row.get("message").filter(|m| m.is_object())?;
    let blocks = match &message["content"] {
        Value::String(text) => vec![serde_json::json!({"type": "text", "text": text})],
        Value::Array(blocks) if blocks.iter().all(Value::is_object) => blocks.clone(),
        _ => return None,
    };
    Some((message, blocks))
}

#[derive(Default)]
struct ClaudeTurn {
    matched: bool,
    answer: Option<String>,
    final_turn: bool,
    pending_tools: HashSet<String>,
}

impl ClaudeTurn {
    /// False marks the next user's prompt. Invalid or ambiguous evidence
    /// returns None; tool results continue the matched turn.
    fn user(&mut self, row: &Value, blocks: &[Value], reference: &str) -> Option<bool> {
        let texts: Vec<&str> = blocks
            .iter()
            .filter(|b| b["type"] == "text")
            .filter_map(|b| b["text"].as_str())
            .collect();
        if !texts.is_empty() {
            let refs: Vec<String> = texts
                .iter()
                .flat_map(|text| text.split('\n'))
                .filter_map(MessageRef::in_text)
                .collect();
            if names_turn(row, &refs, reference)? {
                if self.matched {
                    return None;
                }
                self.matched = true;
                self.answer = None;
                self.final_turn = false;
            } else if self.matched {
                return Some(false);
            }
        }
        if self.matched {
            self.tool_results(blocks)?;
        }
        Some(true)
    }

    fn tool_results(&mut self, blocks: &[Value]) -> Option<()> {
        for block in blocks {
            match block["type"].as_str() {
                Some("text") => {}
                Some("tool_result") => {
                    let id = block["tool_use_id"].as_str()?;
                    if !self.pending_tools.remove(id) {
                        return None;
                    }
                    // Text written before a tool call is not the answer;
                    // only an assistant message after it is.
                    self.answer = None;
                }
                _ => return None,
            }
        }
        Some(())
    }

    fn assistant(&mut self, message: &Value, blocks: &[Value]) -> Option<()> {
        let mut texts: Vec<String> = Vec::new();
        for block in blocks {
            match block["type"].as_str() {
                Some("text") => texts.push(block["text"].as_str()?.to_string()),
                Some("thinking") | Some("redacted_thinking") => {}
                Some("tool_use") => {
                    self.pending_tools.insert(block["id"].as_str()?.to_string());
                }
                _ => return None,
            }
        }
        self.answer = Some(texts.join("\n"));
        self.final_turn = message["stop_reason"] == "end_turn" && self.pending_tools.is_empty();
        Some(())
    }

    fn result(&self, idle: bool) -> Option<String> {
        if !self.matched || !self.pending_tools.is_empty() || !(self.final_turn || idle) {
            return None;
        }
        self.answer.as_deref().and_then(capped)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const REF: &str = "123456abcdef";
    const CLAUDE: &str = include_str!("../../../tests/fixtures/injectable_replies/claude.jsonl");

    fn rows() -> Vec<&'static str> {
        CLAUDE.lines().collect()
    }

    fn join(rows: &[&str]) -> Vec<u8> {
        rows.iter()
            .flat_map(|r| format!("{r}\n").into_bytes())
            .collect()
    }

    #[test]
    fn a_native_turn_is_found_by_its_id_not_its_text() {
        let uuid = MessageRef::native_uuid(REF);
        let user = |uuid: &str, text: &str| {
            serde_json::json!({"type": "user", "uuid": uuid,
                "message": {"role": "user", "content": text}})
            .to_string()
        };
        let answer = r#"{"type":"assistant","message":{"role":"assistant","stop_reason":"end_turn","content":[{"type":"text","text":"CI is green"}]}}"#;
        let transcript = join(&[&user(&uuid, "Check CI"), answer]);
        assert_eq!(
            claude(&transcript, REF, false).as_deref(),
            Some("CI is green")
        );
        // Another turn's id is not it.
        let other = join(&[
            &user(&MessageRef::native_uuid("000000000000"), "Check CI"),
            answer,
        ]);
        assert_eq!(claude(&other, REF, true), None);
        // An owner's text quoting an attribution is ambiguous: no answer.
        let quoted = format!("[via Agent Relay — from @x · ref {REF}]\nhi");
        let ambiguous = join(&[&user(&uuid, &quoted), answer]);
        assert_eq!(claude(&ambiguous, REF, true), None);
    }

    // InjectableRepliesTests.testClaudeToolsAndFinalAnswer.
    #[test]
    fn claude_tools_and_final_answer() {
        assert_eq!(
            claude(CLAUDE.as_bytes(), REF, false).as_deref(),
            Some("Claude answer")
        );
        assert_eq!(claude(CLAUDE.as_bytes(), "000000000000", true), None);
        let rows = rows();
        for count in 1..=3 {
            assert_eq!(claude(&join(&rows[..count]), REF, false), None, "{count}");
        }
        assert_eq!(claude(&join(&[rows[0], rows[1], rows[3]]), REF, true), None);
        let broken = [CLAUDE.as_bytes(), b"{broken"].concat();
        assert_eq!(claude(&broken, REF, true), None);
    }

    // testClaudeSidechainTurnsAreSkipped.
    #[test]
    fn claude_sidechain_turns_are_skipped() {
        let rows = rows();
        let sidechain = [
            r#"{"type":"user","isSidechain":true,"message":{"role":"user","content":"Sub-agent task: look around"}}"#,
            r#"{"type":"assistant","isSidechain":true,"message":{"content":[{"type":"tool_use","id":"side-1","name":"Grep","input":{}}],"stop_reason":"tool_use"}}"#,
            r#"{"type":"user","isSidechain":true,"message":{"content":[{"type":"tool_result","tool_use_id":"side-1","content":"hits"}]}}"#,
            r#"{"type":"assistant","isSidechain":true,"message":{"content":[{"type":"text","text":"sub-agent summary"}],"stop_reason":"end_turn"}}"#,
        ];
        let mut all = vec![rows[0], rows[1]];
        all.extend(sidechain);
        all.extend([rows[2], rows[3]]);
        assert_eq!(
            claude(&join(&all), REF, false).as_deref(),
            Some("Claude answer")
        );
    }

    // testClaudeIdleAndUserBoundary.
    #[test]
    fn claude_idle_and_user_boundary() {
        let no_stop = CLAUDE.replace("end_turn", "unknown");
        assert_eq!(claude(no_stop.as_bytes(), REF, false), None);
        assert_eq!(
            claude(no_stop.as_bytes(), REF, true).as_deref(),
            Some("Claude answer")
        );
        let next = "{\"type\":\"user\",\"message\":{\"content\":\"another question\"}}\n{\"type\":\"assistant\",\"message\":{\"content\":\"wrong answer\",\"stop_reason\":\"end_turn\"}}\n";
        assert_eq!(
            claude(format!("{no_stop}{next}").as_bytes(), REF, true),
            None
        );
        assert_eq!(
            claude(format!("{CLAUDE}{next}").as_bytes(), REF, true).as_deref(),
            Some("Claude answer")
        );
    }

    #[test]
    fn text_before_a_tool_call_is_not_the_answer() {
        let rows = [
            r#"{"type":"user","message":{"content":"[via Agent Relay — ref 123456abcdef]\nQuestion"}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Let me look."},{"type":"tool_use","id":"t1","name":"Read","input":{}}],"stop_reason":"tool_use"}}"#,
            r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"x"}]}}"#,
        ];
        assert_eq!(claude(&join(&rows), REF, true), None);
    }

    #[test]
    fn malformed_messages_only_invalidate_a_matched_turn() {
        for malformed in [
            "{broken",
            r#"{"type":"assistant"}"#,
            r#"{"type":"user","message":[]}"#,
            r#"{"type":"assistant","message":{"content":null}}"#,
            r#"{"type":"assistant","message":{"content":["not a block"]}}"#,
        ] {
            let before = format!("{malformed}\n{CLAUDE}");
            assert_eq!(
                claude(before.as_bytes(), REF, false).as_deref(),
                Some("Claude answer")
            );
            let after = format!("{CLAUDE}{malformed}\n");
            assert_eq!(claude(after.as_bytes(), REF, true), None, "{malformed}");
        }
    }

    #[test]
    fn ambiguous_references_and_unknown_blocks_fail_closed() {
        let prompt = rows()[0];
        assert_eq!(claude(&join(&[prompt, prompt]), REF, true), None);
        let ambiguous = serde_json::json!({"type":"user","message":{"content":
            "[via Agent Relay — ref 123456abcdef]\n[via Agent Relay — ref 000000000000]"}});
        let transcript = format!("{ambiguous}\n{CLAUDE}");
        assert_eq!(claude(transcript.as_bytes(), REF, true), None);
        for invalid in [
            r#"{"type":"user","message":{"content":[{"type":"image"}]}}"#,
            r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"unknown"}]}}"#,
            r#"{"type":"user","message":{"content":[{"type":"tool_result"}]}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"unknown"}]}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":42}]}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use"}]}}"#,
        ] {
            let transcript = format!("{CLAUDE}{invalid}\n");
            assert_eq!(claude(transcript.as_bytes(), REF, true), None, "{invalid}");
        }
    }

    // testCapAndLegacyStore (the cap half).
    #[test]
    fn answers_are_capped() {
        assert_eq!(capped(" \n"), None);
        let long = capped(&"🙂".repeat(5000)).unwrap();
        assert_eq!(long.chars().count(), 4000);
        assert!(long.ends_with("[truncated]"));
    }
}
