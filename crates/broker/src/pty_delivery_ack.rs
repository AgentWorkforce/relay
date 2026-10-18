//! Recipient-originated MCP read receipts for PTY deliveries.
//!
//! Each worker owns a private, short-lived directory inherited by its harness
//! and MCP subprocesses. A fresh nonce fences each delivery against stale reads.
use std::{
    fs,
    io::{self, Write},
    path::PathBuf,
};

use serde_json::json;
use sha2::{Digest, Sha256};

pub(crate) const ACK_DIR_ENV: &str = "RELAY_PTY_ACK_DIR";

/// Owns pending receipts and private harness configs for one PTY session.
pub(crate) struct NativeAckInbox(tempfile::TempDir);

impl NativeAckInbox {
    /// Create a private directory that is removed with the session.
    pub(crate) fn new() -> io::Result<Self> {
        let dir = tempfile::Builder::new()
            .prefix("relay-pty-acks-")
            .tempdir()?;
        Ok(Self(dir))
    }

    /// Let direct child processes discover this session's receipt directory.
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
            let names: Vec<_> = ["agent-relay", "relaycast"]
                .into_iter()
                .filter(|name| {
                    args.iter()
                        .any(|arg| arg.contains(&format!("mcp_servers.{name}.command=")))
                })
                .collect();
            for name in names {
                args.extend([
                    "--config".into(),
                    format!(
                        "mcp_servers.{name}.env.{ACK_DIR_ENV}={}",
                        serde_json::to_string(&directory)?
                    ),
                ]);
            }
        } else if cli == "claude" || cli == "claude.exe" {
            for index in 0..args.len() {
                let equals = args[index].strip_prefix("--mcp-config=");
                let value = if let Some(value) = equals {
                    value
                } else if index > 0 && args[index - 1] == "--mcp-config" {
                    &args[index]
                } else {
                    continue;
                };
                let raw = if value.trim_start().starts_with('{') {
                    value.to_string()
                } else {
                    fs::read_to_string(value)?
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
                // Keep credentials out of argv and leave the user's file intact.
                // The inbox owns the private file for the entire harness lifetime.
                let mut file = tempfile::NamedTempFile::new_in(self.0.path())?;
                file.write_all(config.to_string().as_bytes())?;
                let (_, path) = file.keep().map_err(|error| error.error)?;
                args[index] = if equals.is_some() {
                    format!("--mcp-config={}", path.display())
                } else {
                    path.to_string_lossy().into_owned()
                };
            }
        }
        Ok(())
    }

    /// Register a fresh recipient-bound nonce before submitting a message body.
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
    /// A receipt confirms this delivery only when it contains its fresh nonce.
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
        let config: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&claude[1]).unwrap()).unwrap();
        assert_eq!(
            config["mcpServers"]["agent-relay"]["env"][ACK_DIR_ENV],
            inbox.0.path().to_str().unwrap()
        );
        assert_eq!(
            config["mcpServers"]["agent-relay"]["env"]["RELAY_AGENT_NAME"],
            "worker"
        );
        assert!(config["mcpServers"]["other"].get("env").is_none());
        let mut codex = vec![
            "--config".into(),
            "mcp_servers.agent-relay.command=\"agent-relay\"".into(),
        ];
        inbox.configure_harness("codex", &mut codex).unwrap();
        assert!(codex[3].starts_with("mcp_servers.agent-relay.env.RELAY_PTY_ACK_DIR="));
        assert_eq!(
            &codex[..2],
            [
                "--config",
                "mcp_servers.agent-relay.command=\"agent-relay\""
            ]
        );
    }

    #[test]
    fn claude_file_and_equals_configs_stay_private_and_preserve_the_source() {
        let inbox = NativeAckInbox::new().unwrap();
        let source = tempfile::NamedTempFile::new().unwrap();
        let original = json!({"mcpServers": {
            "relaycast": {"command": "agent-relay", "env": {"RELAY_AGENT_NAME": "worker"}},
            "other": {"command": "other", "env": {"SECRET": "private-test-value"}}
        }})
        .to_string();
        fs::write(source.path(), &original).unwrap();
        for equals in [false, true] {
            let mut args = if equals {
                vec![format!("--mcp-config={}", source.path().display())]
            } else {
                vec![
                    "--mcp-config".into(),
                    source.path().to_string_lossy().into_owned(),
                ]
            };
            inbox.configure_harness("claude", &mut args).unwrap();
            assert!(!args.iter().any(|arg| arg.contains("private-test-value")));
            let path = args.last().unwrap().trim_start_matches("--mcp-config=");
            let config: serde_json::Value =
                serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
            assert_eq!(
                config["mcpServers"]["relaycast"]["env"][ACK_DIR_ENV],
                inbox.0.path().to_str().unwrap()
            );
            assert_eq!(
                config["mcpServers"]["other"]["env"]["SECRET"],
                "private-test-value"
            );
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                assert_eq!(
                    fs::metadata(path).unwrap().permissions().mode() & 0o777,
                    0o600
                );
            }
        }
        assert_eq!(fs::read_to_string(source.path()).unwrap(), original);
    }

    #[test]
    fn codex_legacy_server_receives_the_directory_without_a_second_server() {
        let inbox = NativeAckInbox::new().unwrap();
        let mut args = vec![
            "--config".into(),
            "mcp_servers.relaycast.command=\"agent-relay\"".into(),
        ];
        inbox.configure_harness("codex", &mut args).unwrap();
        assert!(args[3].starts_with("mcp_servers.relaycast.env.RELAY_PTY_ACK_DIR="));
        assert!(!args
            .iter()
            .any(|arg| arg.contains("mcp_servers.agent-relay")));
        let mut no_server = vec!["--model".into(), "test-model".into()];
        let original = no_server.clone();
        inbox.configure_harness("codex", &mut no_server).unwrap();
        assert_eq!(
            no_server, original,
            "local-only sessions must not get an incomplete MCP server"
        );
    }

    #[tokio::test]
    async fn wrap_claude_config_forwards_the_connected_identity_and_receipt_directory() {
        let inbox = NativeAckInbox::new().unwrap();
        let mut args = crate::snippets::configure_agent_relay_mcp_with_token(
            "claude",
            "connected-worker",
            Some("workspace-key"),
            None,
            &[],
            inbox.0.path(),
            Some("agent-token"),
            None,
            None,
        )
        .await
        .unwrap();
        inbox.configure_harness("claude", &mut args).unwrap();
        let index = args.iter().position(|arg| arg == "--mcp-config").unwrap() + 1;
        let config: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&args[index]).unwrap()).unwrap();
        let env = &config["mcpServers"]["agent-relay"]["env"];
        assert_eq!(env["RELAY_AGENT_NAME"], "connected-worker");
        assert_eq!(env["RELAY_AGENT_TOKEN"], "agent-token");
        assert_eq!(env[ACK_DIR_ENV], inbox.0.path().to_str().unwrap());
        assert!(!args.iter().any(|arg| arg.contains("agent-token")));
    }
}
