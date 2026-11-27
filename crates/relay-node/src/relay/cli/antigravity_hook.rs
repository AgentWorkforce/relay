use super::{session_hook_socket, socket_response};
use anyhow::Result;
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::{BufReader, Read, Write};
use std::time::Duration;

const MAX_INPUT: u64 = 16 << 20;

/// Antigravity lifecycle hook client (`antigravity-hook --event start|pre|post|stop`).
/// Talks only to this user's session socket. On `stop` after normal turn
/// completion (`NO_TOOL_CALL`), waits for incoming relay messages until a
/// message arrives, the socket rejects/closes, or the timeout approaches.
pub fn antigravity_hook(development: bool, event: &str) -> Result<()> {
    let Some(value) = input(std::io::stdin().lock(), event) else {
        std::io::stdout().write_all(b"{}\n")?;
        return Ok(());
    };
    let body = serde_json::to_vec(&value)?;
    let Some(socket) = session_hook_socket(
        None,
        &if development {
            crate::relay::outbound::Build::Development
        } else {
            crate::relay::outbound::Build::Production
        },
    ) else {
        std::io::stdout().write_all(b"{}\n")?;
        return Ok(());
    };
    let wait = event == "stop" && value["terminationReason"].as_str() == Some("NO_TOOL_CALL");
    let until = std::time::Instant::now() + Duration::from_secs(if wait { 3540 } else { 0 });
    loop {
        let timeout = Duration::from_secs(match event {
            "start" => 18,
            "stop" => 30,
            _ => 8,
        });
        let Ok((status, bytes)) =
            socket_response(&socket, "POST", "/antigravity/hook", &body, timeout)
        else {
            break;
        };
        if status != 200 {
            break;
        }
        let Some(answer) = parse_answer(&bytes) else {
            break;
        };
        if answer.as_object().is_some_and(|o| !o.is_empty()) {
            let mut stdout = std::io::stdout();
            stdout.write_all(serde_json::to_string(&answer)?.as_bytes())?;
            stdout.write_all(b"\n")?;
            stdout.flush()?;
            return Ok(());
        }
        if !wait || std::time::Instant::now() >= until {
            break;
        }
        std::thread::sleep(Duration::from_millis(1000));
    }
    std::io::stdout().write_all(b"{}\n")?;
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HookInput {
    conversation_id: String,
    cwd: Option<String>,
    workspace_paths: Option<Vec<String>>,
    last_user_input: Option<String>,
    termination_reason: Option<String>,
    continuation_active: Option<bool>,
}

fn input<R: Read>(reader: R, event: &str) -> Option<Value> {
    let hook: HookInput = serde_json::from_reader(BufReader::new(reader.take(MAX_INPUT))).ok()?;
    let mut fields = serde_json::Map::new();
    fields.insert("relayEvent".into(), json!(event));
    fields.insert(
        "conversationId".into(),
        json!(hook.conversation_id.chars().take(128).collect::<String>()),
    );
    if let Some(cwd) = hook.cwd {
        fields.insert(
            "cwd".into(),
            json!(cwd.chars().take(4096).collect::<String>()),
        );
    }
    if let Some(paths) = hook.workspace_paths {
        let bounded: Vec<String> = paths
            .into_iter()
            .take(8)
            .map(|p| p.chars().take(4096).collect())
            .collect();
        fields.insert("workspacePaths".into(), json!(bounded));
    }
    if let Some(text) = hook.last_user_input {
        fields.insert(
            "lastUserInput".into(),
            json!(text.chars().take(128).collect::<String>()),
        );
    }
    if let Some(reason) = hook.termination_reason {
        fields.insert(
            "terminationReason".into(),
            json!(reason.chars().take(128).collect::<String>()),
        );
    }
    if let Some(active) = hook.continuation_active {
        fields.insert("continuationActive".into(), json!(active));
    }
    Some(Value::Object(fields))
}

fn parse_answer(bytes: &[u8]) -> Option<Value> {
    let envelope: Value = serde_json::from_slice(bytes).ok()?;
    if envelope.get("ok").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    envelope.get("data").cloned()
}
