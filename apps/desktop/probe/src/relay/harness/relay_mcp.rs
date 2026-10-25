//! A launch-pinned MCP transport with only the session-scoped send capability.
//! No credential or caller identity is accepted from MCP arguments: the socket
//! derives the caller from this process's kernel-proven agent ancestry.

use anyhow::Result;
use serde_json::{json, Value};
use std::io::{BufRead, Read, Write};
use std::path::Path;

const FRAME_LIMIT: u64 = 128 * 1024;
pub(crate) const TOOL: &str = "send_relay_message";

#[derive(Clone, Copy)]
pub(crate) enum Harness {
    Devin,
    Muse,
}
pub(crate) fn definition(helper: &Path, alias: &str, development: bool, harness: Harness) -> Value {
    let command = match harness {
        Harness::Devin => "devin-spawn-mcp",
        Harness::Muse => "muse-spawn-mcp",
    };
    let mut arguments = vec!["relay", command];
    if development {
        arguments.push("--dev");
    }
    json!({"name":alias,"command":helper,"args":arguments,"env":[]})
}

/// Strictly the send tool's documented inputs; never an arbitrary command,
/// socket, identity, HTTP header, or configuration override.
pub(crate) fn valid_arguments(arguments: &Value) -> bool {
    let Some(object) = arguments.as_object() else {
        return false;
    };
    if object
        .keys()
        .any(|key| !matches!(key.as_str(), "to" | "text" | "reply_to"))
    {
        return false;
    }
    let valid_to = arguments["to"].as_str().is_some_and(|to| {
        !to.is_empty()
            && to.len() <= 256
            && to.bytes().filter(|b| *b == b'@').count() <= 1
            && to
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_.@".contains(&b))
            && crate::relay::links::Endpoint::parse(to).is_ok()
    });
    let valid_text = arguments["text"].as_str().is_some_and(|text| {
        !text.trim().is_empty() && text.len() <= 65_536 && !text.contains('\0')
    });
    let valid_reply = object.get("reply_to").is_none_or(|value| {
        value.as_str().is_some_and(|id| {
            !id.is_empty() && id.len() <= 32 && id.bytes().all(|b| b.is_ascii_digit())
        })
    });
    valid_to && valid_text && valid_reply
}

fn tool() -> Value {
    json!({"name":TOOL,"description":"Send a reply or direct message on Agent Relay as this exact agent session. Uses the local authenticated session socket, without shell commands.","inputSchema":{"type":"object","properties":{"to":{"type":"string","maxLength":256},"text":{"type":"string","maxLength":65536},"reply_to":{"type":"string","pattern":"^[0-9]{1,32}$"}},"required":["to","text"],"additionalProperties":false}})
}

fn send_message(arguments: &Value, development: bool) -> Result<Value> {
    if !valid_arguments(arguments) {
        anyhow::bail!("Invalid Agent Relay send arguments");
    }
    let socket = crate::relay::cli::pointed_socket(&crate::relay::paths::home()?, development)?;
    let recipient = arguments["to"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing recipient"))?;
    let text = arguments["text"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing text"))?;
    let mut path = format!(
        "/send?to={}",
        crate::relay::outbound::query_encode(recipient)
    );
    if let Some(parent) = arguments["reply_to"].as_str() {
        path.push_str(&format!(
            "&reply_to={}",
            crate::relay::outbound::query_encode(parent)
        ));
    }
    let (status, body) = crate::relay::cli::socket_response(
        &socket,
        "POST",
        &path,
        text.as_bytes(),
        crate::relay::cli::SOCKET_TIMEOUT,
    )?;
    if !(200..300).contains(&status) {
        anyhow::bail!("Agent Relay refused the send (HTTP {status})");
    }
    receipt(&body, recipient)
}

fn receipt(body: &[u8], recipient: &str) -> Result<Value> {
    let response: Value = serde_json::from_slice(body)?;
    let data = &response["data"];
    let expected = crate::relay::links::Endpoint::parse(recipient)
        .map_err(|_| anyhow::anyhow!("Invalid recipient"))?;
    let valid_id = data["message_id"].as_str().is_some_and(|id| {
        !id.is_empty() && id.len() <= 32 && id.bytes().all(|byte| byte.is_ascii_digit())
    });
    let valid_sender = data["from"].as_str().is_some_and(|sender| {
        !sender.is_empty()
            && sender.len() <= 256
            && sender
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte))
    });
    if response["ok"] != true || !valid_id || !valid_sender || data["to"] != expected.value() {
        anyhow::bail!("Agent Relay did not return a valid send receipt");
    }
    // The authenticated socket determines the sender from kernel ancestry.
    // Return its receipt, without guessing a caller identity from MCP flags.
    Ok(json!({"accepted":true,"message_id":data["message_id"],"from":data["from"],"to":data["to"]}))
}

fn dispatch(request: &Value, send: &mut impl FnMut(&Value) -> Result<Value>) -> Value {
    let result = match request["method"].as_str() {
        Some("initialize") => {
            json!({"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"Agent Relay session","version":"1"}})
        }
        Some("ping") => json!({}),
        Some("tools/list") => json!({"tools":[tool()]}),
        Some("tools/call") if request["params"]["name"] == TOOL => {
            let arguments = &request["params"]["arguments"];
            let answer = if valid_arguments(arguments) {
                send(arguments)
            } else {
                Err(anyhow::anyhow!("Invalid Agent Relay arguments"))
            };
            match answer {
                Ok(value) => json!({"content":[{"type":"text","text":value.to_string()}]}),
                Err(_) => {
                    json!({"isError":true,"content":[{"type":"text","text":"Agent Relay could not send this message. No broader permission was granted."}]})
                }
            }
        }
        _ => {
            return json!({"jsonrpc":"2.0","id":request["id"],"error":{"code":-32601,"message":"Unsupported Agent Relay MCP method or tool"}});
        }
    };
    json!({"jsonrpc":"2.0","id":request["id"],"result":result})
}

pub fn run(development: bool) -> Result<()> {
    let mut reader = std::io::stdin().lock();
    let mut output = std::io::stdout().lock();
    loop {
        let mut line = String::new();
        if (&mut reader).take(FRAME_LIMIT + 1).read_line(&mut line)? == 0 {
            return Ok(());
        }
        if line.len() as u64 > FRAME_LIMIT || !line.ends_with('\n') {
            anyhow::bail!("Agent Relay MCP frame is too large");
        }
        let request: Value = serde_json::from_str(&line)?;
        if request.get("id").is_none() {
            continue;
        }
        let response = dispatch(&request, &mut |arguments| {
            send_message(arguments, development)
        });
        writeln!(output, "{response}")?;
        output.flush()?;
    }
}

#[cfg(test)]
mod tests;
