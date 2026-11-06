//! Durable claims reuse the core's running-turn journal. A lost hook response
//! stays in doubt unless Copilot's own journal records acceptance of its ref.
use super::{sessions, CopilotConfig};
use crate::relay::codex::turn_hook::Claimed;
use crate::relay::inject::InjectOutcome;
use crate::relay::process::ProcessTable;
use serde_json::Value;
use std::io::{Read, Seek, SeekFrom};
use std::time::Duration;

fn recorded(config: &CopilotConfig, sid: &str, message_id: &str) -> bool {
    let Ok(mut file) = std::fs::File::open(config.sessions().join(sid).join("events.jsonl")) else {
        return false;
    };
    let Ok(size) = file.metadata().map(|m| m.len()) else {
        return false;
    };
    let start = size.saturating_sub(8 << 20);
    if file.seek(SeekFrom::Start(start)).is_err() {
        return false;
    }
    let mut bytes = Vec::new();
    if file.take(8 << 20).read_to_end(&mut bytes).is_err() {
        return false;
    }
    let marker = format!(
        "ref {}]",
        crate::relay::delivery::policy::MessageRef::of(message_id)
    );
    bytes
        .split(|b| *b == b'\n')
        .filter_map(|line| serde_json::from_slice::<Value>(line).ok())
        .any(|v| {
            let data = &v["data"];
            // A stop hook's returned decision alone does not prove acceptance:
            // the runtime can refuse more consecutive blocks. Its queued user
            // message is the proof that this follow-up actually entered chat.
            (v["type"] == "user.message"
                && data["content"]
                    .as_str()
                    .is_some_and(|s| s.contains(&marker)))
                || (v["type"] == "hook.end"
                    && data["hookType"] == "postToolUse"
                    && data["success"] == true
                    && data["output"]["additionalContext"]
                        .as_str()
                        .is_some_and(|s| s.contains(&marker)))
        })
}

pub fn send(
    config: &CopilotConfig,
    table: &dyn ProcessTable,
    uid: u32,
    sid: &str,
    binding: &str,
    message_id: &str,
    text: &str,
) -> InjectOutcome {
    if !super::proof::SUPPORTED {
        return InjectOutcome::Refused(
            "Copilot chat delivery is currently available only in VS Code on macOS.".into(),
        );
    }
    if !crate::relay::store::is_uuid(sid) {
        return InjectOutcome::Refused("Invalid Copilot session id.".into());
    }
    let thread = format!("{sid}:{binding}");
    let claim_id = format!("{thread}:{message_id}");
    match config.inbox.claimed(&claim_id) {
        Claimed::Hook { at_ms } => {
            if recorded(config, sid, message_id) {
                return InjectOutcome::Delivered;
            }
            if config.inbox.since(at_ms) < Duration::from_secs(30) {
                return InjectOutcome::Accepted("Copilot is accepting the hook message.".into());
            }
            return InjectOutcome::InDoubt("The Copilot hook claimed this message, but native acceptance is unconfirmed; it will not be submitted again.".into());
        }
        Claimed::Unknown | Claimed::Elsewhere => {
            return InjectOutcome::InDoubt(
                "The Copilot delivery claim is unavailable or belongs to another route.".into(),
            )
        }
        _ => {}
    }
    if sessions::session(config, table, uid, sid).is_none() {
        return InjectOutcome::Waiting("That Copilot chat has no verified live VS Code hook. Start a new Copilot chat after connecting it.".into());
    }
    if config
        .prepare()
        .and_then(|()| config.inbox.offer(&thread, &claim_id, text))
        .is_err()
    {
        return InjectOutcome::Retry("Could not record the Copilot delivery offer.".into());
    }
    InjectOutcome::Waiting(
        "Waiting for this Copilot chat's next tool call or its waiting stop hook.".into(),
    )
}
