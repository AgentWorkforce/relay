use super::{session_hook_socket, socket_response};
use anyhow::Result;
use serde::{
    de::{DeserializeOwned, IgnoredAny},
    Deserialize,
};
use serde_json::{json, Value};
use std::io::{BufReader, Read, Write};
use std::time::Duration;

/// A native Copilot hook talks only to this user's session socket. A stop
/// waits without model calls, and returns when the person cancels the hook,
/// setup is removed, the runtime exits, or the configured timeout approaches.
pub fn copilot_hook(development: bool, event: &str) -> Result<()> {
    let Some(value) = input(std::io::stdin().lock(), event) else {
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
            Duration::from_secs(if matches!(event, "before" | "start") {
                18
            } else {
                8
            }),
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

// Stream native input, skipping unneeded values rather than retaining tool
// results or truncating valid JSON at the old 4 MiB boundary. The total input
// limit is separate from the much smaller retained/socket fields.
const MAX_INPUT: u64 = 64 << 20;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Hook<A> {
    session_id: String,
    cwd: Option<String>,
    initial_prompt: Option<String>,
    stop_reason: Option<String>,
    tool_name: Option<String>,
    tool_args: Option<A>,
}
impl<A> Hook<A> {
    fn fields(&self) -> serde_json::Map<String, Value> {
        let mut fields = serde_json::Map::new();
        for (key, text, limit) in [
            ("sessionId", Some(self.session_id.as_str()), 4096),
            ("cwd", self.cwd.as_deref(), 4096),
            ("initialPrompt", self.initial_prompt.as_deref(), 96),
            ("stopReason", self.stop_reason.as_deref(), 4096),
        ] {
            if let Some(text) = text {
                fields.insert(
                    key.into(),
                    json!(text.chars().take(limit).collect::<String>()),
                );
            }
        }
        fields
    }
}
fn read_hook<A: DeserializeOwned>(reader: impl Read) -> Option<Hook<A>> {
    let mut limited = reader.take(MAX_INPUT + 1);
    let mut parser = serde_json::Deserializer::from_reader(BufReader::new(&mut limited));
    let hook = Hook::deserialize(&mut parser).ok()?;
    parser.end().ok()?;
    drop(parser);
    (limited.limit() > 0).then_some(hook)
}
fn input(reader: impl Read, event: &str) -> Option<Value> {
    let mut fields = if event == "before" {
        let hook = read_hook::<Value>(reader)?;
        let raw_name = hook.tool_name.as_deref()?;
        // New Copilot installations use an unambiguous managed server ID.
        // Forward legacy names too; Desktop decides which calls it can sign.
        let name = raw_name
            .strip_prefix("agentrelay-")
            .or_else(|| raw_name.strip_prefix("agent-relay-"))?;
        if name.is_empty() {
            return None;
        }
        let args = hook.tool_args.as_ref().filter(|v| v.is_object())?;
        if serde_json::to_vec(args).ok()?.len() > 32 * 1024 {
            return None;
        }
        let mut fields = hook.fields();
        fields.insert(
            "toolName".into(),
            json!(hook
                .tool_name
                .as_deref()?
                .chars()
                .take(256)
                .collect::<String>()),
        );
        fields.insert("toolArgs".into(), args.clone());
        fields
    } else {
        read_hook::<IgnoredAny>(reader)?.fields()
    };
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
    fn before_forwards_new_and_legacy_names_with_exact_arguments() {
        let args = json!({"text":"fixture reply","nested":{"number":1.0},"_meta":{"fixture":true}});
        for name in [
            "agentrelay-send_relay_message",
            "agent-relay-send_relay_message",
        ] {
            let payload =
                json!({"sessionId":"native-id","cwd":"/fixture","toolName":name,"toolArgs":args});
            let value = input(serde_json::to_vec(&payload).unwrap().as_slice(), "before").unwrap();
            assert_eq!(value["toolName"], name);
            assert_eq!(value["toolArgs"], args);
            assert_eq!(value["sessionId"], "native-id");
            assert_eq!(value["relayEvent"], "before");
        }
    }
    #[test]
    fn before_rejects_empty_and_unrelated_names_without_creating_a_call() {
        for name in [
            "agentrelay-",
            "agent-relay-",
            "other-send_relay_message",
            "agentrelay_other-send_relay_message",
        ] {
            let payload = json!({"sessionId":"native-id","toolName":name,"toolArgs":{}});
            assert!(input(serde_json::to_vec(&payload).unwrap().as_slice(), "before").is_none());
        }
    }
    #[test]
    fn before_keeps_the_serialized_argument_limit_for_both_namespaces() {
        let overhead = serde_json::to_vec(&json!({"text":""})).unwrap().len();
        for prefix in ["agentrelay-", "agent-relay-"] {
            let mut payload = json!({"sessionId":"native-id","toolName":format!("{prefix}send_relay_message"),
                "toolArgs":{"text":"x".repeat(32 * 1024 - overhead)}});
            let value = input(serde_json::to_vec(&payload).unwrap().as_slice(), "before").unwrap();
            assert_eq!(value["toolArgs"], payload["toolArgs"]);
            payload["toolArgs"]["text"] = json!("x".repeat(32 * 1024 - overhead + 1));
            assert!(input(serde_json::to_vec(&payload).unwrap().as_slice(), "before").is_none());
        }
    }
    #[test]
    fn hook_forwards_identity_without_large_tool_results_or_client_binding() {
        let payload = json!({"sessionId":"native-id","cwd":"/fixture","initialPrompt":"x".repeat(1000),"toolResult":"x".repeat(5 * 1024 * 1024),"toolArgs":{"patch":"x".repeat(5 * 1024 * 1024)},"relayBinding":"forged"});
        let value = input(serde_json::to_vec(&payload).unwrap().as_slice(), "tool").unwrap();
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
