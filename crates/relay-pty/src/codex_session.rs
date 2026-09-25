//! Pre-creation of resumable Codex sessions.
//!
//! Codex can resume an existing thread by id. Spawning `codex app-server`
//! briefly and driving its JSON-RPC interface yields a persisted thread id
//! that a later PTY spawn can `codex resume` into, so the session survives
//! agent restarts.

use std::{
    collections::HashMap,
    path::Path,
    process::Stdio,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines},
    process::{ChildStdin, ChildStdout},
    time::timeout,
};

const CODEX_BOOTSTRAP_TIMEOUT: Duration = Duration::from_secs(15);
const CODEX_QUEUE_PROBE_TIMEOUT: Duration = Duration::from_secs(1);
const CODEX_QUEUE_PROBE_TTL: Duration = Duration::from_secs(60);
const CODEX_QUEUE_FALLBACKS: [&str; 3] = [
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
];

#[derive(Debug, Clone)]
struct QueueProbeCacheEntry {
    resolved: Option<String>,
    observed_at: Instant,
}

static CODEX_QUEUE_PROBE_CACHE: OnceLock<Mutex<HashMap<String, QueueProbeCacheEntry>>> =
    OnceLock::new();

/// Resolve a Codex executable that exposes `codex queue`.
///
/// A bare `codex` can lag behind the desktop app bundle on macOS, so PATH is
/// only the first candidate. Explicit paths stay explicit: if the caller named
/// one, do not silently replace it with a different installation.
pub async fn resolve_queue_capable_codex_command(
    primary: &str,
    global_args: &[String],
    cwd: Option<&Path>,
    env: &[(String, String)],
    allow_bundle_fallbacks: bool,
) -> Option<String> {
    let cache_key =
        codex_queue_probe_cache_key(primary, global_args, cwd, env, allow_bundle_fallbacks);
    if let Some(entry) = CODEX_QUEUE_PROBE_CACHE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .ok()
        .and_then(|cache| cache.get(&cache_key).cloned())
    {
        if entry.observed_at.elapsed() <= CODEX_QUEUE_PROBE_TTL {
            return entry.resolved;
        }
    }

    let mut resolved = None;
    for candidate in codex_queue_command_candidates(primary, allow_bundle_fallbacks) {
        if codex_command_has_queue(&candidate, global_args, cwd, env).await {
            resolved = Some(candidate);
            break;
        }
    }
    if let Ok(mut cache) = CODEX_QUEUE_PROBE_CACHE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
    {
        cache.insert(
            cache_key,
            QueueProbeCacheEntry {
                resolved: resolved.clone(),
                observed_at: Instant::now(),
            },
        );
    }
    resolved
}

fn codex_queue_probe_cache_key(
    primary: &str,
    global_args: &[String],
    cwd: Option<&Path>,
    env: &[(String, String)],
    allow_bundle_fallbacks: bool,
) -> String {
    let primary_fingerprint = explicit_command_fingerprint(primary);
    let codex_home = env
        .iter()
        .rev()
        .find(|(key, _)| key == "CODEX_HOME")
        .map(|(_, value)| value.as_str())
        .unwrap_or("");
    format!(
        "{primary}\nprimary_fingerprint={primary_fingerprint}\nargs={}\ncwd={}\nCODEX_HOME={codex_home}\nbundle_fallbacks={allow_bundle_fallbacks}",
        global_args.join("\u{1f}"),
        cwd.map(|path| path.display().to_string())
            .unwrap_or_default()
    )
}

fn explicit_command_fingerprint(command: &str) -> String {
    let path = Path::new(command);
    if path.components().count() == 1 {
        return String::new();
    }
    let Ok(metadata) = std::fs::metadata(path) else {
        return "missing".to_string();
    };
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos().to_string())
        .unwrap_or_else(|| "unknown".to_string());
    format!("len={};modified={modified}", metadata.len())
}

pub fn codex_queue_command_candidates(primary: &str, allow_bundle_fallbacks: bool) -> Vec<String> {
    let mut candidates = vec![primary.to_string()];
    if allow_bundle_fallbacks && is_bare_codex_command(primary) {
        for fallback in CODEX_QUEUE_FALLBACKS {
            if Path::new(fallback).is_file() && !candidates.iter().any(|item| item == fallback) {
                candidates.push(fallback.to_string());
            }
        }
    }
    candidates
}

async fn codex_command_has_queue(
    command: &str,
    global_args: &[String],
    cwd: Option<&Path>,
    env: &[(String, String)],
) -> bool {
    let mut probe = Command::new(command);
    probe
        .args(global_args)
        .arg("queue")
        .arg("--help")
        .stdin(Stdio::null())
        .kill_on_drop(true);
    if let Some(cwd) = cwd {
        probe.current_dir(cwd);
    }
    for (key, value) in env {
        probe.env(key, value);
    }
    let Ok(Ok(output)) = timeout(CODEX_QUEUE_PROBE_TIMEOUT, probe.output()).await else {
        return false;
    };
    if !output.status.success() {
        return false;
    }
    let mut help = output.stdout;
    help.extend_from_slice(&output.stderr);
    let help = String::from_utf8_lossy(&help);
    help.contains("--thread") && help.contains("--message")
}

fn is_bare_codex_command(command: &str) -> bool {
    let path = Path::new(command);
    path.components().count() == 1
        && path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name == "codex" || name == "codex.exe")
}

/// Create a resumable Codex thread and return its id.
///
/// `client_version` is the version string reported to the app-server in the
/// `initialize` handshake (alongside the `agent-relay` client name), so the
/// pre-created thread is attributed to the same release as the caller.
pub async fn create_resumable_codex_thread(
    codex_bin: &str,
    cwd: &Path,
    env: &[(String, String)],
    cli_args: &[String],
    client_version: &str,
) -> Result<String> {
    timeout(
        CODEX_BOOTSTRAP_TIMEOUT,
        create_resumable_codex_thread_inner(codex_bin, cwd, env, cli_args, client_version),
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
    cli_args: &[String],
    client_version: &str,
) -> Result<String> {
    let thread_cwd = cwd.canonicalize().unwrap_or_else(|_| cwd.to_path_buf());
    let mut command = crate::credentials::scrubbed_command(codex_bin);
    command
        // These are top-level Codex flags. They must precede the subcommand:
        // `codex app-server --dangerously-...` is rejected by clap, while
        // `codex --dangerously-... app-server` preserves the PTY launch's
        // config/profile context and starts normally.
        .args(codex_app_server_passthrough_args(cli_args))
        .arg("app-server")
        .arg("--listen")
        .arg("stdio://")
        .kill_on_drop(true)
        .current_dir(&thread_cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
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
                tracing::debug!(target: "relay_pty::codex_session", stderr = %line, "codex app-server stderr");
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
                    "version": client_version,
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

/// Forward Codex CLI flags that the `app-server` honors, so the pre-created
/// thread is bootstrapped under the same profile/config context that the PTY
/// will later resume into. Positional arguments and runtime-only flags are
/// dropped here — the PTY spawn already passes those through.
fn codex_app_server_passthrough_args(cli_args: &[String]) -> Vec<String> {
    const PASSTHROUGH_VALUE_FLAGS: &[&str] = &[
        "--profile",
        "--config",
        "-c",
        "--cd",
        "--cwd",
        "--sandbox",
        "-s",
        "--ask-for-approval",
        "--approval-policy",
    ];
    const PASSTHROUGH_BOOL_FLAGS: &[&str] =
        &["--dangerously-bypass-approvals-and-sandbox", "--full-auto"];
    let mut out = Vec::new();
    let mut index = 0;
    while index < cli_args.len() {
        let arg = cli_args[index].as_str();
        if arg == "--" {
            break;
        }
        if let Some((flag, _)) = arg.split_once('=') {
            if PASSTHROUGH_VALUE_FLAGS.contains(&flag) {
                out.push(arg.to_string());
            }
            index += 1;
            continue;
        }
        if PASSTHROUGH_VALUE_FLAGS.contains(&arg) {
            if let Some(value) = cli_args.get(index + 1) {
                out.push(arg.to_string());
                out.push(value.clone());
                index += 2;
                continue;
            }
            index += 1;
            continue;
        }
        if PASSTHROUGH_BOOL_FLAGS.contains(&arg) {
            out.push(arg.to_string());
            index += 1;
            continue;
        }
        index += 1;
    }
    out
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
                    target: "relay_pty::codex_session",
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
if [ "$1" != "--dangerously-bypass-approvals-and-sandbox" ] || [ "$2" != "app-server" ]; then
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
            &["--dangerously-bypass-approvals-and-sandbox".to_string()],
            "0.0.0-test",
        )
        .await
        .expect("thread id");

        assert_eq!(thread_id, "thread-test");
    }

    #[test]
    fn passthrough_args_keep_profile_config_and_cwd() {
        let args = vec![
            "--profile".to_string(),
            "team".to_string(),
            "--config".to_string(),
            "trust_level=trusted".to_string(),
            "-c".to_string(),
            "key=value".to_string(),
            "--cd=/tmp/elsewhere".to_string(),
            "--full-auto".to_string(),
            "resume".to_string(),
            "abc-123".to_string(),
            "--".to_string(),
            "--profile".to_string(),
            "ignored".to_string(),
        ];
        let out = codex_app_server_passthrough_args(&args);
        assert_eq!(
            out,
            vec![
                "--profile".to_string(),
                "team".to_string(),
                "--config".to_string(),
                "trust_level=trusted".to_string(),
                "-c".to_string(),
                "key=value".to_string(),
                "--cd=/tmp/elsewhere".to_string(),
                "--full-auto".to_string(),
            ]
        );
    }

    #[test]
    fn queue_candidates_try_app_bundle_for_bare_codex_only() {
        let bare = codex_queue_command_candidates("codex", true);
        assert_eq!(bare.first().map(String::as_str), Some("codex"));
        assert!(
            bare.iter()
                .any(|candidate| candidate == "/Applications/ChatGPT.app/Contents/Resources/codex")
                || !Path::new("/Applications/ChatGPT.app/Contents/Resources/codex").is_file(),
            "the desktop app codex should be considered when it exists"
        );

        let exact_bare = codex_queue_command_candidates("codex", false);
        assert_eq!(exact_bare, vec!["codex".to_string()]);

        let explicit = codex_queue_command_candidates("/custom/bin/codex", true);
        assert_eq!(explicit, vec!["/custom/bin/codex".to_string()]);
    }
}
