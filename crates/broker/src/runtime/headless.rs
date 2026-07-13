use super::*;

pub(crate) fn headless_provider_cli_name(provider: &ProtocolHeadlessProvider) -> &'static str {
    match provider {
        ProtocolHeadlessProvider::Claude => "claude",
        ProtocolHeadlessProvider::Opencode => "opencode",
    }
}

pub(crate) fn headless_provider_command(
    provider: &ProtocolHeadlessProvider,
    task: &str,
    extra_args: &[String],
) -> (String, Vec<String>) {
    match provider {
        ProtocolHeadlessProvider::Claude => {
            let mut args = vec![
                "-p".to_string(),
                "--dangerously-skip-permissions".to_string(),
            ];
            args.extend(extra_args.iter().cloned());
            args.push(task.to_string());
            ("claude".to_string(), args)
        }
        ProtocolHeadlessProvider::Opencode => {
            let mut args = vec!["run".to_string()];
            args.extend(extra_args.iter().cloned());
            args.push(task.to_string());
            ("opencode".to_string(), args)
        }
    }
}

pub(crate) fn headless_provider_from_cli(value: &str) -> Option<ProtocolHeadlessProvider> {
    match value.trim().to_ascii_lowercase().as_str() {
        "claude" => Some(ProtocolHeadlessProvider::Claude),
        "opencode" => Some(ProtocolHeadlessProvider::Opencode),
        _ => None,
    }
}

/// Turn a raw stdout/stderr segment read via `read_until(b'\n', …)` into a
/// `worker_stream` chunk, forwarding the bytes verbatim. Unlike
/// `tokio::io::Lines` — which strips the terminator (losing `\r\n` vs `\n`) and
/// gives no way to tell a terminated line from a final unterminated one — a
/// delimiter-preserving read keeps the exact byte boundaries the child wrote:
/// the trailing `\n` (and any preceding `\r`) is retained, and a final segment
/// with no terminator is forwarded without fabricating one. Invalid UTF-8 is
/// replaced lossily, consistent with the rest of the headless path.
///
/// Without preserving the terminator, consumers that write chunks verbatim
/// (e.g. `relay node tail`) would concatenate every line from a headless worker
/// onto one giant line.
pub(crate) fn headless_stream_chunk(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// Read a child stdout/stderr pipe segment-by-segment on `\n` boundaries and
/// forward each segment as a `worker_stream` chunk, preserving the terminator
/// (or its absence, for a final unterminated segment) via
/// [`headless_stream_chunk`]. A zero-length `read_until` result means EOF.
async fn forward_headless_stream<R>(
    reader: R,
    stream: &'static str,
    out_tx: &mpsc::Sender<ProtocolEnvelope<Value>>,
) where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut reader = BufReader::new(reader);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                let _ = send_frame(
                    out_tx,
                    "worker_stream",
                    None,
                    json!({
                        "stream": stream,
                        "chunk": headless_stream_chunk(&buf),
                    }),
                )
                .await;
            }
        }
    }
}

pub(crate) async fn run_headless_worker(cmd: HeadlessCommand) -> Result<()> {
    let provider: ProtocolHeadlessProvider = cmd.provider.into();
    let provider_name = headless_provider_cli_name(&provider);
    let provider_args = cmd.args.clone();

    let (out_tx, mut out_rx) = mpsc::channel::<ProtocolEnvelope<Value>>(512);
    let writer_task = tokio::spawn(async move {
        // Keep one async stdout handle for this process. Tokio's `write_all`
        // is not cancel-safe if the task is aborted mid-write, so shutdown
        // below drops `out_tx` and awaits this task before returning.
        let mut stdout = tokio::io::stdout();
        while let Some(frame) = out_rx.recv().await {
            if let Ok(mut line) = serde_json::to_string(&frame) {
                line.push('\n');
                if stdout.write_all(line.as_bytes()).await.is_err() || stdout.flush().await.is_err()
                {
                    break;
                }
            }
        }
    });

    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut worker_name = cmd
        .agent_name
        .clone()
        .unwrap_or_else(|| format!("headless-{provider_name}"));
    let mut final_exit_code: Option<i32> = None;
    let mut final_exit_signal: Option<String> = None;

    while let Ok(Some(line)) = lines.next_line().await {
        let frame: ProtocolEnvelope<Value> = match serde_json::from_str(&line) {
            Ok(frame) => frame,
            Err(error) => {
                let _ = send_frame(
                    &out_tx,
                    "worker_error",
                    None,
                    json!({
                        "code":"invalid_frame",
                        "message": error.to_string(),
                        "retryable": false,
                    }),
                )
                .await;
                continue;
            }
        };

        match frame.msg_type.as_str() {
            "init_worker" => {
                worker_name = cmd
                    .agent_name
                    .clone()
                    .or_else(|| {
                        frame
                            .payload
                            .get("agent")
                            .and_then(|a| a.get("name"))
                            .and_then(Value::as_str)
                            .map(ToOwned::to_owned)
                    })
                    .unwrap_or_else(|| format!("headless-{provider_name}"));

                let _ = send_frame(
                    &out_tx,
                    "worker_ready",
                    frame.request_id,
                    json!({
                        "name": &worker_name,
                        "runtime": "headless",
                    }),
                )
                .await;
            }
            "deliver_relay" => {
                let request_id = frame.request_id.clone();
                let delivery: RelayDelivery = match serde_json::from_value(frame.payload) {
                    Ok(d) => d,
                    Err(error) => {
                        let _ = send_frame(
                            &out_tx,
                            "worker_error",
                            request_id,
                            json!({
                                "code":"invalid_delivery",
                                "message": error.to_string(),
                                "retryable": false,
                            }),
                        )
                        .await;
                        continue;
                    }
                };

                let timestamp = chrono::Utc::now().timestamp_millis();
                let delivery_id = delivery.delivery_id;
                let event_id = delivery.event_id;

                let _ = send_frame(
                    &out_tx,
                    "delivery_queued",
                    None,
                    json!({
                        "delivery_id": delivery_id,
                        "event_id": event_id,
                        "agent": &worker_name,
                        "timestamp": timestamp,
                    }),
                )
                .await;

                let _ = send_frame(
                    &out_tx,
                    "delivery_injected",
                    None,
                    json!({
                        "delivery_id": delivery_id,
                        "event_id": event_id,
                        "agent": &worker_name,
                        "timestamp": timestamp,
                    }),
                )
                .await;

                let _ = send_frame(
                    &out_tx,
                    "delivery_active",
                    None,
                    json!({
                        "delivery_id": delivery_id,
                        "event_id": event_id,
                        "pattern": format!("headless:{}", provider_name),
                    }),
                )
                .await;

                let task_text = delivery.body.clone();
                let (binary, args) =
                    headless_provider_command(&provider, &task_text, &provider_args);

                let mut child_cmd = tokio::process::Command::new(&binary);
                child_cmd
                    .args(&args)
                    .stdin(Stdio::null())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped());

                // Auto-approve tool permissions for opencode in headless mode.
                if matches!(provider, ProtocolHeadlessProvider::Opencode) {
                    child_cmd.env(
                        "OPENCODE_PERMISSION",
                        r#"{"*":"allow","external_directory":{"*":"allow"}}"#,
                    );
                }

                let mut child = match child_cmd.spawn() {
                    Ok(child) => child,
                    Err(error) => {
                        let _ = send_frame(
                            &out_tx,
                            "delivery_failed",
                            None,
                            json!({
                                "delivery_id": delivery_id,
                                "event_id": event_id,
                                "reason": format!("failed to spawn {}: {}", binary, error),
                            }),
                        )
                        .await;
                        let _ = send_frame(
                            &out_tx,
                            "worker_error",
                            request_id,
                            json!({
                                "code":"spawn_failed",
                                "message": format!("failed to spawn {}: {}", binary, error),
                                "retryable": false,
                            }),
                        )
                        .await;
                        final_exit_code = Some(1);
                        break;
                    }
                };

                let _ = send_frame(
                    &out_tx,
                    "delivery_ack",
                    request_id.clone(),
                    json!({
                        "delivery_id": delivery_id,
                        "event_id": event_id,
                    }),
                )
                .await;

                let stdout = child.stdout.take();
                let stderr = child.stderr.take();

                let stream_stdout = {
                    let out_tx = out_tx.clone();
                    async move {
                        if let Some(stdout) = stdout {
                            forward_headless_stream(stdout, "stdout", &out_tx).await;
                        }
                    }
                };

                let stream_stderr = {
                    let out_tx = out_tx.clone();
                    async move {
                        if let Some(stderr) = stderr {
                            forward_headless_stream(stderr, "stderr", &out_tx).await;
                        }
                    }
                };

                let (status, _, _) = tokio::join!(child.wait(), stream_stdout, stream_stderr);

                match status {
                    Ok(exit_status) => {
                        final_exit_code = exit_status.code();
                        final_exit_signal = None;
                        if exit_status.success() {
                            let _ = send_frame(
                                &out_tx,
                                "delivery_verified",
                                None,
                                json!({
                                    "delivery_id": delivery_id,
                                    "event_id": event_id,
                                }),
                            )
                            .await;
                        } else {
                            let reason = match exit_status.code() {
                                Some(code) => format!("{} exited with code {}", binary, code),
                                None => format!("{} exited without an exit code", binary),
                            };
                            let _ = send_frame(
                                &out_tx,
                                "delivery_failed",
                                None,
                                json!({
                                    "delivery_id": delivery_id,
                                    "event_id": event_id,
                                    "reason": reason,
                                }),
                            )
                            .await;
                        }
                    }
                    Err(error) => {
                        let reason = format!("failed waiting for {}: {}", binary, error);
                        let _ = send_frame(
                            &out_tx,
                            "delivery_failed",
                            None,
                            json!({
                                "delivery_id": delivery_id,
                                "event_id": event_id,
                                "reason": reason,
                            }),
                        )
                        .await;
                        let _ = send_frame(
                            &out_tx,
                            "worker_error",
                            request_id,
                            json!({
                                "code":"wait_failed",
                                "message": format!("failed waiting for {}: {}", binary, error),
                                "retryable": false,
                            }),
                        )
                        .await;
                        final_exit_code = Some(1);
                    }
                }

                break;
            }
            "ping" => {
                let ts = frame
                    .payload
                    .get("ts_ms")
                    .and_then(Value::as_u64)
                    .unwrap_or_default();
                let _ = send_frame(&out_tx, "pong", frame.request_id, json!({"ts_ms": ts})).await;
            }
            "shutdown_worker" => {
                break;
            }
            other => {
                let _ = send_frame(
                    &out_tx,
                    "worker_error",
                    frame.request_id,
                    json!({
                        "code":"unknown_type",
                        "message": format!("unsupported message type '{}'", other),
                        "retryable": false,
                    }),
                )
                .await;
            }
        }
    }

    let _ = send_frame(
        &out_tx,
        "worker_exited",
        None,
        json!({"code": final_exit_code, "signal": final_exit_signal}),
    )
    .await;
    drop(out_tx);
    let _ = writer_task.await;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn headless_stream_chunk_preserves_terminated_line() {
        // A `read_until(b'\n', …)` segment for a terminated line carries the
        // trailing newline, which is forwarded verbatim.
        assert_eq!(headless_stream_chunk(b"hello\n"), "hello\n");
    }

    #[test]
    fn headless_stream_chunk_preserves_crlf() {
        // `Lines` would strip both `\r` and `\n`, silently normalizing `\r\n`
        // to `\n`. A delimiter-preserving read keeps the CR intact.
        assert_eq!(headless_stream_chunk(b"hello\r\n"), "hello\r\n");
    }

    #[test]
    fn headless_stream_chunk_does_not_fabricate_newline_for_final_segment() {
        // A final unterminated segment (e.g. child `printf 'result'`) is
        // forwarded as-is, without a fabricated trailing `\n`.
        assert_eq!(headless_stream_chunk(b"result"), "result");
    }

    #[test]
    fn headless_stream_chunk_preserves_blank_line() {
        // A blank line in the stream is a bare `\n` segment, forwarded as-is.
        assert_eq!(headless_stream_chunk(b"\n"), "\n");
    }

    #[test]
    fn headless_stream_chunk_does_not_touch_interior_content() {
        // Embedded whitespace/content is passed through untouched alongside the
        // preserved terminator.
        assert_eq!(
            headless_stream_chunk(b"  indented line with trailing spaces  \n"),
            "  indented line with trailing spaces  \n"
        );
    }

    #[test]
    fn headless_stream_chunk_replaces_invalid_utf8_lossily() {
        // Invalid UTF-8 bytes are replaced with U+FFFD, consistent with the
        // rest of the headless path; the terminator is still preserved.
        assert_eq!(headless_stream_chunk(b"\xff\n"), "\u{fffd}\n");
    }
}
