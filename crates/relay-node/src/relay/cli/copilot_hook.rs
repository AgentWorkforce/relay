use super::{session_hook_socket, socket_response};
use anyhow::Result;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::time::Duration;

/// A native Copilot hook talks only to this user's session socket. A stop
/// waits without model calls, and returns when the person cancels the hook,
/// setup is removed, the runtime exits, or the configured timeout approaches.
pub fn copilot_hook(development: bool, event: &str) -> Result<()> {
    let mut bytes = Vec::new();
    std::io::stdin().take(4 << 20).read_to_end(&mut bytes)?;
    let Some(value) = input(&bytes, event) else {
        std::io::stdout().write_all(b"{}\n")?;
        return Ok(());
    };
    let input = serde_json::to_vec(&value)?;
    let Some(socket) = session_hook_socket(None, development) else {
        return Ok(());
    };
    let wait = waits(&value);
    let until = std::time::Instant::now() + Duration::from_secs(if wait { 3540 } else { 0 });
    loop {
        let response = socket_response(
            &socket,
            "POST",
            "/copilot/hook",
            &input,
            Duration::from_secs(if event == "before" { 18 } else { 8 }),
        );
        let Ok((status, bytes)) = response else {
            break;
        };
        if status != 200 {
            break;
        }
        let Some(value) = answer(&bytes) else { break };
        if value.as_object().is_some_and(|o| !o.is_empty()) {
            let mut stdout = std::io::stdout();
            stdout.write_all(serde_json::to_string(&value)?.as_bytes())?;
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

// Tool results can exceed the socket's body limit and are not caller proof.
// Forward only the identity and lifecycle fields the adapter actually needs.
fn input(bytes: &[u8], event: &str) -> Option<Value> {
    let value: Value = serde_json::from_slice(bytes).ok()?;
    let object = value.as_object()?;
    if event == "before" && !value["toolName"].as_str()?.starts_with("agent-relay-") {
        return None;
    }
    let mut fields = serde_json::Map::new();
    for key in ["sessionId", "cwd", "initialPrompt", "stopReason"] {
        if let Some(text) = object.get(key).and_then(Value::as_str) {
            let limit = if key == "initialPrompt" { 96 } else { 4096 };
            fields.insert(
                key.into(),
                json!(text.chars().take(limit).collect::<String>()),
            );
        }
    }
    if event == "before" {
        if let Some(name) = object.get("toolName").and_then(Value::as_str) {
            fields.insert(
                "toolName".into(),
                json!(name.chars().take(256).collect::<String>()),
            );
        }
        if let Some(args) = object.get("toolArgs").filter(|v| v.is_object()) {
            if serde_json::to_vec(args).ok()?.len() > 32 * 1024 {
                return None;
            }
            fields.insert("toolArgs".into(), args.clone());
        }
    }
    fields.insert("relayEvent".into(), json!(event));
    Some(Value::Object(fields))
}
fn answer(bytes: &[u8]) -> Option<Value> {
    let value: Value = serde_json::from_slice(bytes).ok()?;
    (value["ok"] == true && value["data"].is_object()).then(|| value["data"].clone())
}
fn waits(value: &Value) -> bool {
    value["relayEvent"] == "stop" && value["stopReason"] == "end_turn"
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hook_forwards_identity_without_large_tool_results_or_client_binding() {
        let payload = json!({"sessionId":"native-id","cwd":"/fixture","initialPrompt":"x".repeat(1000),"toolResult":"x".repeat(200_000),"relayBinding":"forged"});
        let value = input(&serde_json::to_vec(&payload).unwrap(), "tool").unwrap();
        assert_eq!(value["sessionId"], "native-id");
        assert_eq!(value["initialPrompt"].as_str().unwrap().len(), 96);
        assert!(value.get("toolResult").is_none());
        assert!(value.get("relayBinding").is_none());
        assert!(serde_json::to_vec(&value).unwrap().len() < 1024);
    }
    #[test]
    fn socket_envelope_never_becomes_hook_output() {
        assert_eq!(answer(br#"{"ok":true,"data":{}}"#), Some(json!({})));
        assert_eq!(
            answer(br#"{"ok":true,"data":{"decision":"block","reason":"message"}}"#),
            Some(json!({"decision":"block","reason":"message"}))
        );
        assert!(answer(br#"{"ok":false,"error":{"message":"failed"}}"#).is_none());
    }
    #[test]
    fn malformed_input_is_quiet_and_only_end_turn_waits() {
        for bytes in [b"null".as_slice(), b"[]", b"invalid"] {
            assert!(input(bytes, "stop").is_none());
        }
        assert!(!waits(
            &json!({"relayEvent":"stop","stopReason":"cancelled"})
        ));
        assert!(!waits(
            &json!({"relayEvent":"tool","stopReason":"end_turn"})
        ));
        assert!(waits(&json!({"relayEvent":"stop","stopReason":"end_turn"})));
    }
}
