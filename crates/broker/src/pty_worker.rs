use std::{
    collections::{HashSet, VecDeque},
    future::Future,
    pin::Pin,
    sync::OnceLock,
    time::{Duration, Instant},
};

use futures_util::{stream::FuturesUnordered, StreamExt};

use crate::{
    ids::{DeliveryId, RequestId},
    protocol::{MessageInjectionMode, ProtocolEnvelope, RelayDelivery},
    pty::{PtySession, PtyWriteSubmitError},
};
use anyhow::{Context, Result};
use serde_json::{json, Value};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    sync::mpsc,
    time::MissedTickBehavior,
};

use crate::broker::{
    continuity::parse_continuity_command,
    delivery_verification::{
        current_timestamp_ms, delivery_injected_event_payload, delivery_queued_event_payload,
        pending_verification_echo_seen, queue_or_take_confirmed_verification,
        queue_or_take_detected_activity, DeliveryOutcome, PendingActivity, PendingVerification,
        ThrottleState, VerificationOutput, ACTIVITY_BUFFER_KEEP_BYTES, ACTIVITY_BUFFER_MAX_BYTES,
        ACTIVITY_WINDOW, VERIFICATION_WINDOW,
    },
    injection_format::{format_injection_for_worker_with_workspace, McpReminderThrottle},
};
use crate::cli::command_parse::parse_cli_command;
use crate::cli::PtyCommand;
use crate::readiness::{cli_prompt_ready, detect_cli_ready, GridReadinessSnapshot};
use crate::runtime::{get_terminal_size, send_frame};
use crate::snapshot::Snapshot;
use crate::util::ansi::{floor_char_boundary, strip_ansi, AnsiStripper};
use crate::util::terminal::detect_codex_trust_prompt;
use crate::util::utf8_stream::Utf8StreamDecoder;
use crate::worker::detection::ActivityDetector;
use crate::wrap::{
    injection_submit_followup_delay, warn_on_auto_response_write, PtyAutoState,
    AUTO_SUGGESTION_BLOCK_TIMEOUT,
};
use base64::Engine;

#[derive(Debug, Clone)]
struct PendingWorkerInjection {
    delivery: RelayDelivery,
    request_id: Option<RequestId>,
    queued_at: Instant,
}

/// Default per-atom gap for escape-aware paced injection, in milliseconds.
/// Overridable at runtime via `RELAY_INJECT_RATE_MS`; `0` disables pacing and
/// restores the single bulk write. Kept small because a full injection
/// (envelope plus an optional MCP reminder) can span a few hundred atoms and
/// the gap multiplies across every one.
const DEFAULT_INJECT_RATE_MS: u64 = 5;

/// Codex redraws its full-screen input UI for each received character. Paced
/// writes therefore amplify into minutes-long initial task delivery, while its
/// bulk-input path accepts the same reminder and task immediately.
fn default_inject_rate_ms(cli: &str) -> u64 {
    let cli = cli_basename(cli);
    if cli.eq_ignore_ascii_case("codex") || cli.eq_ignore_ascii_case("codex.exe") {
        0
    } else {
        DEFAULT_INJECT_RATE_MS
    }
}

/// Resolve the injection pacing gap from an optional override. Keeping this
/// pure avoids process-environment races in tests.
fn resolve_inject_rate(cli: &str, override_value: Option<&str>) -> Duration {
    let ms = override_value
        .and_then(|value| value.trim().parse::<u64>().ok())
        .unwrap_or_else(|| default_inject_rate_ms(cli));
    Duration::from_millis(ms)
}

/// Resolve the injection pacing gap from `RELAY_INJECT_RATE_MS`, falling back
/// to the CLI-specific default. Explicit values still override every CLI.
fn inject_rate_from_env(cli: &str) -> Duration {
    let override_value = std::env::var("RELAY_INJECT_RATE_MS").ok();
    resolve_inject_rate(cli, override_value.as_deref())
}

/// Stage of an in-flight injection's paced write sequence. Each stage is
/// separated from the next by a short TUI-pacing delay. Rather than blocking
/// the worker select loop with `sleep().await` between stages (which stalled
/// PTY output forwarding and input handling), the loop tracks the next
/// deadline in [`ActiveInjection::next_at`] and advances the machine from a
/// dedicated timer arm — staying responsive to output and keystrokes while
/// the delay elapses.
#[derive(Debug, Clone, Copy)]
enum InjectionStage {
    /// Pre-injection escape: steer `ESC ESC`, auto-suggestion dismiss `ESC`,
    /// or nothing when no escape is required.
    Escape,
    /// Escape delay elapsed; submit the formatted injection body and its
    /// harness-specific submit sequence next.
    Body,
    /// Body+submit command queued; awaiting the drainer ack before finalizing
    /// (emit `delivery_injected`, queue echo verification). Finalization runs
    /// in the injection-ack arm, not the deadline arm.
    Finalize,
}

/// A single injection being written across paced stages. Holds the delivery
/// plus the formatted injection text (retained from the Body stage so it can
/// be used as the expected echo when the submit command is confirmed).
#[derive(Debug)]
struct ActiveInjection {
    pending: PendingWorkerInjection,
    stage: InjectionStage,
    next_at: tokio::time::Instant,
    injection_text: Option<String>,
    /// Receive-time PTY-output sequence captured atomically with submitting
    /// Body+Enter. Verification must ignore any identical earlier chunk,
    /// including one still queued for this event loop.
    output_boundary: Option<u64>,
    /// Popped under a `flush_injections` exemption (or marked by the flush
    /// frame while already in flight): the deadline arm may advance this
    /// injection even while the interactive hold is active. A human asked
    /// for the backlog explicitly, so writing it is not a splice.
    hold_exempt: bool,
    /// The exemption above came from an `event_id`-scoped flush rather than a
    /// blanket one, so requeueing must return it to the event-id set instead of
    /// the backlog counter — a targeted exemption stays bound to its one
    /// delivery and must never turn into an allowance the next queued relay
    /// message can spend.
    targeted_hold_exemption: bool,
}

/// Result of an in-flight `write_pty` awaiting the PTY drainer: the request id
/// to correlate the response frame, the byte length written, and the drainer's
/// ack (`Ok(Ok)` written+flushed, `Ok(Err)` I/O error, `Err` drainer exited
/// before acking).
type PtyWriteAck = (
    RequestId,
    usize,
    Result<std::io::Result<()>, tokio::sync::oneshot::error::RecvError>,
);

/// Boxed future stored in the `pending_pty_writes` [`FuturesUnordered`]. Boxed
/// because each `async move` block is a distinct anonymous type.
type PtyWriteAckFuture = Pin<Box<dyn Future<Output = PtyWriteAck> + Send>>;

fn cli_basename(command: &str) -> &str {
    command
        .rsplit(['/', '\\'])
        .next()
        .filter(|part| !part.is_empty())
        .unwrap_or(command)
}

/// Emit one diagnostic when a harness has not reached a proven input prompt in
/// this long. This is deliberately a warning threshold, not a readiness
/// fallback: declaring a booting TUI ready causes its initial task to be typed
/// into startup UI and silently consumed. Harness liveness is reported to the
/// broker independently so a live but unrecognized prompt is not reaped.
const STARTUP_READY_WARNING: Duration = Duration::from_secs(25);
/// Deliver queued startup work even when the prompt was never recognised.
///
/// Prompt detection is heuristic — it reads a vendor TUI we do not control, and
/// Claude Code's greeting banner (which `claude_grid_ready` keys on) is not
/// rendered on every launch. Making that heuristic load-bearing means a single
/// upstream cosmetic change silently strands every spawned agent: the brief is
/// held forever, nothing is injected, and the only symptom is an idle process.
///
/// Elapsed time is genuinely not proof of a ready prompt, which is why this is a
/// LAST RESORT behind the real detector and why it logs at warn. But an agent
/// that never receives its task is a total loss, while a brief typed a little
/// early is recoverable. Bounded below `WORKER_READY_DEADLINE` (90s) so the work
/// is released before an unready harness is reaped.
const STARTUP_READY_TIMEOUT: Duration = Duration::from_secs(60);
const STARTUP_BUFFER_MAX: usize = 12_000;
const STARTUP_BUFFER_KEEP: usize = 8_000;
const PROMPT_WINDOW_BYTES: usize = 800;

#[derive(Default)]
struct StartupReadinessState {
    ready_sent: bool,
    wait_warned: bool,
}

const AGENT_RELAY_BOOT_MARKER: &str = "booting mcp server: agent-relay";
const AGENT_RELAY_SERVER_NAME: &str = "agent-relay";
const LEGACY_RELAY_SERVER_NAME: &str = "relaycast";

/// Detect the Agent Relay MCP boot marker in output. Different CLIs emit
/// different boot messages:
/// - Claude: "booting mcp server: agent-relay"
/// - Codex:  "Starting MCP servers (0/2): relay, agent-relay"
///
/// Returns the byte offset of the end of the marker, or None if not found.
fn find_agent_relay_boot_marker(lower_output: &str) -> Option<usize> {
    // Claude-style marker
    if let Some(idx) = lower_output.find(AGENT_RELAY_BOOT_MARKER) {
        return Some(idx + AGENT_RELAY_BOOT_MARKER.len());
    }
    let legacy_boot_marker = format!("booting mcp server: {LEGACY_RELAY_SERVER_NAME}");
    if let Some(idx) = lower_output.find(&legacy_boot_marker) {
        return Some(idx + legacy_boot_marker.len());
    }
    // Codex-style marker: "starting mcp server" with the configured server nearby.
    if let Some(idx) = lower_output.find("starting mcp server") {
        let search_end = floor_char_boundary(lower_output, (idx + 200).min(lower_output.len()));
        let boot_line = &lower_output[idx..search_end];
        for server_name in [AGENT_RELAY_SERVER_NAME, LEGACY_RELAY_SERVER_NAME] {
            if let Some(server_idx) = boot_line.find(server_name) {
                return Some(idx + server_idx + server_name.len());
            }
        }
    }
    None
}

fn append_bounded(buf: &mut String, text: &str, max: usize, keep: usize) {
    buf.push_str(text);
    if buf.len() > max {
        let start = floor_char_boundary(buf, buf.len() - keep);
        *buf = buf[start..].to_string();
    }
}

fn codex_agent_relay_boot_expected(cli: &str, args: &[String]) -> bool {
    cli_basename(cli).eq_ignore_ascii_case("codex")
        && args.iter().any(|arg| {
            let lower = arg.to_ascii_lowercase();
            lower.contains("mcp_servers.agent-relay")
                || lower.contains(&format!("mcp_servers.{LEGACY_RELAY_SERVER_NAME}"))
        })
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

    let mut patterns = vec!["> ", "$ ", ">>> ", "›", "❯"];
    if lower_cli.contains("codex") {
        patterns.push("codex> ");
    }
    if patterns.iter().any(|pattern| region.contains(pattern)) {
        return true;
    }

    region.lines().rev().take(6).any(|line| {
        let trimmed = line.trim();
        matches!(trimmed, "›" | ">" | "$" | ">>>" | "❯")
            || (lower_cli.contains("codex") && trimmed.eq_ignore_ascii_case("codex>"))
    })
}

fn detect_context_budget_pct(output: &str) -> Option<u8> {
    static CONTEXT_RE: OnceLock<regex::Regex> = OnceLock::new();
    let re = CONTEXT_RE.get_or_init(|| {
        regex::Regex::new(r"(?i)\bcontext\s+(\d{1,3})%\s+left\b").expect("context regex compiles")
    });
    let mut latest = None;
    for captures in re.captures_iter(output) {
        latest = captures
            .get(1)
            .and_then(|m| m.as_str().parse::<u16>().ok())
            .map(|pct| pct.min(100) as u8);
    }
    latest
}

fn evaluate_startup_gate(
    resolved_cli: &str,
    startup_output: &str,
    startup_total_bytes: usize,
    wait_for_agent_relay_boot: bool,
    saw_agent_relay_boot: bool,
    post_boot_output: &str,
    grid: GridReadinessSnapshot<'_>,
) -> bool {
    // A menu-selection glyph is not the harness input prompt. In particular,
    // Codex's directory-trust interstitial contains the same `›` glyph as its
    // composer, so the generic prompt detector would otherwise release the
    // queued brief before the auto-responder's Enter takes effect. Every gate
    // path (output, init, and timer tick) passes through this exclusion.
    if detect_codex_trust_prompt(grid.screen) {
        return false;
    }

    if wait_for_agent_relay_boot {
        saw_agent_relay_boot
            && output_has_prompt(resolved_cli, post_boot_output)
            && cli_prompt_ready(resolved_cli, grid)
    } else {
        detect_cli_ready(resolved_cli, startup_output, startup_total_bytes, grid)
    }
}

/// The startup gate's verdict.
///
/// Three states, not two booleans: `Ready && Blocked` is not representable,
/// and the difference between "we could not recognise the prompt" and "the
/// harness is deliberately refusing work" decides whether the deadline may
/// release queued work at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StartupGate {
    /// A real input prompt was proven.
    Ready,
    /// No prompt recognised yet. Our heuristic may simply be blind, so the
    /// deadline is allowed to release queued work.
    Unrecognised,
    /// A known blocking dialog is on screen — the harness is deliberately not
    /// accepting input. Never released by any deadline.
    Blocked,
}

/// Whether a KNOWN blocking dialog is on screen, as opposed to a prompt we
/// simply failed to recognise.
///
/// The two must not be conflated. An unrecognised prompt means our heuristic is
/// blind and the timeout should eventually release the brief anyway. A trust
/// interstitial means the harness is deliberately not accepting work yet, and
/// typing into it would answer a security question on the operator's behalf.
/// `evaluate_startup_gate` vetoes it for exactly that reason.
fn startup_gate_blocked(pty: &PtySession) -> bool {
    detect_codex_trust_prompt(&pty.screen_text())
}

fn startup_gate_ready(
    resolved_cli: &str,
    startup_output: &str,
    startup_total_bytes: usize,
    wait_for_agent_relay_boot: bool,
    saw_agent_relay_boot: bool,
    post_boot_output: &str,
    pty: &PtySession,
) -> bool {
    let screen = pty.screen_text();
    evaluate_startup_gate(
        resolved_cli,
        startup_output,
        startup_total_bytes,
        wait_for_agent_relay_boot,
        saw_agent_relay_boot,
        post_boot_output,
        GridReadinessSnapshot {
            screen: &screen,
            cursor: Some(pty.cursor_position()),
        },
    )
}

/// Whether the loop may pop and start the next pending injection this tick.
/// Gated off when an injection is already in flight OR an interactive hold is
/// active (a human is driving). While held, deliveries stay parked in
/// `pending_worker_injections` — never dropped — and resume popping once the
/// hold is released. An outstanding `flush_injections` exemption
/// (`hold_exempt_remaining > 0`) lets pops proceed through the hold: the
/// human explicitly asked for the queued backlog to be injected now.
fn injection_pop_allowed(
    active_injection_present: bool,
    interactive_hold: bool,
    hold_exempt_remaining: usize,
) -> bool {
    !active_injection_present && (!interactive_hold || hold_exempt_remaining > 0)
}

/// Index of the pending injection the loop may start this tick, if any.
///
/// Normally that is just the front of the queue. Under an interactive hold with
/// no blanket allowance, only a delivery carrying a *targeted* exemption may go
/// — the broker released that one `event_id` explicitly (a (re)spawn's initial
/// task through a replayed hold) — so the queue is scanned for the first such
/// entry and everything ahead of it stays parked. Popping it out of order is
/// the point: a relay message retried into a restarted worker must not splice
/// into the human's session just because it happens to sit in front.
fn next_injection_index(
    pending: &VecDeque<PendingWorkerInjection>,
    active_injection_present: bool,
    interactive_hold: bool,
    hold_exempt_remaining: usize,
    hold_exempt_event_ids: &HashSet<String>,
) -> Option<usize> {
    if active_injection_present {
        return None;
    }
    if injection_pop_allowed(
        active_injection_present,
        interactive_hold,
        hold_exempt_remaining,
    ) {
        return (!pending.is_empty()).then_some(0);
    }
    pending
        .iter()
        .position(|entry| hold_exempt_event_ids.contains(entry.delivery.event_id.as_str()))
}

/// Return an interrupted injection's hold exemption so a requeued frame is
/// retried through the hold instead of freezing behind it. A targeted exemption
/// goes back to the event-id set — it must stay bound to that one delivery —
/// while a blanket `flush_injections` allowance goes back to the counter.
fn restore_hold_exemption(
    injection: &ActiveInjection,
    hold_exempt_injections: &mut usize,
    hold_exempt_event_ids: &mut HashSet<String>,
) {
    if !injection.hold_exempt {
        return;
    }
    if injection.targeted_hold_exemption {
        hold_exempt_event_ids.insert(injection.pending.delivery.event_id.to_string());
    } else {
        *hold_exempt_injections += 1;
    }
}

/// Relay command detection must stay disabled for the entire injection lifecycle.
/// The paced writer can echo command-like text before its post-write verification
/// is queued, so checking only `pending_verifications` leaves a false-positive gap.
fn injected_output_command_detection_allowed(
    active_injection_present: bool,
    pending_verifications_empty: bool,
) -> bool {
    !active_injection_present && pending_verifications_empty
}

/// What to do with an in-flight injection once its combined Body+Enter write
/// ack resolves. Keeps the ack-resolution policy pure and unit-testable,
/// separate from the frame-sending / verification side effects in the select
/// loop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InjectionAckOutcome {
    /// Ack failed, was lost, or arrived for a stage that awaits no ack:
    /// requeue the delivery at the front of the pending queue. Crucially, a
    /// failed Body+Enter ack lands here — so no `delivery_injected` is
    /// emitted and no echo verification is seeded against bytes the child
    /// never received.
    Requeue,
    /// Body+Enter write confirmed on the child: only now is the delivery
    /// genuinely injected — emit `delivery_injected` and queue echo
    /// verification.
    Finalize,
}

/// Decide the fate of an in-flight injection from the stage it is in and
/// whether the drainer confirmed the write. `stage` is the stage the machine
/// advanced to *after* submitting the write whose ack just resolved:
/// `Finalize` means the combined Body+Enter ack. A resolution in any other
/// stage (or a failed/lost ack) requeues.
fn injection_ack_outcome(stage: InjectionStage, confirmed: bool) -> InjectionAckOutcome {
    if !confirmed {
        return InjectionAckOutcome::Requeue;
    }
    match stage {
        InjectionStage::Finalize => InjectionAckOutcome::Finalize,
        InjectionStage::Escape | InjectionStage::Body => InjectionAckOutcome::Requeue,
    }
}

fn should_block_pending_injection(
    auto_suggestion_visible: bool,
    pending: &PendingWorkerInjection,
) -> bool {
    auto_suggestion_visible
        && !matches!(pending.delivery.injection_mode, MessageInjectionMode::Steer)
        && pending.queued_at.elapsed() < AUTO_SUGGESTION_BLOCK_TIMEOUT
}

#[allow(clippy::too_many_arguments)]
async fn try_emit_worker_ready(
    out_tx: &mpsc::Sender<ProtocolEnvelope<Value>>,
    worker_name: &str,
    child_pid: Option<u32>,
    init_request_id: &mut Option<RequestId>,
    init_received_at: Option<Instant>,
    readiness: &mut StartupReadinessState,
    gate: StartupGate,
) {
    // init_received_at is Some only after init_worker has been received.
    // We use it (not init_request_id) as the gate because the broker sends
    // init_worker without a request_id.
    if readiness.ready_sent || init_received_at.is_none() {
        return;
    }

    let startup_ready = gate == StartupGate::Ready;
    // A deliberate veto is not a blind spot: never time out past a known
    // blocking dialog, or the brief is typed into a trust prompt and answers a
    // security question nobody asked us to answer.
    let timed_out = gate != StartupGate::Blocked
        && init_received_at.is_some_and(|started| started.elapsed() >= STARTUP_READY_TIMEOUT);

    if !startup_ready && !timed_out {
        if !readiness.wait_warned
            && init_received_at.is_some_and(|started| started.elapsed() >= STARTUP_READY_WARNING)
        {
            tracing::warn!(
                target: "agent_relay::worker::pty",
                worker = %worker_name,
                warning_secs = STARTUP_READY_WARNING.as_secs(),
                "harness prompt not ready yet; preserving queued work until readiness is proven"
            );
            readiness.wait_warned = true;
        }
        return;
    }

    if !startup_ready {
        // Fail open, loudly. Holding the brief forever is the worse failure:
        // it presents as a live, idle agent that silently never does its work.
        tracing::warn!(
            target: "agent_relay::worker::pty",
            worker = %worker_name,
            timeout_secs = STARTUP_READY_TIMEOUT.as_secs(),
            "harness prompt never recognised; releasing queued startup work anyway"
        );
    }

    let request_id = init_request_id.take();
    let _ = send_frame(
        out_tx,
        "worker_ready",
        request_id,
        json!({"name": worker_name, "runtime": "pty", "pid": child_pid}),
    )
    .await;
    readiness.ready_sent = true;
}

async fn emit_harness_started(
    out_tx: &mpsc::Sender<ProtocolEnvelope<Value>>,
    worker_name: &str,
    child_pid: Option<u32>,
) {
    let _ = send_frame(
        out_tx,
        "harness_started",
        None,
        json!({"name": worker_name, "runtime": "pty", "pid": child_pid}),
    )
    .await;
}

pub(crate) async fn run_pty_worker(cmd: PtyCommand) -> Result<()> {
    // Disable Claude Code auto-suggestions to prevent accidental acceptance during injection.
    #[allow(deprecated)]
    std::env::set_var("CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION", "false");
    // Disable Claude Code auto-updater — it fails in sandboxes and can crash the process.
    #[allow(deprecated)]
    std::env::set_var("DISABLE_AUTOUPDATER", "1");

    let (resolved_cli, inline_cli_args) = parse_cli_command(&cmd.cli)
        .with_context(|| format!("invalid CLI command '{}'", cmd.cli))?;
    let mut effective_args = inline_cli_args;
    effective_args.extend(cmd.args.clone());

    let (init_rows, init_cols) = get_terminal_size().unwrap_or((24, 80));
    let (pty, mut pty_rx) =
        PtySession::spawn(&resolved_cli, &effective_args, init_rows, init_cols)?;
    // Query responses (DSR/DA1/DA2/CPR) are answered by alacritty's
    // `RelayEventListener` inside `PtySession` — no parser needed here.

    let (out_tx, mut out_rx) = mpsc::channel::<ProtocolEnvelope<Value>>(1024);
    let writer_task = tokio::spawn(async move {
        // Keep one async stdout handle for this process. Tokio's `write_all`
        // is not cancel-safe if the task is aborted mid-write. This task
        // shuts down by dropping `out_tx` and awaiting the writer so the
        // frame stream drains cleanly.
        use tokio::io::AsyncWriteExt;
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
    let mut running = true;
    let mut child_exit_detected = false;

    let mut pty_auto = PtyAutoState::new();

    let idle_threshold = if cmd.idle_threshold_secs == 0 {
        None
    } else {
        Some(Duration::from_secs(cmd.idle_threshold_secs))
    };

    // Terminal resize arrives from the broker as a `resize_pty` protocol
    // frame on stdin (see the frame handler below) — the worker itself
    // never observes the user's TTY, since its stdout is a pipe.

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
    // Per-atom gap for escape-aware paced injection writes, resolved once at
    // worker start. `Duration::ZERO` (via `RELAY_INJECT_RATE_MS=0`) restores
    // the historical single bulk write.
    let inject_rate = inject_rate_from_env(&resolved_cli);
    let mut mcp_reminder_throttle = McpReminderThrottle::new();
    let mut pending_worker_injections: VecDeque<PendingWorkerInjection> = VecDeque::new();
    let mut pending_worker_delivery_ids: HashSet<DeliveryId> = HashSet::new();
    // The injection currently being written across paced stages, if any. Only
    // one injection is in flight at a time; the pending-injection interval arm
    // starts the next one once this returns to `None`.
    let mut active_injection: Option<ActiveInjection> = None;
    // Outstanding `flush_injections` allowance: how many queued injections may
    // still be popped THROUGH an interactive hold. Set to the queue length when
    // the broker forwards an explicit flush; decremented on every pop (so a
    // flush issued while unheld drains naturally and can't leak into a later
    // hold); restored when a hold-exempt injection is requeued after a failed
    // write so an explicit flush is never silently swallowed by a transient
    // error. Deliveries arriving after the flush get no exemption.
    let mut hold_exempt_injections: usize = 0;
    // Event ids released through the hold individually by an `event_id`-scoped
    // `flush_injections`. Unlike the counter above this grants nothing to the
    // rest of the backlog: only the named delivery is popped (out of order if
    // needed) and everything else stays parked. The broker uses it to start a
    // (re)spawn's initial task under a replayed hold. An id is recorded even
    // when the delivery has not been queued yet, so a retry that lands after
    // the flush is still released; a hold boundary clears the set.
    let mut hold_exempt_event_ids: HashSet<String> = HashSet::new();
    // Ack receiver for the in-flight injection's most recent Body/Enter write.
    // `submit_write` only enqueues to the bounded drainer queue; the oneshot
    // resolves once the drainer has actually written and flushed those bytes to
    // the child (or hit an I/O error / exited). While this is `Some` the loop is
    // awaiting that confirmation and the injection deadline arm is gated off, so
    // a wedged drainer can never advance the paced sequence — no false
    // `delivery_injected`, no bogus echo baseline. On a failed ack the delivery
    // is requeued at the front of `pending_worker_injections`.
    let mut injection_ack: Option<tokio::sync::oneshot::Receiver<std::io::Result<()>>> = None;
    // In-flight `write_pty` PTY writes awaiting the drainer's confirmation. Each
    // entry resolves to `(request_id, byte_len, ack_result)` once the PTY write
    // (or its failure) is confirmed, at which point the loop sends a
    // `write_pty_response` frame back to the broker. Awaiting the ack here —
    // rather than acking on enqueue — is what makes `pty_input_ack` mean "the
    // bytes reached the child", so a client's `PtyInputStream.send()` only
    // resolves after a real write (and rejects on failure, driving the CLI
    // predictive-echo rollback). Draining lives in its own select arm so the
    // loop keeps forwarding PTY output and handling input while writes settle.
    let mut pending_pty_writes: FuturesUnordered<PtyWriteAckFuture> = FuturesUnordered::new();
    let wait_for_agent_relay_boot = codex_agent_relay_boot_expected(&resolved_cli, &effective_args);
    let mut startup_output = String::new();
    let mut startup_total_bytes = 0usize;
    let mut saw_agent_relay_boot = false;
    let mut post_boot_output = String::new();
    let mut init_request_id: Option<RequestId> = None;
    let mut init_received_at: Option<Instant> = None;
    let mut startup_readiness = StartupReadinessState::default();
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
    let mut echo_buffer = VerificationOutput::default();
    // Buffer for detecting KIND: continuity commands in PTY output.
    // Bounded to avoid unbounded memory growth; continuity blocks are small.
    let mut continuity_buffer = String::new();
    const CONTINUITY_BUFFER_MAX: usize = 4096;
    // Streaming UTF-8 decoder. PTY reads can split multi-byte codepoints
    // across chunks; the decoder holds incomplete trailing bytes for the
    // next chunk instead of corrupting them into U+FFFD.
    let mut utf8_decoder = Utf8StreamDecoder::new();
    // Stateful ANSI stripper for the readiness/prompt-detection path. Unlike a
    // per-chunk `strip_ansi`, it stitches escape sequences split across PTY
    // reads so fragments like `3;5H` never leak into `startup_output` and
    // confuse boot-marker / prompt matching (#1247).
    let mut readiness_stripper = AnsiStripper::new();
    // Stateful ANSI stripper for auto-suggestion detection, mirroring
    // `suggestion_stripper` in wrap.rs. `is_auto_suggestion` keys on raw
    // markers (`\x1b[7m`, `\x1b[27m\x1b[2m`); scanning each PTY read
    // independently misses a marker split across two reads. Stitching the raw
    // stream here holds back an incomplete trailing escape and prepends it to
    // the next chunk so the ghost-text guard sees whole markers (#1247).
    let mut suggestion_stripper = AnsiStripper::new();
    // Bounded tail of the *previous* scanned chunk for ghost-text detection.
    // `is_auto_suggestion` requires a marker *pair* (`\x1b[7m` … `\x1b[27m\x1b[2m`)
    // in one string; when the halves land in different PTY reads, neither chunk
    // contains both. Passing this tail alongside the new chunk to
    // `update_auto_suggestion_windowed` lets a pair straddling the boundary be
    // seen whole. It holds only the previous chunk's tail (not accumulated
    // history), so a stale suggestion can't keep the guard armed.
    let mut suggestion_prev_tail = String::new();
    const SUGGESTION_LOOKBEHIND_MAX: usize = 512;
    // Coalesced buffering for worker_stream emissions, tuned for
    // interactive (`drive`/`passthrough`) latency. Output flushes on a
    // leading edge — the first chunk after an idle gap goes out
    // immediately — then coalesces at ~60Hz during sustained bursts, or
    // sooner when the buffer crosses the size cap. A trailing flush is
    // armed via `stream_flush_deadline` so the last chunk of a burst
    // reaches the client within one interval instead of waiting on a
    // slower housekeeping tick. The size cap protects the heavy-output
    // path (large dumps flush by size, not time), so the short interval
    // only multiplies frame count for light interactive load, where the
    // volume is negligible.
    let mut stream_buffer = String::new();
    let mut stream_buffer_last_flush = Instant::now();
    // Monotonic count of raw PTY bytes this worker has received from the PTY
    // reader. Included in every `worker_stream` frame as `offset` (the
    // cumulative end position of the emitted chunk) so an attaching client
    // can correlate the live stream with a visible-screen snapshot: the
    // snapshot response carries the grid's consumed offset, and the client
    // drops any buffered `worker_stream` whose `offset` is `<=` that value.
    // Counts every received byte (including UTF-8 continuation bytes held
    // back by the decoder) so it stays in lockstep with the grid's own
    // byte counter in `relay-pty`.
    let mut stream_offset: u64 = 0;
    const STREAM_BUFFER_MAX: usize = 4096;
    const STREAM_FLUSH_INTERVAL: Duration = Duration::from_millis(16);
    // Armed only while output is buffered mid-burst; when `None` the
    // corresponding select arm parks on `pending()` so idle workers incur
    // no extra timer wakeups. Declared before the macro so the macro's
    // mixed-site hygiene resolves it.
    let mut stream_flush_deadline: Option<tokio::time::Instant> = None;

    /// Flush `stream_buffer` via a `worker_stream` frame if non-empty.
    macro_rules! flush_stream_buffer {
        () => {
            if !stream_buffer.is_empty() {
                let chunk = std::mem::take(&mut stream_buffer);
                let _ = send_frame(&out_tx, "worker_stream", None, json!({
                    "stream": "stdout",
                    "chunk": chunk,
                    "offset": stream_offset,
                })).await;
                stream_buffer_last_flush = Instant::now();
            }
            stream_flush_deadline = None;
        };
    }
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
    let mut last_context_low_pct: Option<u8> = None;

    // Pinned timer for the injection pacing arm. Hoisted out of the select loop
    // so heavy PTY output — which spins the loop once per chunk — doesn't churn
    // a fresh `Sleep` (and its timer-wheel registration) every iteration. The
    // sleep is `.reset()` only when the in-flight injection's deadline actually
    // changes, tracked via `injection_delay_at`. Absolute deadlines (`next_at`)
    // mean a reset after an interactive-hold freeze still resumes correctly: if
    // the deadline already passed while held, the timer is immediately ready on
    // release, matching the old `sleep_until(past)` semantics.
    let injection_delay = tokio::time::sleep(Duration::from_secs(0));
    tokio::pin!(injection_delay);
    let mut injection_delay_at: Option<tokio::time::Instant> = None;

    while running {
        // Re-point the pinned injection timer whenever the active injection's
        // deadline changes (new injection popped, stage advanced, or ack paced
        // the next stage). One comparison per iteration; a `reset` only on a
        // genuine change, so the steady state incurs no timer churn.
        {
            let target = active_injection.as_ref().map(|inj| inj.next_at);
            if target != injection_delay_at {
                injection_delay_at = target;
                if let Some(at) = target {
                    injection_delay.as_mut().reset(at);
                }
            }
        }

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
                                // Process liveness and safe input readiness are
                                // separate facts. Report the child pid now so
                                // the broker can reap a dead harness without
                                // killing a live one whose prompt takes longer
                                // than its startup deadline or is unrecognized.
                                // Initial work remains queued until the later
                                // worker_ready frame.
                                emit_harness_started(
                                    &out_tx,
                                    &worker_name,
                                    pty.child_pid(),
                                )
                                .await;
                                let startup_ready = startup_gate_ready(
                                    &resolved_cli,
                                    &startup_output,
                                    startup_total_bytes,
                                    wait_for_agent_relay_boot,
                                    saw_agent_relay_boot,
                                    &post_boot_output,
                                    &pty,
                                );
                                let gate = if startup_ready {
                                    StartupGate::Ready
                                } else if startup_gate_blocked(&pty) {
                                    StartupGate::Blocked
                                } else {
                                    StartupGate::Unrecognised
                                };
                                try_emit_worker_ready(
                                    &out_tx,
                                    &worker_name,
                                    pty.child_pid(),
                                    &mut init_request_id,
                                    init_received_at,
                                    &mut startup_readiness,
                                    gate,
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
                            "resize_pty" => {
                                #[derive(serde::Deserialize)]
                                struct ResizePtyPayload { rows: u16, cols: u16 }
                                match serde_json::from_value::<ResizePtyPayload>(frame.payload) {
                                    Ok(p) if p.rows > 0 && p.cols > 0 => {
                                        if let Err(e) = pty.resize(p.rows, p.cols) {
                                            tracing::warn!(
                                                target: "agent_relay::worker::pty",
                                                rows = p.rows, cols = p.cols, error = %e,
                                                "failed to resize pty"
                                            );
                                        }
                                    }
                                    Ok(_) => {
                                        let _ = send_frame(&out_tx, "worker_error", frame.request_id, json!({
                                            "code": "invalid_dimensions",
                                            "message": "rows and cols must be >= 1",
                                            "retryable": false
                                        })).await;
                                    }
                                    Err(e) => {
                                        let _ = send_frame(&out_tx, "worker_error", frame.request_id, json!({
                                            "code": "invalid_payload",
                                            "message": e.to_string(),
                                            "retryable": false
                                        })).await;
                                    }
                                }
                            }
                            "write_pty" => {
                                // Raw input forwarded by the broker (typically
                                // from POST /api/input/{name} via
                                // `client.sendInput()`). The payload is
                                // `{ "data": "<bytes-as-utf8-string>" }`; we
                                // write those bytes verbatim to the PTY so the
                                // child process sees the keystrokes.
                                match frame.payload.get("data").and_then(Value::as_str) {
                                    Some(data) => {
                                        // Non-blocking submission: never parks the
                                        // select loop even if the drainer is wedged
                                        // behind a child that stopped reading stdin.
                                        let bytes = data.as_bytes().to_vec();
                                        let byte_len = bytes.len();
                                        match pty.submit_write(bytes) {
                                            Ok(ack_rx) => {
                                                // Defer the ack until the drainer confirms the
                                                // write landed (or failed). The broker holds the
                                                // SendInput reply / pty_input_ack until the
                                                // matching `write_pty_response` arrives.
                                                match frame.request_id.clone() {
                                                    Some(req_id) => {
                                                        pending_pty_writes.push(Box::pin(async move {
                                                            let ack = ack_rx.await;
                                                            (req_id, byte_len, ack)
                                                        }));
                                                    }
                                                    None => {
                                                        // No correlation id (legacy / fire-and-forget
                                                        // input): drop the receiver, nothing to ack.
                                                    }
                                                }
                                            }
                                            Err(e) => {
                                                tracing::warn!(
                                                    target: "agent_relay::worker::pty",
                                                    error = %e,
                                                    "failed to submit input to pty"
                                                );
                                                // Surface the enqueue failure on the correlated
                                                // response so the client's send() rejects instead
                                                // of resolving on a write that never happened.
                                                //
                                                // A full drainer queue gets its own code. The child
                                                // is alive and the transport is healthy — it is only
                                                // momentarily not draining its stdin — so an attach
                                                // client must be able to tell this apart from a
                                                // genuinely broken write and keep its input stream
                                                // open (see `pty_input_error_is_connection_fatal`).
                                                let code = match e
                                                    .downcast_ref::<PtyWriteSubmitError>()
                                                {
                                                    Some(PtyWriteSubmitError::QueueFull { .. }) => {
                                                        "pty_write_queue_full"
                                                    }
                                                    _ => "pty_write_failed",
                                                };
                                                let _ = send_frame(&out_tx, "write_pty_response", frame.request_id, json!({
                                                    "error": {
                                                        "code": code,
                                                        "message": e.to_string(),
                                                    }
                                                })).await;
                                            }
                                        }
                                    }
                                    None => {
                                        let _ = send_frame(&out_tx, "write_pty_response", frame.request_id, json!({
                                            "error": {
                                                "code": "invalid_payload",
                                                "message": "write_pty payload must include 'data' string",
                                            }
                                        })).await;
                                    }
                                }
                            }
                            "set_interactive_hold" => {
                                // Human-drive hold toggle. While held, the worker
                                // stops popping pending injections, freezes any
                                // in-flight injection (its deadline arm is gated
                                // off and resumes when released), and gates the
                                // auto-enter / prompt auto-responders — so none of
                                // them splice keystrokes into the human's typing.
                                let hold = frame.payload
                                    .get("hold")
                                    .and_then(Value::as_bool)
                                    .unwrap_or(false);
                                if pty_auto.interactive_hold != hold {
                                    tracing::info!(
                                        target: "agent_relay::worker::pty",
                                        worker = %worker_name,
                                        hold,
                                        "interactive hold updated"
                                    );
                                }
                                pty_auto.interactive_hold = hold;
                                // A hold boundary invalidates any outstanding
                                // flush exemption: entering a hold must freeze
                                // everything (a pre-hold flush was consent to
                                // inject while NOT driving, not through a later
                                // drive), and after a release the exemption is
                                // moot. Without this, a large backlog flushed
                                // before a drive attach could keep injecting
                                // into the human's session.
                                hold_exempt_injections = 0;
                                hold_exempt_event_ids.clear();
                                if let Some(inj) = active_injection.as_mut() {
                                    inj.hold_exempt = false;
                                    inj.targeted_hold_exemption = false;
                                }
                            }
                            "flush_injections" => {
                                // Explicit flush (`POST /api/spawned/{name}/flush`):
                                // the human asked for the queued backlog NOW, so
                                // grant the currently-queued injections (and any
                                // frozen in-flight one) a one-shot exemption from
                                // the interactive hold. Later deliveries keep
                                // parking under the hold as usual. Granted ONLY
                                // while a hold is actually active — without one,
                                // injections pop normally and an exemption
                                // recorded now could pierce a hold that starts
                                // before a slow backlog finishes draining.
                                //
                                // An `event_id` in the payload narrows the flush
                                // to that one delivery instead: the broker uses
                                // it to start a (re)spawn's initial task under a
                                // replayed hold, and a relay message retried into
                                // the restarted worker must keep parking rather
                                // than riding along on the same exemption.
                                let targeted_event_id = frame
                                    .payload
                                    .get("event_id")
                                    .and_then(Value::as_str)
                                    .filter(|event_id| !event_id.is_empty())
                                    .map(str::to_string);
                                if pty_auto.interactive_hold {
                                    if let Some(event_id) = targeted_event_id {
                                        if let Some(inj) = active_injection.as_mut() {
                                            if inj.pending.delivery.event_id == event_id {
                                                inj.hold_exempt = true;
                                                inj.targeted_hold_exemption = true;
                                            }
                                        }
                                        tracing::info!(
                                            target: "agent_relay::worker::pty",
                                            worker = %worker_name,
                                            event_id = %event_id,
                                            "releasing one delivery through interactive hold"
                                        );
                                        hold_exempt_event_ids.insert(event_id);
                                    } else {
                                        let backlog = pending_worker_injections.len();
                                        hold_exempt_injections =
                                            hold_exempt_injections.max(backlog);
                                        if let Some(inj) = active_injection.as_mut() {
                                            // Leave an existing targeted exemption
                                            // targeted. Downgrading it would send a
                                            // later requeue of *this* delivery back
                                            // to the shared counter instead of to
                                            // its own event id, so the credit could
                                            // be spent on whatever else is queued.
                                            inj.hold_exempt = true;
                                        }
                                        tracing::info!(
                                            target: "agent_relay::worker::pty",
                                            worker = %worker_name,
                                            backlog,
                                            "flushing queued injections through interactive hold"
                                        );
                                    }
                                }
                            }
                            "ping" => {
                                let ts = frame.payload.get("ts_ms").and_then(Value::as_u64).unwrap_or_default();
                                let _ = send_frame(&out_tx, "pong", frame.request_id, json!({"ts_ms": ts})).await;
                            }
                            "snapshot_pty" => {
                                // Visible-screen snapshot driven by the broker. The
                                // broker correlates the response via request_id and
                                // forwards the rendered payload back to the HTTP /
                                // CLI caller.
                                let format = frame
                                    .payload
                                    .get("format")
                                    .and_then(Value::as_str)
                                    .unwrap_or("plain")
                                    .to_string();
                                // Flush any coalesced stream output first so
                                // the bytes already parsed into the grid have
                                // been emitted as `worker_stream` at a clean
                                // offset boundary before we report the
                                // snapshot's offset. Without this the 16ms
                                // coalescing buffer would sit between the grid
                                // and the stream, and a client couldn't tell
                                // which side of the snapshot those bytes fell.
                                flush_stream_buffer!();
                                let (snap, snapshot_offset) = Snapshot::capture_with_offset(&pty);
                                let cursor = json!([snap.cursor.0, snap.cursor.1]);
                                let payload = match format.as_str() {
                                    "ansi" => {
                                        let bytes = snap.to_ansi();
                                        let encoded = base64::engine::general_purpose::STANDARD
                                            .encode(&bytes);
                                        json!({
                                            "format": "ansi",
                                            "rows": snap.rows,
                                            "cols": snap.cols,
                                            "cursor": cursor,
                                            "screen": encoded,
                                            "offset": snapshot_offset,
                                        })
                                    }
                                    "plain" | "" | "text" => json!({
                                        "format": "plain",
                                        "rows": snap.rows,
                                        "cols": snap.cols,
                                        "cursor": cursor,
                                        "screen": snap.to_plain(),
                                        "offset": snapshot_offset,
                                    }),
                                    other => {
                                        let _ = send_frame(&out_tx, "snapshot_response", frame.request_id, json!({
                                            "error": {
                                                "code": "invalid_format",
                                                "message": format!("unsupported snapshot format '{other}' (expected 'plain' or 'ansi')"),
                                            }
                                        })).await;
                                        continue;
                                    }
                                };
                                let _ = send_frame(&out_tx, "snapshot_response", frame.request_id, payload).await;
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
                        mcp_reminder_throttle.note_output_bytes(chunk.len());
                        // Preserve the producer-assigned read sequence before
                        // decoding. A queued pre-submission chunk must remain
                        // stale even when this select arm consumes it later.
                        echo_buffer.push_output(chunk.sequence(), chunk.as_bytes());
                        // Child is provably alive — reset the no-PID exit counter.
                        pty.reset_no_pid_checks();
                        startup_total_bytes = startup_total_bytes.saturating_add(chunk.len());
                        // Advance the stream offset by the raw byte count
                        // before decoding, so `worker_stream.offset` tracks
                        // the same byte position the grid does (which also
                        // counts held-back UTF-8 continuation bytes).
                        stream_offset = stream_offset.saturating_add(chunk.len() as u64);
                        let text = utf8_decoder.decode(&chunk);
                        if text.is_empty() {
                            // Whole chunk was an incomplete UTF-8 prefix held
                            // back for the next read; nothing to emit yet.
                            continue;
                        }
                        let clean_text = readiness_stripper.feed(&text);
                        append_bounded(
                            &mut startup_output,
                            &clean_text,
                            STARTUP_BUFFER_MAX,
                            STARTUP_BUFFER_KEEP,
                        );
                        if wait_for_agent_relay_boot {
                            let mut just_saw_agent_relay_boot = false;
                            if !saw_agent_relay_boot {
                                let lower_startup = startup_output.to_ascii_lowercase();
                                if let Some(marker_end_offset) = find_agent_relay_boot_marker(&lower_startup)
                                {
                                    saw_agent_relay_boot = true;
                                    just_saw_agent_relay_boot = true;
                                    let marker_end = floor_char_boundary(
                                        &startup_output,
                                        marker_end_offset,
                                    );
                                    post_boot_output.clear();
                                    append_bounded(
                                        &mut post_boot_output,
                                        &startup_output[marker_end..],
                                        STARTUP_BUFFER_MAX,
                                        STARTUP_BUFFER_KEEP,
                                    );
                                }
                            }
                            if saw_agent_relay_boot && !just_saw_agent_relay_boot {
                                append_bounded(
                                    &mut post_boot_output,
                                    &clean_text,
                                    STARTUP_BUFFER_MAX,
                                    STARTUP_BUFFER_KEEP,
                                );
                            }
                        }
                        if let Some(pct) = detect_context_budget_pct(&clean_text) {
                            if last_context_low_pct.is_some_and(|last| pct > last) {
                                last_context_low_pct = None;
                            }
                            if pct <= 10 && last_context_low_pct != Some(pct) {
                                let _ = send_frame(&out_tx, "agent_context_low", None, json!({
                                    "pct": pct,
                                })).await;
                                last_context_low_pct = Some(pct);
                            }
                        }
                        // Clear startup interstitials before evaluating the
                        // prompt. The gate below still explicitly rejects the
                        // trust screen until Codex redraws its real composer.
                        pty_auto.handle_codex_trust(&text, &pty).await;
                        let startup_ready = startup_gate_ready(
                            &resolved_cli,
                            &startup_output,
                            startup_total_bytes,
                            wait_for_agent_relay_boot,
                            saw_agent_relay_boot,
                            &post_boot_output,
                            &pty,
                        );
                        let gate = if startup_ready {
                            StartupGate::Ready
                        } else if startup_gate_blocked(&pty) {
                            StartupGate::Blocked
                        } else {
                            StartupGate::Unrecognised
                        };
                        try_emit_worker_ready(
                            &out_tx,
                            &worker_name,
                            pty.child_pid(),
                            &mut init_request_id,
                            init_received_at,
                            &mut startup_readiness,
                            gate,
                        )
                        .await;

                        // Detect /exit command in agent output and trigger graceful shutdown.
                        // Skip detection while echo verifications are pending to avoid
                        // false-positives from injected relay messages containing "/exit".
                        stream_buffer.push_str(&text);
                        if stream_buffer.len() >= STREAM_BUFFER_MAX
                            || stream_buffer_last_flush.elapsed() >= STREAM_FLUSH_INTERVAL
                        {
                            // Size cap hit, or the leading edge after an idle
                            // gap — flush now so interactive echo isn't held.
                            flush_stream_buffer!();
                        } else if stream_flush_deadline.is_none() {
                            // Mid-burst: arm a trailing flush so the tail of
                            // this burst lands within one interval.
                            stream_flush_deadline =
                                Some(tokio::time::Instant::now() + STREAM_FLUSH_INTERVAL);
                        }

                        if injected_output_command_detection_allowed(
                            active_injection.is_some(),
                            pending_verifications.is_empty(),
                        )
                            && clean_text.lines().any(|line| line.trim() == "/exit")
                        {
                            tracing::info!(
                                target: "agent_relay::worker::pty",
                                "agent issued /exit — shutting down"
                            );
                            flush_stream_buffer!();
                            let _ = send_frame(&out_tx, "agent_exit", None, json!({
                                "reason": "agent_requested",
                            })).await;
                            running = false;
                        }

                        // Scan the stitched raw stream so a `\x1b[7m` marker
                        // split mid-sequence is reassembled, and pass the
                        // previous chunk's tail so a marker *pair* straddling
                        // the read boundary is still detected — while the
                        // clear decision stays on the current chunk.
                        let suggestion_scan = suggestion_stripper.feed_raw(&text);
                        pty_auto
                            .update_auto_suggestion_windowed(&suggestion_scan, &suggestion_prev_tail);
                        if !suggestion_scan.is_empty() {
                            let start = floor_char_boundary(
                                &suggestion_scan,
                                suggestion_scan.len().saturating_sub(SUGGESTION_LOOKBEHIND_MAX),
                            );
                            suggestion_prev_tail.clear();
                            suggestion_prev_tail.push_str(&suggestion_scan[start..]);
                        }
                        pty_auto.last_output_time = Instant::now();
                        pty_auto.reset_idle_on_output();
                        pty_auto.update_editor_buffer(&text);
                        pty_auto.reset_auto_enter_on_output(&text);
                        pty_auto.handle_mcp_approval(&text, &pty).await;
                        pty_auto.handle_bypass_permissions(&text, &pty).await;
                        pty_auto.handle_codex_model_prompt(&text, &pty).await;
                        pty_auto.handle_opencode_permission(&text, &pty).await;
                        pty_auto.handle_gemini_action(&text, &pty).await;
                        pty_auto.handle_gemini_untrusted_banner(&text, &pty).await;
                        pty_auto.handle_gemini_trust(&text, &pty).await;
                        pty_auto.handle_claude_trust(&text, &pty).await;

                        // Detect KIND: continuity commands in PTY output.
                        // Only scan when no echo verifications are pending to avoid false-positives
                        // from injected relay messages that might contain header-like text.
                        if injected_output_command_detection_allowed(
                            active_injection.is_some(),
                            pending_verifications.is_empty(),
                        ) {
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
                                    target: "agent_relay::worker::pty",
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
                            if pending_verification_echo_seen(&echo_buffer, pv) {
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
                                    "event_id": event_id,
                                    "verification": "echo"
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
                                        target: "agent_relay::worker::pty",
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
                                        target: "agent_relay::worker::pty",
                                        delivery_id = %pa.delivery_id,
                                        event_id = %pa.event_id,
                                        "delivery activity window expired"
                                    );
                                }
                            }
                        }
                    }
                    None => {
                        // PTY reader closed — child likely exited. Flush
                        // any incomplete trailing UTF-8 bytes (no further
                        // chunks will arrive to complete them) before the
                        // stream_buffer flush so they reach worker_stream
                        // like normal stream output. The raw bytes were already
                        // added to echo_buffer with their producer sequence.
                        let tail = utf8_decoder.flush();
                        if !tail.is_empty() {
                            stream_buffer.push_str(&tail);
                        }
                        // Flush any buffered stream output before sending
                        // agent_exit to preserve output ordering.
                        flush_stream_buffer!();
                        // Emit agent_exit with any echo_buffer tail so the
                        // dashboard can surface the CLI's last output.
                        let retained_output = echo_buffer.retained();
                        let clean = strip_ansi(&retained_output);
                        let trimmed = if clean.len() > 2000 {
                            &clean[clean.len() - 2000..]
                        } else {
                            &clean
                        };
                        if !trimmed.is_empty() {
                            tracing::info!(
                                target: "agent_relay::worker::pty",
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
                        child_exit_detected = true;
                        running = false;
                    }
                }
            }

            // Trailing flush for the tail of an output burst. Parks on
            // `pending()` (never wakes) whenever no flush is armed.
            _ = async {
                match stream_flush_deadline {
                    Some(deadline) => tokio::time::sleep_until(deadline).await,
                    None => std::future::pending::<()>().await,
                }
            }, if stream_flush_deadline.is_some() => {
                flush_stream_buffer!();
            }

            // Confirm settled `write_pty` writes back to the broker. The guard
            // parks this arm on an empty set so an idle worker never busy-loops
            // on `FuturesUnordered::next()` returning `None`.
            Some((req_id, byte_len, ack)) = pending_pty_writes.next(), if !pending_pty_writes.is_empty() => {
                let payload = match ack {
                    Ok(Ok(())) => json!({ "bytes_written": byte_len }),
                    Ok(Err(err)) => json!({
                        "error": {
                            "code": "pty_write_failed",
                            "message": err.to_string(),
                        }
                    }),
                    Err(_) => json!({
                        "error": {
                            "code": "pty_write_failed",
                            "message": "pty write drainer exited before acknowledging queued write",
                        }
                    }),
                };
                let _ = send_frame(&out_tx, "write_pty_response", Some(req_id), payload).await;
            }

            // Start the next injection when the loop is free. All the paced
            // writes happen in the deadline arm below so this tick never
            // blocks: it only pops a delivery and schedules the first stage.
            // Gated off while an interactive hold is active so queued deliveries
            // stay parked (not dropped) until the human releases the drive.
            _ = pending_injection_interval.tick() => {
                if let Some(index) = next_injection_index(
                    &pending_worker_injections,
                    active_injection.is_some(),
                    pty_auto.interactive_hold,
                    hold_exempt_injections,
                    &hold_exempt_event_ids,
                ) {
                    let should_block = pending_worker_injections
                        .get(index)
                        .map(|pending| should_block_pending_injection(pty_auto.auto_suggestion_visible, pending))
                        .unwrap_or(false);
                    if !should_block {
                        if let Some(pending) = pending_worker_injections.remove(index) {
                            let targeted_hold_exemption =
                                hold_exempt_event_ids.remove(pending.delivery.event_id.as_str());
                            let hold_exempt = targeted_hold_exemption || hold_exempt_injections > 0;
                            hold_exempt_injections = hold_exempt_injections.saturating_sub(1);
                            active_injection = Some(ActiveInjection {
                                pending,
                                stage: InjectionStage::Escape,
                                next_at: tokio::time::Instant::now() + throttle.delay(),
                                injection_text: None,
                                output_boundary: None,
                                hold_exempt,
                                targeted_hold_exemption,
                            });
                        }
                    }
                }
            }

            // Advance the in-flight injection's paced write sequence. Driven by
            // the hoisted `injection_delay` timer; the guard disables this arm
            // when no injection is active, an ack is outstanding, or a human
            // hold is in effect, so an idle worker incurs no wakeups. Each stage
            // submits its bytes non-blockingly; Body/Enter then hand off to the
            // injection-ack arm, which paces the next stage once the drainer
            // confirms the write. The select loop keeps forwarding PTY output
            // and handling input between stages.
            _ = &mut injection_delay, if active_injection.is_some() && injection_ack.is_none()
                && (!pty_auto.interactive_hold
                    || active_injection.as_ref().is_some_and(|inj| inj.hold_exempt)) => {
                let mut inj = active_injection.take().expect("active injection present under guard");
                match inj.stage {
                    InjectionStage::Escape => {
                        if matches!(inj.pending.delivery.injection_mode, MessageInjectionMode::Steer) {
                            tracing::debug!(
                                delivery_id = %inj.pending.delivery.delivery_id,
                                "steer mode: sending ESC ESC before message injection"
                            );
                            if let Err(error) = pty.submit_write(b"\x1b\x1b".to_vec()) {
                                tracing::warn!(
                                    delivery_id = %inj.pending.delivery.delivery_id,
                                    error = %error,
                                    "steer mode ESC ESC write failed, re-queuing delivery"
                                );
                                restore_hold_exemption(
                                    &inj,
                                    &mut hold_exempt_injections,
                                    &mut hold_exempt_event_ids,
                                );
                                pending_worker_injections.push_front(inj.pending);
                            } else {
                                inj.stage = InjectionStage::Body;
                                inj.next_at = tokio::time::Instant::now() + Duration::from_millis(120);
                                active_injection = Some(inj);
                            }
                        } else if pty_auto.auto_suggestion_visible {
                            tracing::warn!(
                                delivery_id = %inj.pending.delivery.delivery_id,
                                "auto-suggestion visible; sending Escape to dismiss before injection"
                            );
                            warn_on_auto_response_write(
                                pty.submit_write(b"\x1b".to_vec()),
                                "injection_escape_dismiss",
                            );
                            inj.stage = InjectionStage::Body;
                            inj.next_at = tokio::time::Instant::now() + Duration::from_millis(100);
                            active_injection = Some(inj);
                        } else {
                            // No escape needed; submit the body on the next poll.
                            inj.stage = InjectionStage::Body;
                            inj.next_at = tokio::time::Instant::now();
                            active_injection = Some(inj);
                        }
                    }
                    InjectionStage::Body => {
                        pty_auto.auto_suggestion_visible = false;
                        let include_mcp_reminder = !suppress_multiline_mcp_reminder
                            && mcp_reminder_throttle.should_include(Instant::now());
                        let injection = format_injection_for_worker_with_workspace(
                            &inj.pending.delivery.from,
                            &inj.pending.delivery.event_id,
                            &inj.pending.delivery.body,
                            &inj.pending.delivery.target,
                            include_mcp_reminder,
                            worker_pre_registered,
                            assigned_worker_name.as_deref(),
                            inj.pending.delivery.workspace_id.as_deref(),
                            inj.pending.delivery.workspace_alias.as_deref(),
                        );
                        if include_mcp_reminder {
                            mcp_reminder_throttle.note_sent(Instant::now());
                        }
                        // Submit the body and mandatory Enter as one FIFO
                        // command and hold the ack. Claude Code needs Enter as
                        // a distinct PTY write after its multiline paste
                        // boundary settles; relay-pty keeps that delayed
                        // follow-up atomic with the body. Other harnesses keep
                        // the established body-plus-Enter write. In both cases,
                        // nothing (passthrough input, an auto-responder, or a
                        // terminal-query reply) can splice into submission.
                        // Finalization (emit `delivery_injected`, queue echo
                        // verification) still waits for this ack in the
                        // injection-ack arm.
                        let mut bytes = injection.clone().into_bytes();
                        let write = if let Some(delay) =
                            injection_submit_followup_delay(&resolved_cli)
                        {
                            pty.submit_write_paced_with_followup_and_output_boundary(
                                bytes,
                                inject_rate,
                                delay,
                                b"\r".to_vec(),
                            )
                        } else {
                            bytes.extend_from_slice(b"\r");
                            pty.submit_write_paced_with_output_boundary(bytes, inject_rate)
                        };
                        match write {
                            Ok((ack_rx, output_boundary)) => {
                                inj.injection_text = Some(injection);
                                inj.output_boundary = Some(output_boundary);
                                inj.stage = InjectionStage::Finalize;
                                injection_ack = Some(ack_rx);
                                active_injection = Some(inj);
                            }
                            Err(e) => {
                                tracing::warn!(
                                    delivery_id = %inj.pending.delivery.delivery_id,
                                    error = %e,
                                    "PTY injection write failed, re-queuing delivery"
                                );
                                restore_hold_exemption(
                                    &inj,
                                    &mut hold_exempt_injections,
                                    &mut hold_exempt_event_ids,
                                );
                                pending_worker_injections.push_front(inj.pending);
                            }
                        }
                    }
                    InjectionStage::Finalize => {
                        // Unreachable in practice: the deadline arm is gated off
                        // while `injection_ack` is `Some`, which it always is on
                        // entry to Finalize. Reaching here means the Enter ack was
                        // lost; requeue defensively rather than silently drop.
                        tracing::error!(
                            delivery_id = %inj.pending.delivery.delivery_id,
                            "injection reached Finalize in deadline arm without pending ack; re-queuing delivery"
                        );
                        restore_hold_exemption(
                            &inj,
                            &mut hold_exempt_injections,
                            &mut hold_exempt_event_ids,
                        );
                        pending_worker_injections.push_front(inj.pending);
                    }
                }
            }

            // Resolve the in-flight injection's Body/Enter write ack. Awaiting
            // the drainer's confirmation here — rather than acking on enqueue —
            // is what makes injection progression honest: a wedged drainer
            // blocks in this arm instead of emitting a false `delivery_injected`
            // or seeding echo verification against bytes the child never saw.
            // On a failed/lost ack the delivery is requeued at the front of
            // `pending_worker_injections`, matching the enqueue-failure retry
            // path. Parked (never polled) whenever no ack is outstanding.
            ack = async {
                injection_ack
                    .as_mut()
                    .expect("injection ack present under guard")
                    .await
            }, if injection_ack.is_some() => {
                injection_ack = None;
                if let Some(mut inj) = active_injection.take() {
                    let confirmed = matches!(ack, Ok(Ok(())));
                    match injection_ack_outcome(inj.stage, confirmed) {
                        InjectionAckOutcome::Finalize => {
                            // Body+Enter confirmed on the child: only now is
                            // the delivery genuinely injected.
                            let _ = send_frame(
                                &out_tx,
                                "delivery_injected",
                                None,
                                delivery_injected_event_payload(
                                    &inj.pending.delivery.delivery_id,
                                    &inj.pending.delivery.event_id,
                                    &worker_name,
                                    current_timestamp_ms(),
                                ),
                            )
                            .await;
                            pty_auto.last_injection_time = Some(Instant::now());
                            pty_auto.auto_enter_retry_count = 0;

                            // Queue echo verification against the confirmed body,
                            // or confirm immediately when the echo raced ahead of
                            // this ack while Claude's delayed Enter was pending.
                            let injection = inj.injection_text.take().unwrap_or_default();
                            let verification = PendingVerification {
                                delivery_id: inj.pending.delivery.delivery_id.clone(),
                                event_id: inj.pending.delivery.event_id.clone(),
                                expected_echo: injection,
                                output_boundary: inj
                                    .output_boundary
                                    .unwrap_or_else(|| echo_buffer.boundary()),
                                injected_at: Instant::now(),
                                attempts: 1,
                                max_attempts: 1,
                                request_id: inj.pending.request_id,
                                workspace_id: inj.pending.delivery.workspace_id.clone(),
                                workspace_alias: inj.pending.delivery.workspace_alias.clone(),
                                from: inj.pending.delivery.from,
                                body: inj.pending.delivery.body,
                                target: inj.pending.delivery.target,
                            };
                            if let Some(pv) = queue_or_take_confirmed_verification(
                                verification,
                                &echo_buffer,
                                &mut pending_verifications,
                            ) {
                                let delivery_id = pv.delivery_id.clone();
                                let event_id = pv.event_id.clone();
                                tracing::debug!(
                                    delivery_id = %delivery_id,
                                    attempts = pv.attempts,
                                    "delivery echo verified before write ack was processed"
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
                                        "event_id": event_id,
                                        "verification": "echo"
                                    }),
                                )
                                .await;
                                throttle.record(DeliveryOutcome::Success);
                                if let Some(detector) = activity_detector.as_ref() {
                                    if let Some((activity, pattern)) = queue_or_take_detected_activity(
                                        &pv,
                                        &echo_buffer,
                                        detector,
                                        &mut pending_activities,
                                    ) {
                                        tracing::debug!(
                                            target: "agent_relay::worker::pty",
                                            delivery_id = %activity.delivery_id,
                                            event_id = %activity.event_id,
                                            pattern = %pattern,
                                            "delivery activity detected before write ack was processed"
                                        );
                                        let _ = send_frame(
                                            &out_tx,
                                            "delivery_active",
                                            None,
                                            json!({
                                                "delivery_id": activity.delivery_id,
                                                "event_id": activity.event_id,
                                                "pattern": pattern,
                                            }),
                                        )
                                        .await;
                                    }
                                }
                                pending_worker_delivery_ids.remove(&delivery_id);
                            }
                            // active_injection remains None: injection complete.
                        }
                        InjectionAckOutcome::Requeue => {
                            let reason = match ack {
                                Ok(Err(err)) => err.to_string(),
                                Err(_) => "pty write drainer exited before acknowledging queued write".to_string(),
                                Ok(Ok(())) => "unexpected ack for a stage that awaits none".to_string(),
                            };
                            tracing::warn!(
                                delivery_id = %inj.pending.delivery.delivery_id,
                                stage = ?inj.stage,
                                error = %reason,
                                "injection write not confirmed by drainer, re-queuing delivery"
                            );
                            // Requeue at the front, preserving retry ordering. The
                            // delivery_id stays in `pending_worker_delivery_ids`, so
                            // the next pop retries the same delivery. A hold-exempt
                            // injection keeps its exemption so an explicit flush is
                            // retried rather than freezing under the hold.
                            restore_hold_exemption(
                                &inj,
                                &mut hold_exempt_injections,
                                &mut hold_exempt_event_ids,
                            );
                            pending_worker_injections.push_front(inj.pending);
                        }
                    }
                }
            }

            // --- Verification tick: check for timed-out verifications ---
            _ = verification_tick.tick() => {
                let startup_ready = startup_gate_ready(
                    &resolved_cli,
                    &startup_output,
                    startup_total_bytes,
                    wait_for_agent_relay_boot,
                    saw_agent_relay_boot,
                    &post_boot_output,
                    &pty,
                );
                let gate = if startup_ready {
                    StartupGate::Ready
                } else if startup_gate_blocked(&pty) {
                    StartupGate::Blocked
                } else {
                    StartupGate::Unrecognised
                };
                try_emit_worker_ready(
                    &out_tx,
                    &worker_name,
                    pty.child_pid(),
                    &mut init_request_id,
                    init_received_at,
                    &mut startup_readiness,
                    gate,
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
                        tracing::info!(
                            delivery_id = %delivery_id,
                            attempts = pv.attempts,
                            "delivery echo not detected within verification window; acknowledging via timeout fallback (unverified)"
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
                        // Timeout-fallback acks are not verified deliveries:
                        // keep them out of the throttle's success signal.
                        throttle.record(DeliveryOutcome::Unverified);
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

                // Flush any buffered stream output during quiet periods.
                if !stream_buffer.is_empty()
                    && stream_buffer_last_flush.elapsed() >= STREAM_FLUSH_INTERVAL
                {
                    flush_stream_buffer!();
                }

            }

            // --- Auto-enter for stuck agents ---
            _ = auto_enter_interval.tick() => {
                pty_auto.try_auto_enter(&pty);

                // Idle detection: emit agent_idle once when silence exceeds threshold.
                // Granularity depends on auto_enter_interval tick rate (2s).
                if pending_worker_injections.is_empty()
                    && pending_verifications.is_empty()
                    && pending_activities.is_empty()
                {
                    if let Some(threshold) = idle_threshold {
                    if let Some(idle_secs) = pty_auto.check_idle_transition(threshold) {
                        let _ = send_frame(&out_tx, "agent_idle", None, json!({
                            "idle_secs": idle_secs,
                        })).await;
                    }
                    }
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
                    // Flush any buffered stream output before sending late output
                    // to preserve ordering.
                    flush_stream_buffer!();
                    let mut late_output = String::new();
                    while let Ok(chunk) = pty_rx.try_recv() {
                        stream_offset = stream_offset.saturating_add(chunk.len() as u64);
                        let text = utf8_decoder.decode(&chunk);
                        if text.is_empty() {
                            continue;
                        }
                        late_output.push_str(&text);
                        let _ = send_frame(&out_tx, "worker_stream", None, json!({
                            "stream": "stdout",
                            "chunk": text,
                            "offset": stream_offset,
                        })).await;
                    }
                    // Stream is closing; flush any incomplete trailing bytes
                    // as U+FFFD rather than silently dropping them.
                    let tail = utf8_decoder.flush();
                    if !tail.is_empty() {
                        late_output.push_str(&tail);
                        let _ = send_frame(&out_tx, "worker_stream", None, json!({
                            "stream": "stdout",
                            "chunk": tail,
                            "offset": stream_offset,
                        })).await;
                    }
                    if !late_output.is_empty() {
                        let clean = strip_ansi(&late_output);
                        tracing::warn!(
                            target: "agent_relay::worker::pty",
                            output = %clean,
                            "watchdog: captured late output from exiting child"
                        );
                    }
                    tracing::info!(
                        target: "agent_relay::worker::pty",
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
                    child_exit_detected = true;
                    running = false;
                } else {
                    // If no PTY output arrives for a long time, emit an idle
                    // event so the broker or dashboard can decide what to do.
                    let silent_duration = last_pty_output_time.elapsed();
                    if silent_duration >= NO_OUTPUT_EXIT_TIMEOUT && !reported_idle {
                        let pending_count = pending_worker_injections.len()
                            + pending_verifications.len()
                            + pending_activities.len();
                        if pending_count > 0 {
                            tracing::debug!(
                                target: "agent_relay::worker::pty",
                                silent_secs = silent_duration.as_secs(),
                                pending_delivery_count = pending_count,
                                "watchdog: no PTY output while delivery work is pending — marking blocked_on_send"
                            );
                            let _ = send_frame(&out_tx, "agent_blocked_on_send", None, json!({
                                "reason": "no_output_timeout",
                                "blocked_secs": silent_duration.as_secs(),
                                "pending_delivery_count": pending_count,
                            })).await;
                        } else {
                            tracing::debug!(
                                target: "agent_relay::worker::pty",
                                silent_secs = silent_duration.as_secs(),
                                "watchdog: no PTY output for {}s — marking idle",
                                silent_duration.as_secs()
                            );
                            let _ = send_frame(&out_tx, "agent_idle", None, json!({
                                "reason": "no_output_timeout",
                                "idle_secs": silent_duration.as_secs(),
                            })).await;
                        }
                        reported_idle = true;
                    }
                }
            }
        }
    }

    // Flush any remaining buffered stream output before signaling exit.
    if !stream_buffer.is_empty() {
        let chunk = std::mem::take(&mut stream_buffer);
        let _ = send_frame(
            &out_tx,
            "worker_stream",
            None,
            json!({
                "stream": "stdout",
                "chunk": chunk,
                "offset": stream_offset,
            }),
        )
        .await;
    }

    if child_exit_detected {
        let _ = send_frame(
            &out_tx,
            "worker_exited",
            None,
            json!({"code": Value::Null, "signal": Value::Null}),
        )
        .await;
    }
    let _ = pty.shutdown();
    if !child_exit_detected {
        let _ = send_frame(
            &out_tx,
            "worker_exited",
            None,
            json!({"code": Value::Null, "signal": Value::Null}),
        )
        .await;
    }
    drop(out_tx);
    let _ = writer_task.await;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_defaults_to_bulk_injection() {
        assert_eq!(resolve_inject_rate("codex", None), Duration::ZERO);
        assert_eq!(
            resolve_inject_rate("/usr/local/bin/codex", None),
            Duration::ZERO
        );
        assert_eq!(
            resolve_inject_rate(r"C:\tools\codex.exe", None),
            Duration::ZERO
        );
    }

    #[test]
    fn non_codex_clis_keep_paced_injection_default() {
        assert_eq!(
            resolve_inject_rate("claude", None),
            Duration::from_millis(DEFAULT_INJECT_RATE_MS)
        );
        assert_eq!(
            resolve_inject_rate("gemini", Some("invalid")),
            Duration::from_millis(DEFAULT_INJECT_RATE_MS)
        );
        assert_eq!(
            resolve_inject_rate("opencode", Some("  ")),
            Duration::from_millis(DEFAULT_INJECT_RATE_MS)
        );
    }

    #[test]
    fn explicit_inject_rate_overrides_cli_default() {
        assert_eq!(
            resolve_inject_rate("codex", Some("7")),
            Duration::from_millis(7)
        );
        assert_eq!(resolve_inject_rate("claude", Some("0")), Duration::ZERO);
    }

    #[test]
    fn codex_agent_relay_boot_expected_when_configured() {
        let args = vec![
            "--config".to_string(),
            "mcp_servers.agent-relay.command=npx".to_string(),
        ];
        assert!(codex_agent_relay_boot_expected("codex", &args));
        assert!(!codex_agent_relay_boot_expected("claude", &args));
    }

    #[test]
    fn output_has_prompt_detects_codex_glyph_prompt() {
        assert!(output_has_prompt("codex", "Boot complete\n› "));
    }

    #[test]
    fn startup_gate_requires_visible_post_boot_prompt() {
        let startup_output = "Welcome\n› ";
        let post_boot_output = "done\n› ";
        let loading_grid = GridReadinessSnapshot {
            screen: "MCP loading...\n",
            cursor: Some((1, 15)),
        };
        assert!(!evaluate_startup_gate(
            "codex",
            startup_output,
            startup_output.len(),
            true,
            true,
            post_boot_output,
            loading_grid,
        ));

        let ready_grid = GridReadinessSnapshot {
            screen: "done\n› \n",
            cursor: Some((2, 3)),
        };
        assert!(!evaluate_startup_gate(
            "codex",
            startup_output,
            startup_output.len(),
            true,
            false,
            post_boot_output,
            ready_grid,
        ));
        assert!(!evaluate_startup_gate(
            "codex",
            startup_output,
            startup_output.len(),
            true,
            true,
            "MCP loading...",
            ready_grid,
        ));
        assert!(evaluate_startup_gate(
            "codex",
            startup_output,
            startup_output.len(),
            true,
            true,
            post_boot_output,
            ready_grid,
        ));
    }

    #[test]
    fn startup_gate_uses_ready_detection_when_agent_relay_boot_not_required() {
        assert!(evaluate_startup_gate(
            "claude",
            "",
            20,
            false,
            false,
            "",
            GridReadinessSnapshot {
                screen: "Welcome back Khaliq!\n>\n",
                cursor: Some((2, 2)),
            },
        ));
        assert!(evaluate_startup_gate(
            "aider",
            "",
            20,
            false,
            false,
            "",
            GridReadinessSnapshot {
                screen: "Ready\n> \n",
                cursor: Some((2, 3)),
            },
        ));
    }

    #[test]
    fn startup_gate_rejects_codex_directory_trust_menu() {
        let trust_screen = "Do you trust the contents of this directory?\n\
                            › 1. Yes, continue\n\
                              2. No, quit\n\
                            Press enter to continue";
        assert!(!evaluate_startup_gate(
            "codex",
            trust_screen,
            600,
            false,
            false,
            "",
            GridReadinessSnapshot {
                screen: trust_screen,
                cursor: Some((2, 1)),
            },
        ));
    }

    #[tokio::test]
    async fn unrecognised_prompt_releases_queued_work_after_the_deadline() {
        // The 2026-08-15 fleet outage. `claude_grid_ready` requires the literal
        // "Welcome back" / "Welcome to " greeting, and Claude Code stopped
        // rendering it on routine launches — three consecutive live launches on
        // finn-mini showed a composer and no banner. With no deadline, readiness
        // was never proven, `initial_tasks` was never released, and every
        // spawned agent sat idle holding a brief it was never handed.
        //
        // Detection is heuristic against a vendor TUI. It must not be the only
        // thing standing between a spawn and its task.
        let (tx, mut rx) = mpsc::channel(2);
        let mut request_id = None;
        let started = Instant::now() - STARTUP_READY_TIMEOUT - Duration::from_secs(1);
        let mut readiness = StartupReadinessState::default();

        try_emit_worker_ready(
            &tx,
            "unrecognised-prompt",
            Some(42),
            &mut request_id,
            Some(started),
            &mut readiness,
            StartupGate::Unrecognised,
        )
        .await;

        assert!(
            readiness.ready_sent,
            "past the deadline the brief must go out; a held brief is a total loss"
        );
        let frame = rx.try_recv().expect("worker_ready must be emitted");
        assert_eq!(frame.msg_type, "worker_ready");
    }

    #[tokio::test]
    async fn a_blocking_dialog_is_never_timed_out_past() {
        // Must-not-fire. The deadline exists for a prompt we FAILED TO
        // RECOGNISE; it must never fire past a dialog the gate deliberately
        // vetoed. Codex's directory-trust interstitial is the case in point:
        // releasing the brief into it would answer a security question on the
        // operator's behalf. Raised in review on relay#1529 by two reviewers
        // independently, and they were right — the first cut conflated
        // "unrecognised" with "blocked".
        let (tx, mut rx) = mpsc::channel(2);
        let mut request_id = None;
        let started = Instant::now() - STARTUP_READY_TIMEOUT - Duration::from_secs(60);
        let mut readiness = StartupReadinessState::default();

        try_emit_worker_ready(
            &tx,
            "trust-menu-worker",
            Some(42),
            &mut request_id,
            Some(started),
            &mut readiness,
            StartupGate::Blocked,
        )
        .await;

        assert!(
            !readiness.ready_sent,
            "a deliberate veto must outlast any deadline"
        );
        assert!(
            rx.try_recv().is_err(),
            "no worker_ready frame may escape a trust prompt"
        );
    }

    #[tokio::test]
    async fn startup_warning_preserves_work_until_real_readiness() {
        let (tx, mut rx) = mpsc::channel(2);
        let mut request_id = None;
        let started = Instant::now() - STARTUP_READY_WARNING - Duration::from_secs(1);
        let mut readiness = StartupReadinessState::default();

        try_emit_worker_ready(
            &tx,
            "slow-worker",
            Some(42),
            &mut request_id,
            Some(started),
            &mut readiness,
            StartupGate::Unrecognised,
        )
        .await;

        assert!(
            readiness.wait_warned,
            "slow startup should emit its one diagnostic"
        );
        assert!(
            !readiness.ready_sent,
            "elapsed time is not proof of a ready prompt"
        );
        assert!(rx.try_recv().is_err(), "no worker_ready frame may escape");

        try_emit_worker_ready(
            &tx,
            "slow-worker",
            Some(42),
            &mut request_id,
            Some(started),
            &mut readiness,
            StartupGate::Ready,
        )
        .await;

        let frame = rx.try_recv().expect("proven readiness should emit a frame");
        assert_eq!(frame.msg_type, "worker_ready");
        assert!(readiness.ready_sent);
    }

    #[tokio::test]
    async fn harness_liveness_is_reported_without_claiming_input_readiness() {
        let (tx, mut rx) = mpsc::channel(1);

        emit_harness_started(&tx, "slow-worker", Some(42)).await;

        let frame = rx.try_recv().expect("harness_started frame");
        assert_eq!(frame.msg_type, "harness_started");
        assert_eq!(frame.payload["name"], "slow-worker");
        assert_eq!(frame.payload["runtime"], "pty");
        assert_eq!(frame.payload["pid"], 42);
    }

    #[test]
    fn should_block_pending_injection_wait_mode_when_suggestion_visible() {
        let pending = PendingWorkerInjection {
            delivery: RelayDelivery {
                delivery_id: "del_1".into(),
                event_id: "evt_1".into(),
                workspace_id: None,
                workspace_alias: None,
                from: "Lead".into(),
                target: "Worker".into(),
                body: "hello".into(),
                thread_id: None,
                priority: None,
                injection_mode: MessageInjectionMode::Wait,
            },
            request_id: None,
            queued_at: Instant::now(),
        };

        assert!(should_block_pending_injection(true, &pending));
        assert!(!should_block_pending_injection(false, &pending));
    }

    #[test]
    fn should_not_block_pending_injection_for_steer_mode() {
        let pending = PendingWorkerInjection {
            delivery: RelayDelivery {
                delivery_id: "del_2".into(),
                event_id: "evt_2".into(),
                workspace_id: None,
                workspace_alias: None,
                from: "Lead".into(),
                target: "Worker".into(),
                body: "interrupt".into(),
                thread_id: None,
                priority: None,
                injection_mode: MessageInjectionMode::Steer,
            },
            request_id: None,
            queued_at: Instant::now(),
        };

        assert!(!should_block_pending_injection(true, &pending));
    }

    #[test]
    fn injection_pop_gated_by_hold_and_active_injection() {
        // Free loop, no hold: may start the next injection.
        assert!(injection_pop_allowed(false, false, 0));
        // An injection is already in flight: wait for it to finish.
        assert!(!injection_pop_allowed(true, false, 0));
        // Interactive hold active (human driving): keep deliveries parked —
        // they are not popped, so nothing is dropped while held.
        assert!(!injection_pop_allowed(false, true, 0));
        assert!(!injection_pop_allowed(true, true, 0));
    }

    #[test]
    fn injected_output_commands_are_suppressed_through_injection_lifecycle() {
        // (active_injection_present, pending_verifications_empty): detection is
        // allowed only when no injection is active and no verification is pending.
        assert!(injected_output_command_detection_allowed(false, true));
        assert!(!injected_output_command_detection_allowed(true, true));
        assert!(!injected_output_command_detection_allowed(false, false));
        assert!(!injected_output_command_detection_allowed(true, false));
    }

    #[test]
    fn injection_pop_allowed_through_hold_with_flush_exemption() {
        // An explicit `flush_injections` allowance lets pops pierce the hold…
        assert!(injection_pop_allowed(false, true, 1));
        assert!(injection_pop_allowed(false, true, 3));
        // …but never preempts an injection already in flight.
        assert!(!injection_pop_allowed(true, true, 1));
        // Exemption is irrelevant when no hold is active.
        assert!(injection_pop_allowed(false, false, 1));
    }

    fn test_pending_injection(event_id: &str) -> PendingWorkerInjection {
        PendingWorkerInjection {
            delivery: RelayDelivery {
                delivery_id: format!("del_{event_id}").into(),
                event_id: event_id.into(),
                workspace_id: None,
                workspace_alias: None,
                from: "Lead".into(),
                target: "Worker".into(),
                body: "hello".into(),
                thread_id: None,
                priority: None,
                injection_mode: MessageInjectionMode::Wait,
            },
            request_id: None,
            queued_at: Instant::now(),
        }
    }

    #[test]
    fn targeted_flush_releases_only_its_own_delivery_through_the_hold() {
        // A supervised restart keeps unacknowledged deliveries, so a retried
        // relay message can be queued ahead of the (re)spawn's initial task.
        // The targeted flush must reach past it — and leave it parked.
        let pending: VecDeque<PendingWorkerInjection> = [
            test_pending_injection("evt_relay"),
            test_pending_injection("init_task"),
        ]
        .into();
        let targeted = HashSet::from(["init_task".to_string()]);

        assert_eq!(
            next_injection_index(&pending, false, true, 0, &targeted),
            Some(1)
        );
        // Nothing targeted: the whole queue stays parked under the hold.
        assert_eq!(
            next_injection_index(&pending, false, true, 0, &HashSet::new()),
            None
        );
        // A blanket flush still drains from the front, in order.
        assert_eq!(
            next_injection_index(&pending, false, true, 2, &HashSet::new()),
            Some(0)
        );
        // Unheld, the target is irrelevant — normal FIFO order applies.
        assert_eq!(
            next_injection_index(&pending, false, false, 0, &targeted),
            Some(0)
        );
        // An injection already in flight is never preempted, targeted or not.
        assert_eq!(
            next_injection_index(&pending, true, true, 0, &targeted),
            None
        );
        // An empty queue has nothing to start.
        assert_eq!(
            next_injection_index(&VecDeque::new(), false, false, 0, &targeted),
            None
        );
    }

    #[test]
    fn requeued_targeted_exemption_returns_to_its_event_id() {
        // A failed write requeues the injection. A targeted exemption must go
        // back to the event-id set — turning it into a blanket allowance would
        // let the next queued relay message spend it and splice into the hold.
        let mut count = 0usize;
        let mut event_ids = HashSet::new();
        let targeted = ActiveInjection {
            pending: test_pending_injection("init_task"),
            stage: InjectionStage::Escape,
            next_at: tokio::time::Instant::now(),
            injection_text: None,
            output_boundary: None,
            hold_exempt: true,
            targeted_hold_exemption: true,
        };
        restore_hold_exemption(&targeted, &mut count, &mut event_ids);
        assert_eq!(count, 0);
        assert!(event_ids.contains("init_task"));

        // A blanket exemption still goes back to the counter.
        let blanket = ActiveInjection {
            targeted_hold_exemption: false,
            ..targeted
        };
        let mut event_ids = HashSet::new();
        restore_hold_exemption(&blanket, &mut count, &mut event_ids);
        assert_eq!(count, 1);
        assert!(event_ids.is_empty());

        // An injection popped without any exemption restores nothing.
        let unexempt = ActiveInjection {
            hold_exempt: false,
            ..blanket
        };
        restore_hold_exemption(&unexempt, &mut count, &mut event_ids);
        assert_eq!(count, 1);
        assert!(event_ids.is_empty());
    }

    #[test]
    fn blanket_flush_does_not_downgrade_an_in_flight_targeted_exemption() {
        // A blanket `flush_injections` landing while the targeted initial task is
        // in flight must not turn its exemption into a shared allowance: a later
        // requeue would then hand the credit to whatever else is queued instead
        // of back to this delivery.
        let mut injection = ActiveInjection {
            pending: test_pending_injection("init_task"),
            stage: InjectionStage::Escape,
            next_at: tokio::time::Instant::now(),
            injection_text: None,
            output_boundary: None,
            hold_exempt: true,
            targeted_hold_exemption: true,
        };
        // What the blanket branch does to an already-exempt in-flight injection.
        injection.hold_exempt = true;

        let mut count = 0usize;
        let mut event_ids = HashSet::new();
        restore_hold_exemption(&injection, &mut count, &mut event_ids);
        assert_eq!(
            count, 0,
            "targeted exemption must not become blanket credit"
        );
        assert!(event_ids.contains("init_task"));
    }

    #[test]
    fn injection_body_enter_ack_finalizes_when_confirmed() {
        // Combined Body+Enter write confirmed (stage advanced to Finalize) →
        // emit injected.
        assert_eq!(
            injection_ack_outcome(InjectionStage::Finalize, true),
            InjectionAckOutcome::Finalize
        );
    }

    #[test]
    fn injection_failed_body_enter_ack_requeues_without_finalizing() {
        // A failed Body+Enter ack must NOT finalize — the bytes never
        // reached the child, so requeue rather than confirm injection.
        assert_eq!(
            injection_ack_outcome(InjectionStage::Finalize, false),
            InjectionAckOutcome::Requeue
        );
    }

    #[test]
    fn injection_ack_for_non_write_stage_requeues() {
        // Stages that await no ack should never be finalized off a stray ack.
        assert_eq!(
            injection_ack_outcome(InjectionStage::Escape, true),
            InjectionAckOutcome::Requeue
        );
        assert_eq!(
            injection_ack_outcome(InjectionStage::Body, true),
            InjectionAckOutcome::Requeue
        );
    }

    #[test]
    fn echo_arriving_before_worker_write_ack_is_confirmed_immediately() {
        let injection = "From: Lead\nReview this change";
        let mut output = VerificationOutput::default();
        output.push_output(1, b"older output\n");
        // Sequence 2 was assigned by the reader before the write was queued,
        // but this worker has not consumed that matching chunk yet.
        let output_boundary = 2;
        let verification = || PendingVerification {
            delivery_id: "del_echo_before_ack".into(),
            event_id: "evt_echo_before_ack".into(),
            expected_echo: injection.to_string(),
            output_boundary,
            injected_at: Instant::now(),
            attempts: 1,
            max_attempts: 1,
            request_id: None,
            workspace_id: None,
            workspace_alias: None,
            from: "Lead".to_string(),
            body: "Review this change".to_string(),
            target: "Worker".into(),
        };
        let mut pending_verifications = VecDeque::new();

        output.push_output(2, format!("stale composer echo: {injection}").as_bytes());

        let stale = queue_or_take_confirmed_verification(
            verification(),
            &output,
            &mut pending_verifications,
        );
        assert!(stale.is_none(), "a retained pre-submission echo is stale");
        pending_verifications.clear();

        output.push_output(
            3,
            format!("\nnew composer echo: {injection}\nTool: Write(review.md)").as_bytes(),
        );
        let confirmed = queue_or_take_confirmed_verification(
            verification(),
            &output,
            &mut pending_verifications,
        )
        .expect("the buffered echo must be confirmed");

        assert!(
            pending_verifications.is_empty(),
            "an already-observed echo must not be queued to time out"
        );
        let mut pending_activities = VecDeque::new();
        let (_, pattern) = queue_or_take_detected_activity(
            &confirmed,
            &output,
            &ActivityDetector::for_cli("claude"),
            &mut pending_activities,
        )
        .expect("activity buffered before the ack must be detected immediately");
        assert_eq!(pattern, "Tool:");
        assert!(pending_activities.is_empty());
    }

    #[test]
    fn detects_context_budget_percentage() {
        assert_eq!(detect_context_budget_pct("Context 6% left"), Some(6));
        assert_eq!(detect_context_budget_pct("context 100% left"), Some(100));
        assert_eq!(
            detect_context_budget_pct("Context 7% left\nContext 12% left"),
            Some(12)
        );
        assert_eq!(detect_context_budget_pct("context 125% left"), Some(100));
        assert_eq!(detect_context_budget_pct("no budget here"), None);
    }
}
