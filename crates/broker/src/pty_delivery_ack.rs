//! Recipient-originated MCP read receipts for PTY deliveries.
//!
//! Each worker owns a private, short-lived directory inherited by its harness
//! and MCP subprocesses. A fresh nonce fences each delivery against stale reads.
use std::{fs, io, path::PathBuf};

use serde_json::json;
use sha2::{Digest, Sha256};

pub(crate) const ACK_DIR_ENV: &str = "RELAY_PTY_ACK_DIR";

pub(crate) struct NativeAckInbox(tempfile::TempDir);

impl NativeAckInbox {
    pub(crate) fn new() -> io::Result<Self> {
        let dir = tempfile::Builder::new()
            .prefix("relay-pty-acks-")
            .tempdir()?;
        Ok(Self(dir))
    }

    pub(crate) fn expose_to_child(&self) {
        // PTY workers are dedicated processes; only their descendants inherit this path.
        std::env::set_var(ACK_DIR_ENV, self.0.path());
    }

    /// MCP subprocesses do not reliably inherit the harness environment.
    /// Forward only this worker's acknowledgement directory in their existing config.
    pub(crate) fn configure_harness(&self, cli: &str, args: &mut Vec<String>) -> io::Result<()> {
        let cli = crate::cli::command_parse::normalize_cli_name(cli).to_ascii_lowercase();
        let directory = self.0.path().to_string_lossy().to_string();
        if cli == "codex" || cli == "codex.exe" {
            args.extend([
                "--config".into(),
                format!(
                    "mcp_servers.agent-relay.env.{ACK_DIR_ENV}={}",
                    serde_json::to_string(&directory)?
                ),
            ]);
        } else if cli == "claude" || cli == "claude.exe" {
            for index in 1..args.len() {
                if args[index - 1] != "--mcp-config" {
                    continue;
                }
                let raw = if args[index].trim_start().starts_with('{') {
                    args[index].clone()
                } else {
                    fs::read_to_string(&args[index])?
                };
                let mut config: serde_json::Value = serde_json::from_str(&raw)?;
                if let Some(servers) = config
                    .get_mut("mcpServers")
                    .and_then(|value| value.as_object_mut())
                {
                    for name in ["agent-relay", "relaycast"] {
                        if let Some(server) = servers
                            .get_mut(name)
                            .and_then(|value| value.as_object_mut())
                        {
                            let env = server.entry("env").or_insert_with(|| json!({}));
                            if let Some(env) = env.as_object_mut() {
                                env.insert(ACK_DIR_ENV.into(), json!(directory));
                            }
                        }
                    }
                }
                // Replace the argument, never the user's config file.
                args[index] = config.to_string();
            }
        }
        Ok(())
    }

    pub(crate) fn register(&self, event_id: &str, agent_name: &str) -> io::Result<NativeAck> {
        let key = format!("{:x}", Sha256::digest(event_id.as_bytes()));
        let pending = self.0.path().join(format!("{key}.pending"));
        let nonce = uuid::Uuid::new_v4().to_string();
        let receipt = self.0.path().join(format!("{key}.{nonce}.read"));
        fs::write(
            &pending,
            json!({"messageId": event_id, "agentName": agent_name, "nonce": nonce}).to_string(),
        )?;
        Ok(NativeAck {
            pending,
            receipt,
            nonce,
        })
    }
}

#[derive(Debug)]
pub(crate) struct NativeAck {
    pending: PathBuf,
    receipt: PathBuf,
    nonce: String,
}

impl NativeAck {
    pub(crate) fn confirmed(&self) -> bool {
        fs::read_to_string(&self.receipt).is_ok_and(|value| value == self.nonce)
    }
}

impl Drop for NativeAck {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.pending);
        let _ = fs::remove_file(&self.receipt);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_receipt_requires_this_delivery_nonce_and_is_cleaned_up() {
        // Construct directly so parallel tests do not mutate process environment.
        let inbox = NativeAckInbox(tempfile::tempdir().unwrap());
        let ack = inbox.register("msg/../one", "worker").unwrap();
        assert!(!ack.confirmed());
        fs::write(&ack.receipt, "old-or-wrong-nonce").unwrap();
        assert!(!ack.confirmed());
        fs::write(&ack.receipt, &ack.nonce).unwrap();
        assert!(ack.confirmed());
        let pending = ack.pending.clone();
        let receipt = ack.receipt.clone();
        drop(ack);
        assert!(!pending.exists());
        assert!(!receipt.exists());
        assert!(!inbox.register("msg/../one", "worker").unwrap().confirmed());
    }

    #[test]
    fn native_ack_directory_is_forwarded_to_claude_and_codex_mcp() {
        let inbox = NativeAckInbox::new().unwrap();
        let mut claude = vec!["--mcp-config".into(), json!({"mcpServers": {"agent-relay": {"command": "agent-relay", "args": ["mcp"], "env": {"RELAY_AGENT_NAME": "worker"}}, "other": {"command": "other"}}}).to_string()];
        inbox.configure_harness("claude", &mut claude).unwrap();
        let config: serde_json::Value = serde_json::from_str(&claude[1]).unwrap();
        assert_eq!(
            config["mcpServers"]["agent-relay"]["env"][ACK_DIR_ENV],
            inbox.0.path().to_str().unwrap()
        );
        assert_eq!(
            config["mcpServers"]["agent-relay"]["env"]["RELAY_AGENT_NAME"],
            "worker"
        );
        assert!(config["mcpServers"]["other"].get("env").is_none());
        let mut codex = vec!["--model".into(), "test-model".into()];
        inbox.configure_harness("codex", &mut codex).unwrap();
        assert!(codex[3].starts_with("mcp_servers.agent-relay.env.RELAY_PTY_ACK_DIR="));
        assert_eq!(&codex[..2], ["--model", "test-model"]);
    }
}
