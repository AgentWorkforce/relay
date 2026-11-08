//! The app-owned Factory helper never enrolls an identity during MCP startup.
//! Until native startup isolation is established it exposes no tools and refuses
//! calls locally, before looking up the person's home or opening a Relay socket.
use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use std::io::{BufRead, Read, Write};

const FRAME_LIMIT: u64 = 128 * 1024;

pub fn run(development: bool) -> Result<()> {
    if let Some(reason) = super::unavailable_reason() {
        return held_transport(
            &mut std::io::stdin().lock(),
            &mut std::io::stdout().lock(),
            &reason,
        );
    }
    // The shared transport derives authority from the native caller on the core,
    // not from flags, persisted bearer credentials, or MCP initialization.
    super::super::relay_mcp::run(development)
}

fn held_transport(input: &mut impl BufRead, output: &mut impl Write, reason: &str) -> Result<()> {
    loop {
        let mut line = String::new();
        if (&mut *input).take(FRAME_LIMIT + 1).read_line(&mut line)? == 0 {
            return Ok(());
        }
        if line.len() as u64 > FRAME_LIMIT || !line.ends_with('\n') {
            return Err(anyhow!("Factory Relay MCP frame is invalid or too large"));
        }
        let request: Value = serde_json::from_str(&line)?;
        let Some(id) = request.get("id") else {
            continue;
        };
        let result = match request["method"].as_str() {
            Some("initialize") => {
                json!({"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"Agent Relay Factory","version":"1"}})
            }
            Some("ping") => json!({}),
            Some("tools/list") => json!({"tools":[]}),
            Some("tools/call") => json!({"isError":true,"content":[{"type":"text","text":reason}]}),
            _ => {
                writeln!(
                    output,
                    "{}",
                    json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"Unsupported Agent Relay Factory MCP method"}})
                )?;
                output.flush()?;
                continue;
            }
        };
        writeln!(
            output,
            "{}",
            json!({"jsonrpc":"2.0","id":id,"result":result})
        )?;
        output.flush()?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn initialize_list_and_ping_are_inert_and_sends_are_denied_without_authority() {
        let input = concat!(
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"token\":\"synthetic-do-not-echo\"}}\n",
            "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n",
            "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\"}\n",
            "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"ping\"}\n",
            "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/call\",\"params\":{\"name\":\"send_relay_message\",\"arguments\":{\"to\":\"peer\",\"text\":\"synthetic-do-not-send\"}}}\n",
            "{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"tools/call\",\"params\":{\"name\":\"join_relay\"}}\n"
        );
        let mut output = Vec::new();
        held_transport(
            &mut Cursor::new(input),
            &mut output,
            super::super::STARTUP_ISOLATION_GUIDANCE,
        )
        .unwrap();
        let text = String::from_utf8(output).unwrap();
        let rows: Vec<Value> = text
            .lines()
            .map(|row| serde_json::from_str(row).unwrap())
            .collect();
        assert_eq!(rows.len(), 5);
        assert_eq!(
            rows[0]["result"]["serverInfo"]["name"],
            "Agent Relay Factory"
        );
        assert_eq!(rows[1]["result"], json!({"tools":[]}));
        assert_eq!(rows[2]["result"], json!({}));
        assert!(rows[3..].iter().all(|row| row["result"]["isError"] == true));
        assert!(!text.contains("synthetic-do-not-echo"));
        assert!(!text.contains("synthetic-do-not-send"));
        // Only the supplied reader/writer and fixed reason reach this function:
        // there is no configuration, authority, enrollment or socket dependency.
    }

    #[test]
    fn truncated_and_oversized_frames_never_authorize_a_call() {
        for value in [
            "{}".to_string(),
            format!("{}\n", "x".repeat(FRAME_LIMIT as usize)),
        ] {
            let mut output = Vec::new();
            assert!(held_transport(&mut Cursor::new(value), &mut output, "held").is_err());
            assert!(output.is_empty());
        }
    }
}
