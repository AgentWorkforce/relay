use super::*;
use crate::helpers::{
    check_echo_in_output, current_timestamp_ms, delivery_injected_event_payload,
    delivery_queued_event_payload, floor_char_boundary, parse_cli_command, ActivityDetector,
    DeliveryOutcome, PendingActivity, PendingVerification, ThrottleState,
    ACTIVITY_BUFFER_KEEP_BYTES, ACTIVITY_BUFFER_MAX_BYTES, ACTIVITY_WINDOW,
    MAX_VERIFICATION_ATTEMPTS, VERIFICATION_WINDOW,
};
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

    let (resolved_cli, inline_cli_args) = parse_cli_command(&cmd.cli)
        .with_context(|| format!("invalid CLI command '{}'", cmd.cli))?;
    let mut effective_args = inline_cli_args;
    effective_args.extend(cmd.args.clone());

    #[cfg(unix)]
    let (init_rows, init_cols) = get_terminal_size().unwrap_or((24, 80));
    #[cfg(not(unix))]
    let (init_rows, init_cols) = (24u16, 80u16);
    let (pty, mut pty_rx) =
        PtySession::spawn(&resolved_cli, &effective_args, init_rows, init_cols)?;
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

    let idle_threshold = if cmd.idle_threshold_secs == 0 {
        None
    } else {
        Some(Duration::from_secs(cmd.idle_threshold_secs))
    };

    // --- SIGWINCH (terminal resize) ---
    let mut sigwinch =
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::window_change())
            .expect("failed to register SIGWINCH handler");

    let mut auto_enter_interval = tokio::time::interval(Duration::from_secs(2));
    auto_enter_interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut pending_injection_interval = tokio::time::interval(Duration::from_millis(50));
    pending_injection_interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut worker_name = cmd
        .agent_name
        .clone()
        .unwrap_or_else(|| "pty-worker".to_string());
    let mut pending_worker_injections: VecDeque<PendingWorkerInjection> = VecDeque::new();
    let mut pending_worker_delivery_ids: HashSet<String> = HashSet::new();

    // Echo verification state
    let mut pending_verifications: VecDeque<PendingVerification> = VecDeque::new();
    let mut pending_activities: VecDeque<PendingActivity> = VecDeque::new();
    let activity_detector = if cmd.progress {
        Some(ActivityDetector::for_cli(&resolved_cli))
    } else {
        None
    };
    let mut throttle = ThrottleState::default();
    let mut echo_buffer = String::new();
    let mut verification_tick = tokio::time::interval(Duration::from_millis(200));
    verification_tick.set_missed_tick_behavior(MissedTickBehavior::Skip);

    // Watchdog: periodically check if child process is still alive.
    // The PTY reader may not detect EOF on macOS when the child exits during
    // extended thinking (no output). This ensures we don't hang forever.
    let mut child_watchdog = tokio::time::interval(Duration::from_secs(5));
    child_watchdog.set_missed_tick_behavior(MissedTickBehavior::Skip);

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
                                worker_name = inferred_name.clone();

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
                                    let _ = send_frame(
                                        &out_tx,
                                        "delivery_queued",
                                        None,
                                        delivery_queued_event_payload(
                                            &delivery.delivery_id,
                                            &delivery.event_id,
                                            &worker_name,
                                            current_timestamp_ms(),
                                        ),
                                    )
                                    .await;
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
                        let clean_text = strip_ansi(&text);

                        // Detect /exit command in agent output and trigger graceful shutdown.
                        // Skip detection while echo verifications are pending to avoid
                        // false-positives from injected relay messages containing "/exit".
                        if pending_verifications.is_empty()
                            && clean_text.lines().any(|line| line.trim() == "/exit")
                        {
                            tracing::info!(
                                target = "agent_relay::worker::pty",
                                "agent issued /exit — shutting down"
                            );
                            let _ = send_frame(&out_tx, "agent_exit", None, json!({
                                "reason": "agent_requested",
                            })).await;
                            running = false;
                        }

                        let _ = send_frame(&out_tx, "worker_stream", None, json!({
                            "stream": "stdout",
                            "chunk": text,
                        })).await;

                        pty_auto.update_auto_suggestion(&text);
                        pty_auto.last_output_time = Instant::now();
                        pty_auto.reset_idle_on_output();
                        pty_auto.update_editor_buffer(&text);
                        pty_auto.reset_auto_enter_on_output(&text);
                        pty_auto.handle_mcp_approval(&text, &pty).await;
                        pty_auto.handle_bypass_permissions(&text, &pty).await;
                        pty_auto.handle_codex_model_prompt(&text, &pty).await;
                        pty_auto.handle_gemini_action(&text, &pty).await;

                        // Accumulate echo buffer for verification matching
                        echo_buffer.push_str(&text);
                        if echo_buffer.len() > 16_000 {
                            let start = floor_char_boundary(&echo_buffer, echo_buffer.len() - 12_000);
                            echo_buffer = echo_buffer[start..].to_string();
                        }

                        // Check pending verifications against new output
                        let mut verified_indices = Vec::new();
                        for (i, pv) in pending_verifications.iter().enumerate() {
                            if check_echo_in_output(&echo_buffer, &pv.expected_echo) {
                                verified_indices.push(i);
                            }
                        }
                        // Remove verified entries in reverse order to preserve indices
                        for &i in verified_indices.iter().rev() {
                            let pv = pending_verifications.remove(i).unwrap();
                            let delivery_id = pv.delivery_id.clone();
                            let event_id = pv.event_id.clone();
                            tracing::debug!(
                                delivery_id = %delivery_id,
                                attempts = pv.attempts,
                                "delivery echo verified"
                            );
                            let _ = send_frame(
                                &out_tx,
                                "delivery_ack",
                                pv.request_id.clone(),
                                json!({
                                    "delivery_id": delivery_id,
                                    "event_id": event_id
                                }),
                            )
                            .await;
                            let _ = send_frame(
                                &out_tx,
                                "delivery_verified",
                                None,
                                json!({
                                    "delivery_id": delivery_id,
                                    "event_id": event_id
                                }),
                            )
                            .await;
                            throttle.record(DeliveryOutcome::Success);
                            if let Some(detector) = activity_detector.as_ref() {
                                pending_activities.push_back(PendingActivity {
                                    delivery_id: delivery_id.clone(),
                                    event_id,
                                    expected_echo: pv.expected_echo,
                                    verified_at: Instant::now(),
                                    output_buffer: String::new(),
                                    detector: detector.clone(),
                                });
                            }
                            pending_worker_delivery_ids.remove(&delivery_id);
                        }

                        if activity_detector.as_ref().is_some() {
                            let mut active_indices = Vec::new();
                            for (i, pa) in pending_activities.iter_mut().enumerate() {
                                if pa.verified_at.elapsed() >= ACTIVITY_WINDOW {
                                    active_indices.push((i, None));
                                    continue;
                                }
                                pa.output_buffer.push_str(&clean_text);
                                if pa.output_buffer.len() > ACTIVITY_BUFFER_MAX_BYTES {
                                    let start = floor_char_boundary(
                                        &pa.output_buffer,
                                        pa.output_buffer.len() - ACTIVITY_BUFFER_KEEP_BYTES,
                                    );
                                    pa.output_buffer = pa.output_buffer[start..].to_string();
                                }

                                if let Some(pattern) =
                                    pa.detector.detect_activity(&pa.output_buffer, &pa.expected_echo)
                                {
                                    active_indices.push((i, Some(pattern)));
                                }
                            }

                            for (i, matched) in active_indices.into_iter().rev() {
                                let pa = pending_activities.remove(i).unwrap();
                                if let Some(pattern) = matched {
                                    tracing::debug!(
                                        target = "agent_relay::worker::pty",
                                        delivery_id = %pa.delivery_id,
                                        event_id = %pa.event_id,
                                        pattern = %pattern,
                                        "delivery activity detected"
                                    );
                                    let _ = send_frame(
                                        &out_tx,
                                        "delivery_active",
                                        None,
                                        json!({
                                            "delivery_id": pa.delivery_id,
                                            "event_id": pa.event_id,
                                            "pattern": pattern,
                                        }),
                                    )
                                    .await;
                                } else {
                                    tracing::debug!(
                                        target = "agent_relay::worker::pty",
                                        delivery_id = %pa.delivery_id,
                                        event_id = %pa.event_id,
                                        "delivery activity window expired"
                                    );
                                }
                            }
                        }
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
                    tokio::time::sleep(throttle.delay()).await;
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
                    let _ = send_frame(
                        &out_tx,
                        "delivery_injected",
                        None,
                        delivery_injected_event_payload(
                            &pending.delivery.delivery_id,
                            &pending.delivery.event_id,
                            &worker_name,
                            current_timestamp_ms(),
                        ),
                    )
                    .await;
                    pty_auto.last_injection_time = Some(Instant::now());
                    pty_auto.auto_enter_retry_count = 0;

                    // Push to pending verifications instead of immediate ack
                    pending_verifications.push_back(PendingVerification {
                        delivery_id: pending.delivery.delivery_id.clone(),
                        event_id: pending.delivery.event_id.clone(),
                        expected_echo: injection,
                        injected_at: Instant::now(),
                        attempts: 1,
                        max_attempts: MAX_VERIFICATION_ATTEMPTS,
                        request_id: pending.request_id,
                        from: pending.delivery.from,
                        body: pending.delivery.body,
                        target: pending.delivery.target,
                    });
                }
            }

            // --- Verification tick: check for timed-out verifications ---
            _ = verification_tick.tick() => {
                let mut retry_queue: Vec<PendingVerification> = Vec::new();
                let mut i = 0;
                while i < pending_verifications.len() {
                    if pending_verifications[i].injected_at.elapsed() >= VERIFICATION_WINDOW {
                        let mut pv = pending_verifications.remove(i).unwrap();
                        if pv.attempts < pv.max_attempts {
                            // Retry injection
                            pv.attempts += 1;
                            tracing::warn!(
                                delivery_id = %pv.delivery_id,
                                attempt = pv.attempts,
                                max = pv.max_attempts,
                                "echo verification timeout, retrying injection"
                            );
                            retry_queue.push(pv);
                        } else {
                            // Echo matching can be flaky across CLIs/TTY renderers.
                            // If injection was attempted multiple times and only echo
                            // verification failed, mark as verified via timeout fallback
                            // instead of hard-failing the delivery.
                            tracing::warn!(
                                delivery_id = %pv.delivery_id,
                                attempts = pv.attempts,
                                "delivery echo not detected after max retries; marking verified via timeout fallback"
                            );
                            let _ = send_frame(
                                &out_tx,
                                "delivery_verified",
                                pv.request_id.clone(),
                                json!({
                                    "delivery_id": pv.delivery_id,
                                    "event_id": pv.event_id,
                                    "verification": "timeout_fallback",
                                    "reason": format!("echo not detected after {} attempts within {}s window", pv.max_attempts, VERIFICATION_WINDOW.as_secs())
                                }),
                            )
                            .await;
                            throttle.record(DeliveryOutcome::Success);
                            pending_worker_delivery_ids.remove(&pv.delivery_id);
                        }
                    } else {
                        i += 1;
                    }
                }

                if activity_detector.is_some() {
                    let mut i = 0;
                    while i < pending_activities.len() {
                        if pending_activities[i].verified_at.elapsed() >= ACTIVITY_WINDOW {
                            let _ = pending_activities.remove(i).unwrap();
                        } else {
                            i += 1;
                        }
                    }
                }

                // Re-inject retries
                for mut pv in retry_queue {
                    tokio::time::sleep(throttle.delay()).await;
                    let injection = format_injection(&pv.from, &pv.event_id, &pv.body, &pv.target);
                    if let Err(e) = pty.write_all(injection.as_bytes()) {
                        tracing::warn!(
                            delivery_id = %pv.delivery_id,
                            error = %e,
                            "retry PTY injection write failed"
                        );
                    } else {
                        tokio::time::sleep(Duration::from_millis(50)).await;
                        let _ = pty.write_all(b"\r");
                        let _ = send_frame(
                            &out_tx,
                            "delivery_injected",
                            None,
                            delivery_injected_event_payload(
                                &pv.delivery_id,
                                &pv.event_id,
                                &worker_name,
                                current_timestamp_ms(),
                            ),
                        )
                        .await;
                    }
                    pv.expected_echo = injection;
                    pv.injected_at = Instant::now();
                    pending_verifications.push_back(pv);
                }
            }

            // --- Auto-enter for stuck agents ---
            _ = auto_enter_interval.tick() => {
                pty_auto.try_auto_enter(&pty);

                // Idle detection: emit agent_idle once when silence exceeds threshold.
                // Granularity depends on auto_enter_interval tick rate (2s).
                if let Some(threshold) = idle_threshold {
                    if let Some(idle_secs) = pty_auto.check_idle_transition(threshold) {
                        let _ = send_frame(&out_tx, "agent_idle", None, json!({
                            "idle_secs": idle_secs,
                        })).await;
                    }
                }
            }

            // --- SIGWINCH: forward terminal resize to PTY ---
            _ = sigwinch.recv() => {
                if let Some((rows, cols)) = get_terminal_size() {
                    let _ = pty.resize(rows, cols);
                }
            }

            // --- Child process watchdog ---
            // Detects when the child exits but the PTY reader doesn't notice.
            // Uses has_exited() which handles ECHILD (already reaped) and
            // falls back to kill(pid, 0) on Unix.
            _ = child_watchdog.tick() => {
                if pty.has_exited() {
                    tracing::info!(
                        target = "agent_relay::worker::pty",
                        "watchdog: child process exited"
                    );
                    let _ = send_frame(&out_tx, "agent_exit", None, json!({
                        "reason": "child_exited",
                    })).await;
                    running = false;
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
