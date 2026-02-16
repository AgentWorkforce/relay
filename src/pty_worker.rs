use super::*;
use crate::wrap::{PtyAutoState, AUTO_SUGGESTION_BLOCK_TIMEOUT};

#[derive(Debug, Clone)]
struct PendingWorkerInjection {
    delivery: RelayDelivery,
    request_id: Option<String>,
    queued_at: Instant,
}

pub(crate) async fn run_pty_worker(cmd: PtyCommand) -> Result<()> {
    // Disable Claude Code auto-suggestions to prevent accidental acceptance during injection.
    #[allow(deprecated)]
    std::env::set_var("CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION", "false");

    #[cfg(unix)]
    let (init_rows, init_cols) = get_terminal_size().unwrap_or((24, 80));
    #[cfg(not(unix))]
    let (init_rows, init_cols) = (24u16, 80u16);
    let (pty, mut pty_rx) = PtySession::spawn(&cmd.cli, &cmd.args, init_rows, init_cols)?;
    let mut terminal_query_parser = TerminalQueryParser::default();

    let (out_tx, mut out_rx) = mpsc::channel::<ProtocolEnvelope<Value>>(1024);
    tokio::spawn(async move {
        while let Some(frame) = out_rx.recv().await {
            if let Ok(line) = serde_json::to_string(&frame) {
                use std::io::Write;
                let mut stdout = std::io::stdout().lock();
                let _ = stdout.write_all(line.as_bytes());
                let _ = stdout.write_all(b"\n");
                let _ = stdout.flush();
            }
        }
    });

    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut running = true;

    let mut pty_auto = PtyAutoState::new();

    // --- SIGWINCH (terminal resize) ---
    let mut sigwinch =
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::window_change())
            .expect("failed to register SIGWINCH handler");

    let mut auto_enter_interval = tokio::time::interval(Duration::from_secs(2));
    auto_enter_interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut pending_injection_interval = tokio::time::interval(Duration::from_millis(50));
    pending_injection_interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut pending_worker_injections: VecDeque<PendingWorkerInjection> = VecDeque::new();
    let mut pending_worker_delivery_ids: HashSet<String> = HashSet::new();

    while running {
        tokio::select! {
            line = lines.next_line() => {
                match line {
                    Ok(Some(line)) => {
                        let frame: ProtocolEnvelope<Value> = match serde_json::from_str(&line) {
                            Ok(frame) => frame,
                            Err(error) => {
                                let _ = send_frame(&out_tx, "worker_error", None, json!({
                                    "code":"invalid_frame",
                                    "message": error.to_string(),
                                    "retryable": false
                                })).await;
                                continue;
                            }
                        };

                        match frame.msg_type.as_str() {
                            "init_worker" => {
                                let inferred_name = cmd
                                    .agent_name
                                    .clone()
                                    .or_else(|| {
                                        frame.payload
                                            .get("agent")
                                            .and_then(|a| a.get("name"))
                                            .and_then(Value::as_str)
                                            .map(ToOwned::to_owned)
                                    })
                                    .unwrap_or_else(|| "pty-worker".to_string());

                                let _ = send_frame(
                                    &out_tx,
                                    "worker_ready",
                                    frame.request_id,
                                    json!({"name": inferred_name, "runtime": "pty"}),
                                )
                                .await;
                            }
                            "deliver_relay" => {
                                let delivery: RelayDelivery = match serde_json::from_value(frame.payload) {
                                    Ok(d) => d,
                                    Err(error) => {
                                        let _ = send_frame(&out_tx, "worker_error", frame.request_id, json!({
                                            "code":"invalid_delivery",
                                            "message": error.to_string(),
                                            "retryable": false
                                        })).await;
                                        continue;
                                    }
                                };
                                if pending_worker_delivery_ids.insert(delivery.delivery_id.clone()) {
                                    pending_worker_injections.push_back(PendingWorkerInjection {
                                        delivery,
                                        request_id: frame.request_id,
                                        queued_at: Instant::now(),
                                    });
                                } else {
                                    tracing::debug!(
                                        delivery_id = %delivery.delivery_id,
                                        "skipping duplicate pending delivery"
                                    );
                                }
                            }
                            "shutdown_worker" => {
                                running = false;
                            }
                            "ping" => {
                                let ts = frame.payload.get("ts_ms").and_then(Value::as_u64).unwrap_or_default();
                                let _ = send_frame(&out_tx, "pong", frame.request_id, json!({"ts_ms": ts})).await;
                            }
                            other => {
                                let _ = send_frame(&out_tx, "worker_error", frame.request_id, json!({
                                    "code":"unknown_type",
                                    "message": format!("unsupported message type '{}'", other),
                                    "retryable": false
                                })).await;
                            }
                        }
                    }
                    Ok(None) => break,
                    Err(_) => break,
                }
            }

            pty_output = pty_rx.recv() => {
                match pty_output {
                    Some(chunk) => {
                        for response in terminal_query_parser.feed(&chunk) {
                            let _ = pty.write_all(response);
                        }
                        let text = String::from_utf8_lossy(&chunk).to_string();
                        let _ = send_frame(&out_tx, "worker_stream", None, json!({
                            "stream": "stdout",
                            "chunk": text,
                        })).await;

                        pty_auto.update_auto_suggestion(&text);
                        pty_auto.last_output_time = Instant::now();
                        pty_auto.update_editor_buffer(&text);
                        pty_auto.reset_auto_enter_on_output(&text);
                        pty_auto.handle_mcp_approval(&text, &pty).await;
                        pty_auto.handle_bypass_permissions(&text, &pty).await;
                        pty_auto.handle_codex_model_prompt(&text, &pty).await;
                        pty_auto.handle_gemini_action(&text, &pty).await;
                    }
                    None => {
                        running = false;
                    }
                }
            }

            _ = pending_injection_interval.tick() => {
                let should_block = pending_worker_injections
                    .front()
                    .map(|pending| {
                        pty_auto.auto_suggestion_visible && pending.queued_at.elapsed() < AUTO_SUGGESTION_BLOCK_TIMEOUT
                    })
                    .unwrap_or(false);
                if should_block {
                    continue;
                }
                if let Some(pending) = pending_worker_injections.pop_front() {
                    if pty_auto.auto_suggestion_visible {
                        tracing::warn!(
                            delivery_id = %pending.delivery.delivery_id,
                            "auto-suggestion visible; sending Escape to dismiss before injection"
                        );
                        let _ = pty.write_all(b"\x1b");
                        tokio::time::sleep(Duration::from_millis(100)).await;
                        pty_auto.auto_suggestion_visible = false;
                    }

                    let injection = format_injection(
                        &pending.delivery.from,
                        &pending.delivery.event_id,
                        &pending.delivery.body,
                        &pending.delivery.target,
                    );
                    if let Err(e) = pty.write_all(injection.as_bytes()) {
                        tracing::warn!(
                            delivery_id = %pending.delivery.delivery_id,
                            error = %e,
                            "PTY injection write failed, re-queuing delivery"
                        );
                        pending_worker_injections.push_front(pending);
                        continue;
                    }
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    let _ = pty.write_all(b"\r");
                    pty_auto.last_injection_time = Some(Instant::now());
                    pty_auto.auto_enter_retry_count = 0;

                    let _ = send_frame(
                        &out_tx,
                        "delivery_ack",
                        pending.request_id,
                        json!({
                            "delivery_id": pending.delivery.delivery_id,
                            "event_id": pending.delivery.event_id
                        }),
                    )
                    .await;
                    pending_worker_delivery_ids.remove(&pending.delivery.delivery_id);
                }
            }

            // --- Auto-enter for stuck agents ---
            _ = auto_enter_interval.tick() => {
                pty_auto.try_auto_enter(&pty);
            }

            // --- SIGWINCH: forward terminal resize to PTY ---
            _ = sigwinch.recv() => {
                if let Some((rows, cols)) = get_terminal_size() {
                    let _ = pty.resize(rows, cols);
                }
            }
        }
    }

    let _ = pty.shutdown();
    let _ = send_frame(
        &out_tx,
        "worker_exited",
        None,
        json!({"code": Value::Null, "signal": Value::Null}),
    )
    .await;

    Ok(())
}
