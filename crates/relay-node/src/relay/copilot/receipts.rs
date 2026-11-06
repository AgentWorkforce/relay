//! Bounded control acknowledgments and reply completion, not history ingestion.
//! RelayHistory owns the complete transcript parser and stored session evidence.
use super::CopilotConfig;
use serde_json::Value;
use std::io::{Read, Seek, SeekFrom};

fn tail(config: &CopilotConfig, sid: &str, after: u64) -> Option<Vec<u8>> {
    if !crate::relay::store::is_uuid(sid) {
        return None;
    }
    let mut file = std::fs::File::open(config.sessions().join(sid).join("events.jsonl")).ok()?;
    let size = file.metadata().ok()?.len();
    file.seek(SeekFrom::Start(size.saturating_sub(8 << 20).max(after)))
        .ok()?;
    let mut bytes = Vec::new();
    file.take(8 << 20).read_to_end(&mut bytes).ok()?;
    Some(bytes)
}
fn events(bytes: &[u8]) -> impl Iterator<Item = Value> + '_ {
    bytes
        .split(|b| *b == b'\n')
        .filter_map(|line| serde_json::from_slice(line).ok())
}
fn context(event: &Value, needle: &str) -> bool {
    event["type"] == "hook.end"
        && event["data"]["success"] == true
        && matches!(
            event["data"]["hookType"].as_str(),
            Some("sessionStart" | "postToolUse")
        )
        && event["data"]["output"]["additionalContext"]
            .as_str()
            .is_some_and(|s| s.contains(needle))
}
pub fn context_accepted(config: &CopilotConfig, sid: &str, needle: &str) -> bool {
    super::sessions::context_after(config, sid)
        .and_then(|after| tail(config, sid, after))
        .is_some_and(|bytes| events(&bytes).any(|event| context(&event, needle)))
}
fn attributed(text: &str, marker: &str) -> bool {
    // The core can prepend its own one-line identity to post-tool delivery.
    let text = if text.starts_with("This Copilot chat is on Agent Relay as @") {
        text.split_once('\n').map_or("", |(_, message)| message)
    } else {
        text
    };
    crate::relay::delivery::policy::MessageRef::in_text(text)
        .is_some_and(|reference| format!("ref {reference}]") == marker)
}
fn received(event: &Value, marker: &str) -> bool {
    (event["type"] == "user.message"
        && event["data"]["content"]
            .as_str()
            .is_some_and(|s| attributed(s, marker)))
        || (event["data"]["hookType"] == "postToolUse"
            && context(event, marker)
            && event["data"]["output"]["additionalContext"]
                .as_str()
                .is_some_and(|s| attributed(s, marker)))
}
pub(super) fn recorded(config: &CopilotConfig, sid: &str, message_id: &str) -> bool {
    let marker = format!(
        "ref {}]",
        crate::relay::delivery::policy::MessageRef::of(message_id)
    );
    tail(config, sid, 0).is_some_and(|bytes| events(&bytes).any(|event| received(&event, &marker)))
}
/// Return only a completed final answer after this delivery's native receipt.
/// A different human turn, cancellation or a tool-bearing assistant message
/// cannot answer this message accidentally.
pub fn final_answer(config: &CopilotConfig, sid: &str, message_ref: &str) -> Option<String> {
    let bytes = tail(config, sid, 0)?;
    let marker = format!("ref {message_ref}]");
    let mut active = false;
    let mut answer: Option<(Value, String)> = None;
    for event in events(&bytes) {
        if received(&event, &marker) {
            active = true;
            answer = None;
            continue;
        }
        if !active {
            continue;
        }
        let data = &event["data"];
        match event["type"].as_str()? {
            "user.message" | "abort" | "session.error" => return None,
            "assistant.message"
                if data["phase"] == "final_answer"
                    && data["toolRequests"].as_array().is_none_or(|a| a.is_empty()) =>
            {
                let text = data["content"].as_str()?.trim();
                if !text.is_empty() {
                    answer = Some((data["turnId"].clone(), text.chars().take(10_000).collect()));
                }
            }
            "assistant.turn_end" => {
                if let Some((turn, text)) = answer.take() {
                    if !turn.is_null() && turn == data["turnId"] {
                        return Some(text);
                    }
                }
            }
            _ => {}
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    const SID: &str = "1069773c-0824-4fad-b7f9-d3dc3c4ed148";
    #[test]
    fn replies_require_the_delivery_receipt_and_matching_completed_final_turn() {
        let home = tempfile::tempdir().unwrap();
        let config = CopilotConfig::from_env(&|_| None, home.path());
        let path = config.sessions().join(SID).join("events.jsonl");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut rows = vec![
            json!({"type":"user.message","data":{"content":"[via Agent Relay ref abcdef123456]\nRequest"}}),
            json!({"type":"assistant.message","data":{"content":"Working","turnId":"1","toolRequests":[{"name":"read"}]}}),
            json!({"type":"assistant.turn_end","data":{"turnId":"1"}}),
            json!({"type":"assistant.message","data":{"content":"Final response","turnId":"2","phase":"final_answer","toolRequests":[]}}),
        ];
        let write = |rows: &[Value]| {
            std::fs::write(
                &path,
                rows.iter().map(|r| format!("{r}\n")).collect::<String>(),
            )
            .unwrap()
        };
        write(&rows);
        assert!(final_answer(&config, SID, "abcdef123456").is_none());
        rows.push(json!({"type":"assistant.turn_end","data":{"turnId":"wrong"}}));
        write(&rows);
        assert!(final_answer(&config, SID, "abcdef123456").is_none());
        rows.pop();
        rows.push(json!({"type":"assistant.turn_end","data":{"turnId":"2"}}));
        write(&rows);
        assert_eq!(
            final_answer(&config, SID, "abcdef123456").as_deref(),
            Some("Final response")
        );
        assert!(final_answer(&config, SID, "different").is_none());
        let genuine = rows[0].clone();
        rows[0]["data"]["content"] = json!("Explain the quoted ref abcdef123456] from before");
        write(&rows);
        assert!(final_answer(&config, SID, "abcdef123456").is_none());
        rows[0] = genuine;
        assert!(attributed("This Copilot chat is on Agent Relay as @fixture.\n[via Agent Relay ref abcdef123456]\nRequest", "ref abcdef123456]"));
        rows.insert(
            3,
            json!({"type":"user.message","data":{"content":"Unrelated question"}}),
        );
        write(&rows);
        assert!(final_answer(&config, SID, "abcdef123456").is_none());
    }
    #[test]
    fn identity_receipts_before_the_current_start_do_not_suppress_recovery() {
        let home = tempfile::tempdir().unwrap();
        let config = CopilotConfig::from_env(&|_| None, home.path());
        let path = config.sessions().join(SID).join("events.jsonl");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let record = json!({"type":"hook.end","data":{"hookType":"sessionStart","success":true,"output":{"additionalContext":"Current identity"}}});
        let line = format!("{record}\n");
        std::fs::write(&path, &line).unwrap();
        config.prepare().unwrap();
        std::fs::write(
            config.state().join(format!("{SID}.json")),
            serde_json::to_vec(
                &json!({"pid":1,"start":1,"title":"Chat","cwd":null,"context_after":line.len()}),
            )
            .unwrap(),
        )
        .unwrap();
        assert!(!context_accepted(&config, SID, "Current identity"));
        std::fs::write(&path, format!("{line}{line}")).unwrap();
        assert!(context_accepted(&config, SID, "Current identity"));
    }
}
