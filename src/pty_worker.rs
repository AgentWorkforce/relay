use super::*;
use crate::helpers::{
    check_echo_in_output, current_timestamp_ms, delivery_injected_event_payload,
    delivery_queued_event_payload, detect_cli_ready, floor_char_boundary,
    format_injection_for_worker, parse_cli_command, parse_continuity_command, ActivityDetector,
    DeliveryOutcome, PendingActivity, PendingVerification, ThrottleState,
    ACTIVITY_BUFFER_KEEP_BYTES, ACTIVITY_BUFFER_MAX_BYTES, ACTIVITY_WINDOW, VERIFICATION_WINDOW,
};
use crate::wrap::{PtyAutoState, AUTO_SUGGESTION_BLOCK_TIMEOUT};

#[derive(Debug, Clone)]
struct PendingWorkerInjection {
    delivery: RelayDelivery,
    request_id: Option<String>,
    queued_at: Instant,
}

fn cli_basename(command: &str) -> &str {
    command
        .rsplit(['/', '\\'])
        .next()
        .filter(|part| !part.is_empty())
        .unwrap_or(command)
}

const STARTUP_READY_TIMEOUT: Duration = Duration::from_secs(25);
const STARTUP_BUFFER_MAX: usize = 12_000;
const STARTUP_BUFFER_KEEP: usize = 8_000;
const PROMPT_WINDOW_BYTES: usize = 800;
const RELAYCAST_BOOT_MARKER: &str = "booting mcp server: relaycast";

fn append_bounded(buf: &mut String, text: &str, max: usize, keep: usize) {
    buf.push_str(text);
    if buf.len() > max {
        let start = floor_char_boundary(buf, buf.len() - keep);
        *buf = buf[start..].to_string();
    }
}

fn codex_relaycast_boot_expected(cli: &str, args: &[String]) -> bool {
    cli_basename(cli).eq_ignore_ascii_case("codex")
        && args
            .iter()
            .any(|arg| arg.to_ascii_lowercase().contains("mcp_servers.relaycast"))
}

fn output_has_prompt(cli: &str, output: &str) -> bool {
    let lower_cli = cli.to_ascii_lowercase();
    let clean = strip_ansi(output);
    if clean.is_empty() {
        return false;
    }

    let region = if clean.len() > PROMPT_WINDOW_BYTES {
        let start = floor_char_boundary(&clean, clean.len() - PROMPT_WINDOW_BYTES);
        &clean[start..]
    } else {
        &clean
    };

    let mut patterns = vec!["> ", "$ ", ">>> ", "›"];
    if lower_cli.contains("codex") {
        patterns.push("codex> ");
    }
    if patterns.iter().any(|pattern| region.contains(pattern)) {
        return true;
    }

    region.lines().rev().take(6).any(|line| {
        let trimmed = line.trim();
        matches!(trimmed, "›" | ">" | "$" | ">>>")
            || (lower_cli.contains("codex") && trimmed.eq_ignore_ascii_case("codex>"))
    })
}

fn startup_gate_ready(
    resolved_cli: &str,
    startup_output: &str,
    startup_total_bytes: usize,
    wait_for_relaycast_boot: bool,
    saw_relaycast_boot: bool,
    post_boot_output: &str,
) -> bool {
    if wait_for_relaycast_boot {
        saw_relaycast_boot && output_has_prompt(resolved_cli, post_boot_output)
    } else {
        detect_cli_ready(resolved_cli, startup_output, startup_total_bytes)
    }
}

async fn try_emit_worker_ready(
    out_tx: &mpsc::Sender<ProtocolEnvelope<Value>>,
    worker_name: &str,
    init_request_id: &mut Option<String>,
    init_received_at: Option<Instant>,
    worker_ready_sent: &mut bool,
    startup_ready: bool,
) {
    if *worker_ready_sent || init_request_id.is_none() {
        return;
    }

    let timed_out = init_received_at
        .map(|started| started.elapsed() >= STARTUP_READY_TIMEOUT)
        .unwrap_or(false);
    if !startup_ready && !timed_out {
        return;
    }

    if timed_out && !startup_ready {
        tracing::warn!(
            target = "agent_relay::worker::pty",
            worker = %worker_name,
            timeout_secs = STARTUP_READY_TIMEOUT.as_secs(),
            "startup readiness timed out; emitting worker_ready fallback"
        );
    }

    let request_id = init_request_id.take();
    let _ = send_frame(
        out_tx,
        "worker_ready",
        request_id,
        json!({"name": worker_name, "runtime": "pty"}),
    )
    .await;
    *worker_ready_sent = true;
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
    let worker_pre_registered = std::env::var("RELAY_AGENT_TOKEN")
        .ok()
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false);
    let assigned_worker_name = std::env::var("RELAY_AGENT_NAME")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    const MCP_REMINDER_COOLDOWN: Duration = Duration::from_secs(300);
    let mut last_mcp_reminder_at: Option<Instant> = None;
    let mut pending_worker_injections: VecDeque<PendingWorkerInjection> = VecDeque::new();
    let mut pending_worker_delivery_ids: HashSet<String> = HashSet::new();
    let wait_for_relaycast_boot = codex_relaycast_boot_expected(&resolved_cli, &effective_args);
    let mut startup_output = String::new();
    let mut startup_total_bytes = 0usize;
    let mut saw_relaycast_boot = false;
    let mut post_boot_output = String::new();
    let mut init_request_id: Option<String> = None;
    let mut init_received_at: Option<Instant> = None;
    let mut worker_ready_sent = false;
    let suppress_multiline_mcp_reminder = cli_basename(&resolved_cli).eq_ignore_ascii_case("agent")
        || cli_basename(&resolved_cli).eq_ignore_ascii_case("cursor-agent")
        || cmd.cli.to_ascii_lowercase().contains("cursor");
    let verification_window = if cli_basename(&resolved_cli).eq_ignore_ascii_case("droid") {
        Duration::from_secs(3)
    } else {
        VERIFICATION_WINDOW
    };

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
    // Buffer for detecting KIND: continuity commands in PTY output.
    // Bounded to avoid unbounded memory growth; continuity blocks are small.
    let mut continuity_buffer = String::new();
    const CONTINUITY_BUFFER_MAX: usize = 4096;
    let mut verification_tick = tokio::time::interval(Duration::from_millis(200));
    verification_tick.set_missed_tick_behavior(MissedTickBehavior::Skip);

    // Watchdog: periodically check if child process is still alive.
    // The PTY reader may not detect EOF on macOS when the child exits during
    // extended thinking (no output). This ensures we don't hang forever.
    let mut child_watchdog = tokio::time::interval(Duration::from_secs(5));
    child_watchdog.set_missed_tick_behavior(MissedTickBehavior::Skip);

    // No-output timeout: if we receive zero PTY output for this duration AND
    // has_exited() still returns false, force exit. This is the ultimate
    // safety net for macOS where both EOF detection and has_exited() can fail.
    const NO_OUTPUT_EXIT_TIMEOUT: Duration = Duration::from_secs(120);
    let mut last_pty_output_time = Instant::now();
    let mut reported_idle = false;

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
                                worker_name = cmd
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
                                init_request_id = frame.request_id;
                                init_received_at = Some(Instant::now());
                                let startup_ready = startup_gate_ready(
                                    &resolved_cli,
                                    &startup_output,
                                    startup_total_bytes,
                                    wait_for_relaycast_boot,
                                    saw_relaycast_boot,
                                    &post_boot_output,
                                );
                                try_emit_worker_ready(
                                    &out_tx,
                                    &worker_name,
                                    &mut init_request_id,
                                    init_received_at,
                                    &mut worker_ready_sent,
                                    startup_ready,
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
                        last_pty_output_time = Instant::now();
                        reported_idle = false;
                        // Child is provably alive — reset the no-PID exit counter.
                        pty.reset_no_pid_checks();
                        for response in terminal_query_parser.feed(&chunk) {
                            let _ = pty.write_all(response);
                        }
                        let text = String::from_utf8_lossy(&chunk).to_string();
                        let clean_text = strip_ansi(&text);
                        startup_total_bytes = startup_total_bytes.saturating_add(chunk.len());
                        append_bounded(
                            &mut startup_output,
                            &clean_text,
                            STARTUP_BUFFER_MAX,
                            STARTUP_BUFFER_KEEP,
                        );
                        if wait_for_relaycast_boot {
                            if saw_relaycast_boot {
                                append_bounded(
                                    &mut post_boot_output,
                                    &clean_text,
                                    STARTUP_BUFFER_MAX,
                                    STARTUP_BUFFER_KEEP,
                                );
                            } else {
                                let lower = clean_text.to_ascii_lowercase();
                                if let Some(marker_idx) = lower.find(RELAYCAST_BOOT_MARKER) {
                                    saw_relaycast_boot = true;
                                    let marker_end = marker_idx + RELAYCAST_BOOT_MARKER.len();
                                    let marker_end = floor_char_boundary(&clean_text, marker_end);
                                    append_bounded(
                                        &mut post_boot_output,
                                        &clean_text[marker_end..],
                                        STARTUP_BUFFER_MAX,
                                        STARTUP_BUFFER_KEEP,
                                    );
                                }
                            }
                        }
                        let startup_ready = startup_gate_ready(
                            &resolved_cli,
                            &startup_output,
                            startup_total_bytes,
                            wait_for_relaycast_boot,
                            saw_relaycast_boot,
                            &post_boot_output,
                        );
                        try_emit_worker_ready(
                            &out_tx,
                            &worker_name,
                            &mut init_request_id,
                            init_received_at,
                            &mut worker_ready_sent,
                            startup_ready,
                        )
                        .await;

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

                        // Detect KIND: continuity commands in PTY output.
                        // Only scan when no echo verifications are pending to avoid false-positives
                        // from injected relay messages that might contain header-like text.
                        if pending_verifications.is_empty() {
                            continuity_buffer.push_str(&clean_text);
                            if continuity_buffer.len() > CONTINUITY_BUFFER_MAX {
                                let start = floor_char_boundary(
                                    &continuity_buffer,
                                    continuity_buffer.len() - CONTINUITY_BUFFER_MAX / 2,
                                );
                                continuity_buffer = continuity_buffer[start..].to_string();
                            }
                            if let Some((action, content, consumed)) =
                                parse_continuity_command(&continuity_buffer)
                            {
                                tracing::info!(
                                    target = "agent_relay::worker::pty",
                                    action = %action.as_str(),
                                    content_len = content.len(),
                                    "detected KIND: continuity command in PTY output"
                                );
                                let _ = send_frame(
                                    &out_tx,
                                    "continuity_command",
                                    None,
                                    json!({
                                        "action": action.as_str(),
                                        "content": content,
                                    }),
                                )
                                .await;
                                // Advance buffer past consumed bytes
                                if consumed >= continuity_buffer.len() {
                                    continuity_buffer.clear();
                                } else {
                                    let safe_consumed = floor_char_boundary(
                                        &continuity_buffer,
                                        consumed,
                                    );
                                    continuity_buffer = continuity_buffer[safe_consumed..].to_string();
                                }
                            }
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
                        // PTY reader closed — child likely exited. Emit
                        // agent_exit with any echo_buffer tail so the
                        // dashboard can surface the CLI's last output.
                        let clean = strip_ansi(&echo_buffer);
                        let trimmed = if clean.len() > 2000 {
                            &clean[clean.len() - 2000..]
                        } else {
                            &clean
                        };
                        if !trimmed.is_empty() {
                            tracing::info!(
                                target = "agent_relay::worker::pty",
                                output_len = trimmed.len(),
                                "PTY channel closed; captured output available"
                            );
                        }
                        let mut exit_payload = json!({
                            "reason": "pty_closed",
                        });
                        if !trimmed.is_empty() {
                            exit_payload["last_output"] = json!(trimmed);
                        }
                        let _ = send_frame(&out_tx, "agent_exit", None, exit_payload).await;
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

                    let include_mcp_reminder = if suppress_multiline_mcp_reminder {
                        false
                    } else {
                        last_mcp_reminder_at
                            .map(|timestamp| timestamp.elapsed() >= MCP_REMINDER_COOLDOWN)
                            .unwrap_or(true)
                    };
                    let injection = format_injection_for_worker(
                        &pending.delivery.from,
                        &pending.delivery.event_id,
                        &pending.delivery.body,
                        &pending.delivery.target,
                        include_mcp_reminder,
                        worker_pre_registered,
                        assigned_worker_name.as_deref(),
                    );
                    if include_mcp_reminder {
                        last_mcp_reminder_at = Some(Instant::now());
                    }
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
                        max_attempts: 1,
                        request_id: pending.request_id,
                        from: pending.delivery.from,
                        body: pending.delivery.body,
                        target: pending.delivery.target,
                    });
                }
            }

            // --- Verification tick: check for timed-out verifications ---
            _ = verification_tick.tick() => {
                let startup_ready = startup_gate_ready(
                    &resolved_cli,
                    &startup_output,
                    startup_total_bytes,
                    wait_for_relaycast_boot,
                    saw_relaycast_boot,
                    &post_boot_output,
                );
                try_emit_worker_ready(
                    &out_tx,
                    &worker_name,
                    &mut init_request_id,
                    init_received_at,
                    &mut worker_ready_sent,
                    startup_ready,
                )
                .await;

                let mut i = 0;
                while i < pending_verifications.len() {
                    if pending_verifications[i].injected_at.elapsed() >= verification_window {
                        let pv = pending_verifications.remove(i).unwrap();
                        let delivery_id = pv.delivery_id.clone();
                        let event_id = pv.event_id.clone();
                        // Do not re-inject on verification timeout. Re-injection can duplicate
                        // already-delivered messages when terminal echo parsing is noisy.
                        tracing::debug!(
                            delivery_id = %delivery_id,
                            attempts = pv.attempts,
                            "delivery echo not detected within verification window; acknowledging via timeout fallback"
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
                            pv.request_id.clone(),
                            json!({
                                "delivery_id": delivery_id,
                                "event_id": event_id,
                                "verification": "timeout_fallback",
                                "reason": format!("echo not detected within {}s window", verification_window.as_secs())
                            }),
                        )
                        .await;
                        throttle.record(DeliveryOutcome::Success);
                        pending_worker_delivery_ids.remove(&delivery_id);
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
                    // Drain any remaining PTY output so we can capture error
                    // messages from CLIs that exit immediately (e.g. codex MCP
                    // failure). Without this, the output is lost in the race
                    // between the reader thread and the watchdog.
                    let mut late_output = String::new();
                    while let Ok(chunk) = pty_rx.try_recv() {
                        let text = String::from_utf8_lossy(&chunk).to_string();
                        late_output.push_str(&text);
                        let _ = send_frame(&out_tx, "worker_stream", None, json!({
                            "stream": "stdout",
                            "chunk": text,
                        })).await;
                    }
                    if !late_output.is_empty() {
                        let clean = strip_ansi(&late_output);
                        tracing::warn!(
                            target = "agent_relay::worker::pty",
                            output = %clean,
                            "watchdog: captured late output from exiting child"
                        );
                    }
                    tracing::info!(
                        target = "agent_relay::worker::pty",
                        "watchdog: child process exited"
                    );
                    let mut exit_payload = json!({
                        "reason": "child_exited",
                    });
                    if !late_output.is_empty() {
                        let clean = strip_ansi(&late_output);
                        // Truncate to avoid huge payloads; last 2000 chars
                        // are most likely to contain the error message.
                        let trimmed = if clean.len() > 2000 {
                            &clean[clean.len() - 2000..]
                        } else {
                            &clean
                        };
                        exit_payload["last_output"] = json!(trimmed);
                    }
                    let _ = send_frame(&out_tx, "agent_exit", None, exit_payload).await;
                    running = false;
                } else {
                    // If no PTY output for a long time, the agent is likely
                    // idle (thinking, waiting for input, etc). Emit an idle
                    // event instead of killing the process — the broker or
                    // dashboard can decide what to do with idle agents.
                    let silent_duration = last_pty_output_time.elapsed();
                    if silent_duration >= NO_OUTPUT_EXIT_TIMEOUT && !reported_idle {
                        tracing::info!(
                            target = "agent_relay::worker::pty",
                            silent_secs = silent_duration.as_secs(),
                            "watchdog: no PTY output for {}s — marking idle",
                            silent_duration.as_secs()
                        );
                        let _ = send_frame(&out_tx, "agent_idle", None, json!({
                            "reason": "no_output_timeout",
                            "idle_secs": silent_duration.as_secs(),
                        })).await;
                        reported_idle = true;
                    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_relaycast_boot_expected_when_configured() {
        let args = vec![
            "--config".to_string(),
            "mcp_servers.relaycast.command=npx".to_string(),
        ];
        assert!(codex_relaycast_boot_expected("codex", &args));
        assert!(!codex_relaycast_boot_expected("claude", &args));
    }

    #[test]
    fn output_has_prompt_detects_codex_glyph_prompt() {
        assert!(output_has_prompt("codex", "Boot complete\n› "));
    }

    #[test]
    fn startup_gate_blocks_codex_until_post_boot_prompt() {
        let startup_output = "Welcome\n› ";
        let post_boot_output = "MCP loading...";
        assert!(!startup_gate_ready(
            "codex",
            startup_output,
            startup_output.len(),
            true,
            false,
            post_boot_output,
        ));
        assert!(!startup_gate_ready(
            "codex",
            startup_output,
            startup_output.len(),
            true,
            true,
            post_boot_output,
        ));
        assert!(startup_gate_ready(
            "codex",
            startup_output,
            startup_output.len(),
            true,
            true,
            "done\n› ",
        ));
    }

    #[test]
    fn startup_gate_uses_generic_ready_detection_without_boot_requirement() {
        assert!(startup_gate_ready(
            "claude",
            "Ready\n> ",
            20,
            false,
            false,
            "",
        ));
    }
}
