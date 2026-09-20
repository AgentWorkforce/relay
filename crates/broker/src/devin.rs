//! Devin keeps user MCP configuration under XDG_CONFIG_HOME, independently of
//! --config. Isolate that directory in the worker process, leaving HOME/data
//! paths (authentication, trust and sessions) intact. Never edit user files.
use crate::{
    pty::PtySession,
    readiness::{cli_prompt_ready, is_devin_cli, GridReadinessSnapshot},
};
use anyhow::{Context, Result};
use serde_json::Value;
use std::{fs, path::Path};

pub(crate) fn injection_bytes(cli: &str, text: &str) -> Vec<u8> {
    if is_devin_cli(cli) {
        format!("\x1b[200~{}\x1b[201~", text.replace('\x1b', "")).into_bytes()
    } else {
        text.as_bytes().to_vec()
    }
}

pub(crate) fn can_inject(cli: &str, pty: &PtySession) -> bool {
    !is_devin_cli(cli)
        || cli_prompt_ready(
            cli,
            GridReadinessSnapshot {
                screen: &pty.screen_text(),
                cursor: Some(pty.cursor_position()),
            },
        )
}

fn copy_tree(source: &Path, target: &Path) -> Result<()> {
    anyhow::ensure!(
        !fs::symlink_metadata(source)?.file_type().is_symlink(),
        "Devin configuration snapshot refuses symlinks inside the Devin config directory"
    );
    if source.is_dir() {
        fs::create_dir_all(target)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(target, fs::Permissions::from_mode(0o700))?;
        }
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            copy_tree(&entry.path(), &target.join(entry.file_name()))?;
        }
    } else {
        anyhow::ensure!(
            source.is_file(),
            "Devin configuration contains a non-regular file"
        );
        fs::copy(source, target)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(target, fs::Permissions::from_mode(0o600))?;
        }
    }
    Ok(())
}

fn isolated_config(source: &Path, relay_config: &str) -> Result<tempfile::TempDir> {
    let state = tempfile::Builder::new()
        .prefix("agent-relay-devin-")
        .tempdir()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(state.path(), fs::Permissions::from_mode(0o700))?;
    }
    for path in [source.join("devin"), source.join("devin/mcp_config.json")] {
        if let Ok(metadata) = fs::symlink_metadata(path) {
            anyhow::ensure!(
                !metadata.file_type().is_symlink(),
                "Devin configuration snapshot refuses symlinks inside the Devin config directory"
            );
        }
    }
    let devin = state.path().join("devin");
    fs::create_dir(&devin)?;
    if source.is_dir() {
        // Keep unrelated XDG application configuration visible to child tools.
        #[cfg(unix)]
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            if entry.file_name() != "devin" {
                std::os::unix::fs::symlink(entry.path(), state.path().join(entry.file_name()))?;
            }
        }
        let original = source.join("devin");
        if original.is_dir() {
            for entry in fs::read_dir(&original)? {
                let entry = entry?;
                if entry.file_name() != "mcp_config.json" {
                    copy_tree(&entry.path(), &devin.join(entry.file_name()))?;
                }
            }
        }
    }
    let original_mcp = source.join("devin/mcp_config.json");
    let mut config: Value = if original_mcp.exists() {
        json5::from_str(&fs::read_to_string(&original_mcp)?)
            .map_err(|_| anyhow::anyhow!("invalid Devin user MCP configuration"))?
    } else {
        serde_json::json!({})
    };
    let relay: Value = serde_json::from_str(relay_config)?;
    let object = config
        .as_object_mut()
        .context("Devin MCP configuration must be an object")?;
    let servers = object
        .entry("mcpServers")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .context("Devin mcpServers must be an object")?;
    servers.insert(
        "agent-relay".into(),
        relay["mcpServers"]["agent-relay"].clone(),
    );
    // The entire directory is private and unpublished until this function
    // returns; there is no shared-file read/modify/write race between workers.
    let mut file = tempfile::NamedTempFile::new_in(&devin)?;
    use std::io::Write;
    file.write_all(&serde_json::to_vec_pretty(&config)?)?;
    file.persist(devin.join("mcp_config.json"))?;
    Ok(state)
}

pub(crate) async fn prepare_worker_config(cli: &str) -> Result<Option<tempfile::TempDir>> {
    if !is_devin_cli(cli)
        || std::env::var("RELAY_AGENT_NAME").is_err()
        || std::env::var("RELAY_SKIP_PROMPT").as_deref() == Ok("1")
        || std::env::var("AGENT_RELAY_LOCAL_ONLY").as_deref() == Ok("1")
    {
        return Ok(None);
    }
    #[cfg(not(test))]
    crate::snippets::validate_agent_relay_mcp_command().await?;
    let source = std::env::var_os("XDG_CONFIG_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| dirs::home_dir().map(|p| p.join(".config")))
        .context("cannot locate Devin user configuration")?;
    // Project/local MCP has precedence over user MCP, including legacy
    // entries in settings. Never launch with a different worker's identity.
    let cwd = std::env::current_dir()?;
    for dir in cwd.ancestors() {
        for name in [
            "mcp_config.json",
            "mcp_config.local.json",
            "config.json",
            "config.local.json",
        ] {
            let path = dir.join(".devin").join(name);
            if path.exists() {
                let value: Value = json5::from_str(&fs::read_to_string(path)?)
                    .map_err(|_| anyhow::anyhow!("invalid Devin project configuration"))?;
                anyhow::ensure!(value["mcpServers"].get("agent-relay").is_none(),
                    "Devin project MCP defines agent-relay; remove that conflicting entry before spawning a Relay worker");
            }
        }
    }
    let env = |key| std::env::var(key).ok();
    let config = crate::snippets::agent_relay_mcp_config_json_with_result(
        env("RELAY_API_KEY").as_deref(),
        env("RELAY_BASE_URL").as_deref(),
        env("RELAY_AGENT_NAME").as_deref(),
        env("RELAY_AGENT_TOKEN").as_deref(),
        env("RELAY_WORKSPACES_JSON").as_deref(),
        env("RELAY_DEFAULT_WORKSPACE").as_deref(),
        None,
    );
    let state = isolated_config(&source, &config)?;
    // Called only inside the dedicated PTY/wrap worker, never the broker.
    std::env::set_var("XDG_CONFIG_HOME", state.path());
    Ok(Some(state))
}

#[cfg(test)]
mod tests {
    use super::*;
    // Native PTY fixture models the observed Devin paste debounce: Enter in
    // the paste burst is editor content; a later Enter submits the body.
    #[cfg(unix)]
    #[tokio::test]
    async fn paste_burst_parks_but_delayed_enter_submits() {
        use std::time::Duration;
        let script = r#"import os,tty,select,time
tty.setraw(0)
os.write(1,b'READY')
data=os.read(0,65536)
while select.select([0],[],[],0.06)[0]: data+=os.read(0,65536)
if data.endswith(b'\r'): os.write(1,b'PARKED')
else:
 if os.read(0,1)==b'\r': os.write(1,b'SUBMITTED')
time.sleep(0.3)
"#;
        for delayed in [false, true] {
            let (pty, mut rx) = PtySession::spawn(
                "python3",
                &["-u".into(), "-c".into(), script.into()],
                24,
                100,
            )
            .unwrap();
            let drain = tokio::spawn(async move { while rx.recv().await.is_some() {} });
            for _ in 0..100 {
                if pty.screen_text().contains("READY") {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            assert!(pty.screen_text().contains("READY"));
            let mut body = injection_bytes("devin", "first line\nsecond line");
            if delayed {
                let (ack, _) = pty
                    .submit_write_paced_with_followup_and_output_boundary(
                        body,
                        Duration::ZERO,
                        crate::wrap::injection_submit_followup_delay("devin").unwrap(),
                        b"\r".to_vec(),
                    )
                    .unwrap();
                ack.await.unwrap().unwrap();
            } else {
                body.push(b'\r');
                pty.submit_write(body).unwrap().await.unwrap().unwrap();
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
            assert!(pty
                .screen_text()
                .contains(if delayed { "SUBMITTED" } else { "PARKED" }));
            pty.shutdown().unwrap();
            drain.abort();
        }
    }

    #[test]
    fn malformed_mcp_fails_without_echoing_values() {
        let source = tempfile::tempdir().unwrap();
        fs::create_dir(source.path().join("devin")).unwrap();
        fs::write(
            source.path().join("devin/mcp_config.json"),
            "secret-sentinel invalid",
        )
        .unwrap();
        let error = isolated_config(source.path(), "{}")
            .unwrap_err()
            .to_string();
        assert_eq!(error, "invalid Devin user MCP configuration");
    }
    #[cfg(unix)]
    #[test]
    fn snapshot_refuses_symlink_traversal() {
        let source = tempfile::tempdir().unwrap();
        fs::create_dir(source.path().join("devin")).unwrap();
        std::os::unix::fs::symlink(source.path(), source.path().join("devin/loop")).unwrap();
        assert!(isolated_config(source.path(), "{}").is_err());
    }
    #[test]
    fn workers_preserve_user_config_and_isolate_identity() {
        let source = tempfile::tempdir().unwrap();
        fs::create_dir(source.path().join("devin")).unwrap();
        let settings = br#"{"permissions":{"deny":["Exec(sudo)"]}}"#;
        fs::write(source.path().join("devin/config.json"), settings).unwrap();
        let mcp = "{ // user comment\n mcpServers: { filesystem: { command: 'filesystem' } } }";
        fs::write(source.path().join("devin/mcp_config.json"), mcp).unwrap();
        let a = isolated_config(
            source.path(),
            r#"{"mcpServers":{"agent-relay":{"env":{"RELAY_AGENT_NAME":"a"}}}}"#,
        )
        .unwrap();
        let b = isolated_config(
            source.path(),
            r#"{"mcpServers":{"agent-relay":{"env":{"RELAY_AGENT_NAME":"b"}}}}"#,
        )
        .unwrap();
        assert_ne!(a.path(), b.path());
        for (dir, name) in [(&a, "a"), (&b, "b")] {
            let config: Value = serde_json::from_slice(
                &fs::read(dir.path().join("devin/mcp_config.json")).unwrap(),
            )
            .unwrap();
            assert_eq!(
                config["mcpServers"]["agent-relay"]["env"]["RELAY_AGENT_NAME"],
                name
            );
            assert_eq!(config["mcpServers"]["filesystem"]["command"], "filesystem");
            assert_eq!(
                fs::read(dir.path().join("devin/config.json")).unwrap(),
                settings
            );
        }
        assert_eq!(
            fs::read_to_string(source.path().join("devin/mcp_config.json")).unwrap(),
            mcp
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(a.path()).unwrap().permissions().mode() & 0o077,
                0
            );
        }
    }
}
