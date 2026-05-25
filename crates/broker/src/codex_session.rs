use std::{path::Path, process::Stdio, time::Duration};

use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines},
    process::{ChildStdin, ChildStdout, Command},
    time::timeout,
};

const CODEX_BOOTSTRAP_TIMEOUT: Duration = Duration::from_secs(15);

pub(crate) async fn create_resumable_codex_thread(
    codex_bin: &str,
    cwd: &Path,
    env: &[(String, String)],
) -> Result<String> {
    timeout(
        CODEX_BOOTSTRAP_TIMEOUT,
        create_resumable_codex_thread_inner(codex_bin, cwd, env),
    )
    .await
    .with_context(|| {
        format!("timed out creating Codex session via `{codex_bin} app-server --listen stdio://`")
    })?
}

async fn create_resumable_codex_thread_inner(
    codex_bin: &str,
    cwd: &Path,
    env: &[(String, String)],
) -> Result<String> {
    let thread_cwd = cwd.canonicalize().unwrap_or_else(|_| cwd.to_path_buf());
    let mut command = Command::new(codex_bin);
    command
        .arg("app-server")
        .arg("--listen")
        .arg("stdio://")
        .current_dir(&thread_cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    for (key, value) in env {
        command.env(key, value);
    }
    let mut child = command
        .spawn()
        .with_context(|| format!("failed to start `{codex_bin} app-server --listen stdio://`"))?;

    let mut stdin = child
        .stdin
        .take()
        .context("Codex app-server missing stdin pipe")?;
    let stdout = child
        .stdout
        .take()
        .context("Codex app-server missing stdout pipe")?;
    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                tracing::debug!(target: "broker::codex_session", stderr = %line, "codex app-server stderr");
            }
        });
    }

    let mut lines = BufReader::new(stdout).lines();
    let result = async {
        json_rpc_request(
            &mut stdin,
            &mut lines,
            1,
            "initialize",
            json!({
                "clientInfo": {
                    "name": "agent-relay",
                    "version": crate::util::version::broker_version(),
                },
                "capabilities": {
                    "experimentalApi": true,
                    "suppressNotifications": [],
                },
            }),
        )
        .await?;

        let start = json_rpc_request(
            &mut stdin,
            &mut lines,
            2,
            "thread/start",
            json!({
                "cwd": thread_cwd.to_string_lossy(),
                "ephemeral": false,
            }),
        )
        .await?;
        let thread_id = start
            .pointer("/thread/id")
            .and_then(Value::as_str)
            .context("Codex app-server thread/start response missing thread.id")?
            .to_string();

        json_rpc_request(
            &mut stdin,
            &mut lines,
            3,
            "thread/inject_items",
            json!({
                "threadId": thread_id,
                "items": [
                    {
                        "type": "message",
                        "role": "assistant",
                        "content": [
                            {
                                "type": "output_text",
                                "text": "",
                            },
                        ],
                    },
                ],
            }),
        )
        .await?;

        Ok(thread_id)
    }
    .await;

    let _ = child.kill().await;
    let _ = child.wait().await;

    result
}

async fn json_rpc_request(
    stdin: &mut ChildStdin,
    lines: &mut Lines<BufReader<ChildStdout>>,
    id: u64,
    method: &str,
    params: Value,
) -> Result<Value> {
    let request = json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params,
    });
    let encoded = serde_json::to_vec(&request)?;
    stdin
        .write_all(&encoded)
        .await
        .with_context(|| format!("failed writing Codex app-server request `{method}`"))?;
    stdin
        .write_all(b"\n")
        .await
        .with_context(|| format!("failed writing Codex app-server request newline `{method}`"))?;
    stdin
        .flush()
        .await
        .with_context(|| format!("failed flushing Codex app-server request `{method}`"))?;

    loop {
        let Some(line) = lines
            .next_line()
            .await
            .with_context(|| format!("failed reading Codex app-server response `{method}`"))?
        else {
            bail!("Codex app-server exited before responding to `{method}`");
        };
        let value = match serde_json::from_str::<Value>(&line) {
            Ok(value) => value,
            Err(error) => {
                tracing::debug!(
                    target: "broker::codex_session",
                    method = %method,
                    error = %error,
                    line = %line,
                    "skipping non-JSON Codex app-server stdout line"
                );
                continue;
            }
        };
        if value.get("id").and_then(Value::as_u64) != Some(id) {
            continue;
        }
        if let Some(error) = value.get("error") {
            bail!("Codex app-server `{method}` failed: {error}");
        }
        return value
            .get("result")
            .cloned()
            .with_context(|| format!("Codex app-server `{method}` response missing result"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[tokio::test]
    async fn create_resumable_codex_thread_uses_app_server_rpc() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().expect("temp dir");
        let fake_codex = dir.path().join("codex");
        std::fs::write(
            &fake_codex,
            r#"#!/bin/sh
if [ "$1" != "app-server" ]; then
  exit 2
fi
read line
printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{}}'
read line
printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"thread":{"id":"thread-test"}}}'
read line
printf '%s\n' '{"jsonrpc":"2.0","id":3,"result":{}}'
while read line; do :; done
"#,
        )
        .expect("write fake codex");
        let mut permissions = std::fs::metadata(&fake_codex)
            .expect("fake codex metadata")
            .permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&fake_codex, permissions).expect("chmod fake codex");

        let thread_id = create_resumable_codex_thread(
            fake_codex.to_str().expect("utf-8 fake codex path"),
            dir.path(),
            &[],
        )
        .await
        .expect("thread id");

        assert_eq!(thread_id, "thread-test");
    }
}
