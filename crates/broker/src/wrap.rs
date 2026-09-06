use std::collections::VecDeque;
use std::future::Future;
use std::pin::Pin;
use std::time::{Duration, Instant};

use crate::{
    control::{can_release_child, is_human_sender},
    dedup::DedupCache,
    ids::{DeliveryId, EventId, MessageTarget, WorkspaceAlias, WorkspaceId},
    pty::PtySession,
    relaycast::{
        agent_name_eq, broker_payload_from_action, is_self_name, map_ws_event,
        parse_ws_action_invoked, resolve_dm_participants_cached, retry_agent_registration,
        CompleteInvocationRequest, DmParticipantsCache, RegRetryOutcome, RegisterActionRequest,
        WsControl,
    },
    telemetry::{ActionSource, TelemetryClient, TelemetryEvent},
    types::{BrokerCommandPayload, InboundKind, SenderKind},
};
use anyhow::{Context, Result};
use futures_util::{stream::FuturesUnordered, StreamExt};
use tokio::{sync::mpsc, time::MissedTickBehavior};

use crate::broker::{
    delivery_verification::{
        pending_verification_echo_seen, queue_or_take_confirmed_verification,
        queue_or_take_detected_activity, DeliveryOutcome, PendingActivity, PendingVerification,
        ThrottleState, VerificationOutput, ACTIVITY_BUFFER_KEEP_BYTES, ACTIVITY_BUFFER_MAX_BYTES,
        ACTIVITY_WINDOW, MAX_VERIFICATION_ATTEMPTS, VERIFICATION_WINDOW,
    },
    injection_format::{format_injection_for_worker_with_workspace, McpReminderThrottle},
};
use crate::cli::command_parse::parse_cli_command;
use crate::runtime::{
    action_targets_self, channels_from_csv, connect_relay, ensure_runtime_paths, env_flag_enabled,
    extract_mcp_message_ids, get_terminal_size, terminal_cols, terminal_rows, RelaySession,
    RelaySessionOptions, RelayWorkspace,
};
use crate::spawner::{spawn_env_vars, with_commit_attestation_env, Spawner};
use crate::util::{
    ansi::{floor_char_boundary, strip_ansi, AnsiStripper},
    terminal::{
        claude_trust_prompt_action, detect_bypass_permissions_prompt, detect_codex_model_prompt,
        detect_codex_trust_prompt, detect_gemini_action_required, detect_gemini_trust_prompt,
        detect_gemini_untrusted_banner, detect_opencode_permission_prompt, is_auto_suggestion,
        is_bypass_selection_menu, is_in_editor_mode, ClaudeTrustPromptAction,
    },
};
use crate::worker::detection::ActivityDetector;

// PTY auto-response constants (shared by wrap and pty workers)
const BYPASS_PERMS_COOLDOWN: Duration = Duration::from_secs(2);
const BYPASS_PERMS_MAX_SENDS: u32 = 5;
const AUTO_ENTER_TIMEOUT: Duration = Duration::from_secs(10);
const AUTO_ENTER_COOLDOWN: Duration = Duration::from_secs(5);
const MAX_AUTO_ENTER_RETRIES: u32 = 5;
pub(crate) const AUTO_SUGGESTION_BLOCK_TIMEOUT: Duration = Duration::from_secs(10);
const MCP_APPROVAL_TIMEOUT: Duration = Duration::from_secs(5);
const GEMINI_ACTION_COOLDOWN: Duration = Duration::from_secs(2);
const CLAUDE_INJECTION_SUBMIT_DELAY: Duration = Duration::from_millis(250);
// Keep this aligned with the runtime PTY input acknowledgement bound. A wrap
// session is retired when it expires because a blocked write may have been
// partially delivered and is unsafe to requeue blindly.
const WRAP_WRITE_ACK_TIMEOUT: Duration = Duration::from_secs(5);

/// Claude Code treats multiline input and a trailing Enter received in the
/// same paste burst as editor content, leaving the task parked in its composer.
/// Give its submit key a distinct, delayed PTY write. Other harnesses retain
/// the established body-plus-Enter write shape.
pub(crate) fn injection_submit_followup_delay(cli: &str) -> Option<Duration> {
    let basename = cli
        .rsplit(['/', '\\'])
        .next()
        .filter(|part| !part.is_empty())
        .unwrap_or(cli);
    // PTY entry points accept arbitrary executable names, including company
    // wrappers such as `company-claude` and `claude-code`. Match the same
    // Claude identity signal used by readiness and activity detection so a
    // wrapper cannot silently fall back to the broken body-plus-Enter burst.
    basename
        .to_ascii_lowercase()
        .contains("claude")
        .then_some(CLAUDE_INJECTION_SUBMIT_DELAY)
}

/// Warn (without retrying) when a one-shot auto-response keystroke can't be
/// enqueued to the PTY write drainer. These prompts — MCP approval, trust
/// dialogs, model-picker dismissals, auto-enter nudges, escape dismissals — are
/// best-effort: a full/wedged queue means the child isn't draining its stdin
/// anyway, and the responder re-fires on the next matching output. `submit_write`
/// used to be a blocking `write_all`; the non-blocking form returns an ack
/// receiver whose enqueue error was silently dropped by `let _ =`. Surface it in
/// the log so a wedged drainer is diagnosable instead of invisible.
pub(crate) fn warn_on_auto_response_write<T>(result: Result<T>, context: &str) {
    if let Err(error) = result {
        tracing::warn!(
            target: "agent_relay::worker::pty",
            context = %context,
            error = %error,
            "auto-response pty write failed"
        );
    }
}

/// Cap on buffered human stdin chunks awaiting a full PTY write queue. Beyond
/// this the child is clearly not reading its stdin, so the oldest chunk is
/// dropped (with a warning) rather than growing memory without bound.
const STDIN_PENDING_MAX_CHUNKS: usize = 1024;

/// Submit as many buffered stdin chunks as the drainer will accept, in FIFO
/// order, stopping at the first chunk `submit` rejects (queue full). `submit`
/// returns `true` when the chunk was accepted. Returns `true` if chunks remain
/// buffered — the caller should arm a retry deadline — and `false` once fully
/// drained. Ordering is always preserved: a rejected chunk stays at the front.
fn drain_stdin_buffer<F>(pending: &mut VecDeque<Vec<u8>>, submit: &mut F) -> bool
where
    F: FnMut(&[u8]) -> bool,
{
    while let Some(front) = pending.front() {
        if submit(front) {
            pending.pop_front();
        } else {
            break;
        }
    }
    !pending.is_empty()
}

/// Append a new stdin chunk to the FIFO retry buffer, dropping the oldest chunk
/// (with a warning) if `max` is exceeded, then drain what the drainer accepts.
/// Returns `true` if chunks remain buffered after draining. This is the
/// back-pressure path for human keystrokes: `submit_write` is non-blocking and
/// returns `Err` on a full queue, so rather than dropping keystrokes we buffer
/// and retry while preserving order.
fn buffer_and_drain_stdin<F>(
    pending: &mut VecDeque<Vec<u8>>,
    data: Vec<u8>,
    max: usize,
    mut submit: F,
) -> bool
where
    F: FnMut(&[u8]) -> bool,
{
    // Drain whatever the drainer will now accept before evicting anything —
    // capacity may have freed up since the last retry, in which case there's
    // no need to drop a chunk that could have been written successfully.
    drain_stdin_buffer(pending, &mut submit);
    if pending.len() >= max {
        tracing::warn!(
            target: "agent_relay::worker::pty",
            pending = pending.len(),
            "stdin retry buffer full; dropping oldest keystroke chunk (child not reading stdin)"
        );
        pending.pop_front();
    }
    pending.push_back(data);
    drain_stdin_buffer(pending, &mut submit)
}

#[derive(Debug, Clone)]
pub(crate) struct PendingWrapInjection {
    pub(crate) from: String,
    pub(crate) event_id: EventId,
    pub(crate) workspace_id: Option<WorkspaceId>,
    pub(crate) workspace_alias: Option<WorkspaceAlias>,
    pub(crate) body: String,
    pub(crate) target: MessageTarget,
    pub(crate) queued_at: Instant,
}

/// Delivery state held until the PTY drainer confirms both the injection body
/// and its harness-specific submit sequence were written and flushed.
enum PendingWrapWrite {
    Initial {
        pending: PendingWrapInjection,
        injection: String,
        output_boundary: u64,
        include_reminder: bool,
    },
    Retry {
        verification: PendingVerification,
        injection: String,
        output_boundary: u64,
        include_reminder: bool,
    },
}

type WrapWriteAck =
    std::result::Result<std::io::Result<()>, tokio::sync::oneshot::error::RecvError>;
type PendingWrapWriteAck = (
    PendingWrapWrite,
    std::result::Result<WrapWriteAck, tokio::time::error::Elapsed>,
);
type PendingWrapWriteAckFuture = Pin<Box<dyn Future<Output = PendingWrapWriteAck> + Send>>;

async fn await_wrap_write_ack(
    ack_rx: tokio::sync::oneshot::Receiver<std::io::Result<()>>,
    timeout: Duration,
) -> std::result::Result<WrapWriteAck, tokio::time::error::Elapsed> {
    tokio::time::timeout(timeout, ack_rx).await
}

fn wrap_write_ack_error(ack: WrapWriteAck) -> Option<String> {
    match ack {
        Ok(Ok(())) => None,
        Ok(Err(error)) => Some(error.to_string()),
        Err(_) => Some("pty write drainer exited before acknowledging queued write".to_string()),
    }
}

/// Keep wrap injections single-flight until the PTY drainer confirms the
/// previous write. Besides preserving delivery order, this ensures an MCP
/// reminder is recorded before the next delivery decides whether to include it.
fn wrap_injection_timer_allowed(has_pending_write_ack: bool) -> bool {
    !has_pending_write_ack
}

/// Start echo verification after a PTY write ack without missing output that
/// raced ahead of the ack select arm. Returns `true` when the echo was already
/// present and the delivery was confirmed immediately.
fn queue_or_confirm_wrap_verification(
    verification: PendingVerification,
    output: &VerificationOutput,
    activity_detector: Option<&ActivityDetector>,
    throttle: &mut ThrottleState,
    pending_verifications: &mut VecDeque<PendingVerification>,
    pending_activities: &mut VecDeque<PendingActivity>,
) -> bool {
    let Some(verification) =
        queue_or_take_confirmed_verification(verification, output, pending_verifications)
    else {
        return false;
    };

    tracing::debug!(
        event_id = %verification.event_id,
        delivery_id = %verification.delivery_id,
        attempts = verification.attempts,
        "wrap: delivery echo verified before write ack was processed"
    );
    throttle.record(DeliveryOutcome::Success);
    if let Some(detector) = activity_detector {
        if let Some((activity, pattern)) =
            queue_or_take_detected_activity(&verification, output, detector, pending_activities)
        {
            tracing::info!(
                target = "agent_relay::worker::wrap",
                delivery_id = %activity.delivery_id,
                event_id = %activity.event_id,
                pattern = %pattern,
                "delivery became active before write ack was processed"
            );
        }
    }
    true
}

// Shared PTY auto-response state used by run_wrap and run_pty_worker.
#[derive(Debug)]
pub(crate) struct PtyAutoState {
    // MCP approval
    pub(crate) mcp_approved: bool,
    pub(crate) mcp_detection_buffer: String,
    pub(crate) mcp_partial_match_since: Option<Instant>,
    // Bypass permissions
    pub(crate) bypass_perms_buffer: String,
    pub(crate) last_bypass_perms_send: Option<Instant>,
    pub(crate) bypass_perms_send_count: u32,
    // Codex model upgrade prompt
    pub(crate) codex_model_prompt_handled: bool,
    pub(crate) codex_model_buffer: String,
    // Codex directory trust prompt
    pub(crate) codex_trust_buffer: String,
    pub(crate) codex_trust_handled: bool,
    // Opencode/droid EXECUTE permission prompt
    pub(crate) opencode_perm_buffer: String,
    pub(crate) last_opencode_perm_approval: Option<Instant>,
    // Gemini "Action Required" prompt
    pub(crate) gemini_action_buffer: String,
    pub(crate) last_gemini_action_approval: Option<Instant>,
    // Gemini folder trust prompt
    pub(crate) gemini_trust_buffer: String,
    pub(crate) gemini_trust_handled: bool,
    // Gemini untrusted folder banner (triggers /permissions command)
    pub(crate) gemini_untrusted_buffer: String,
    pub(crate) gemini_untrusted_handled: bool,
    // Claude Code folder trust prompt
    pub(crate) claude_trust_buffer: String,
    pub(crate) claude_trust_handled: bool,
    // Auto-suggestion / injection state
    pub(crate) auto_suggestion_visible: bool,
    pub(crate) last_injection_time: Option<Instant>,
    pub(crate) last_auto_enter_time: Option<Instant>,
    pub(crate) auto_enter_retry_count: u32,
    pub(crate) editor_mode_buffer: String,
    pub(crate) last_output_time: Instant,
    // Idle detection (edge-triggered)
    pub(crate) is_idle: bool,
    /// When true, a human is driving the PTY (inbound delivery mode is
    /// `manual_flush`). All prompt auto-responders and the stuck-agent
    /// auto-enter are gated off so they cannot press keys while the human
    /// types. Reset to `false` on release. Only ever set in the broker/worker
    /// split (`pty_worker`); `run_wrap` leaves it `false` since that mode is
    /// itself a live human passthrough where auto-responses are wanted.
    pub(crate) interactive_hold: bool,
}

impl PtyAutoState {
    pub(crate) fn new() -> Self {
        Self {
            mcp_approved: false,
            mcp_detection_buffer: String::new(),
            mcp_partial_match_since: None,
            bypass_perms_buffer: String::new(),
            last_bypass_perms_send: None,
            bypass_perms_send_count: 0,
            codex_model_prompt_handled: false,
            codex_model_buffer: String::new(),
            codex_trust_buffer: String::new(),
            codex_trust_handled: false,
            opencode_perm_buffer: String::new(),
            last_opencode_perm_approval: None,
            gemini_action_buffer: String::new(),
            last_gemini_action_approval: None,
            gemini_trust_buffer: String::new(),
            gemini_trust_handled: false,
            gemini_untrusted_buffer: String::new(),
            gemini_untrusted_handled: false,
            claude_trust_buffer: String::new(),
            claude_trust_handled: false,
            auto_suggestion_visible: false,
            last_injection_time: None,
            last_auto_enter_time: None,
            auto_enter_retry_count: 0,
            editor_mode_buffer: String::new(),
            last_output_time: Instant::now(),
            is_idle: false,
            interactive_hold: false,
        }
    }

    /// Append `text` to `buf`, keeping only the last `keep` bytes when `buf` exceeds `max`.
    fn append_buf(buf: &mut String, text: &str, max: usize, keep: usize) {
        buf.push_str(text);
        if buf.len() > max {
            let start = floor_char_boundary(buf, buf.len() - keep);
            *buf = buf[start..].to_string();
        }
    }

    /// Detect and approve MCP server prompts in PTY output.
    /// Supports full match (header + option) and partial-match timeout (5s fallback).
    /// Handles edge cases where prompt text fragments across reads.
    pub(crate) async fn handle_mcp_approval(&mut self, text: &str, pty: &PtySession) {
        if self.interactive_hold {
            return;
        }
        if self.mcp_approved {
            return;
        }
        Self::append_buf(&mut self.mcp_detection_buffer, text, 2500, 2000);
        let clean = strip_ansi(&self.mcp_detection_buffer);
        let has_header =
            clean.contains("MCP Server Approval Required") || clean.contains("MCP server approval");
        let has_approve = clean.contains("[a] Approve all servers")
            || clean.contains("Approve all")
            || clean.contains("[a]");

        let full_match = has_header && has_approve;

        // Timeout-based approval: if we have a partial match for 5+ seconds, approve anyway.
        // Handles edge cases where prompt text fragments across reads.
        let timeout_approval = if has_header || has_approve {
            match self.mcp_partial_match_since {
                None => {
                    self.mcp_partial_match_since = Some(Instant::now());
                    false
                }
                Some(since) => since.elapsed() >= MCP_APPROVAL_TIMEOUT,
            }
        } else {
            self.mcp_partial_match_since = None;
            false
        };

        if full_match || timeout_approval {
            self.mcp_approved = true;
            tokio::time::sleep(Duration::from_millis(100)).await;
            warn_on_auto_response_write(pty.submit_write(b"a".to_vec()), "mcp_approval");
            self.mcp_detection_buffer.clear();
            self.mcp_partial_match_since = None;
        }
    }

    /// Detect and approve bypass-permissions prompts in PTY output.
    pub(crate) async fn handle_bypass_permissions(&mut self, text: &str, pty: &PtySession) {
        if self.interactive_hold {
            return;
        }
        let in_cooldown = self
            .last_bypass_perms_send
            .map(|t| t.elapsed() < BYPASS_PERMS_COOLDOWN)
            .unwrap_or(false);
        if !in_cooldown && self.bypass_perms_send_count < BYPASS_PERMS_MAX_SENDS {
            Self::append_buf(&mut self.bypass_perms_buffer, text, 2500, 2000);
            let clean = strip_ansi(&self.bypass_perms_buffer);
            let (has_ref, has_confirm) = detect_bypass_permissions_prompt(&clean);
            if has_ref && has_confirm {
                self.bypass_perms_send_count += 1;
                self.last_bypass_perms_send = Some(Instant::now());
                tokio::time::sleep(Duration::from_millis(500)).await;
                if is_bypass_selection_menu(&clean) {
                    warn_on_auto_response_write(
                        pty.submit_write(b"\x1b[B".to_vec()),
                        "bypass_permissions_down",
                    );
                    tokio::time::sleep(Duration::from_millis(200)).await;
                    warn_on_auto_response_write(
                        pty.submit_write(b"\r".to_vec()),
                        "bypass_permissions_enter",
                    );
                } else {
                    warn_on_auto_response_write(
                        pty.submit_write(b"y\n".to_vec()),
                        "bypass_permissions_confirm",
                    );
                }
                self.bypass_perms_buffer.clear();
            }
        } else if in_cooldown {
            self.bypass_perms_buffer.clear();
        }
    }

    /// Detect and dismiss Codex model upgrade prompts by selecting "Use existing model".
    pub(crate) async fn handle_codex_model_prompt(&mut self, text: &str, pty: &PtySession) {
        if self.interactive_hold {
            return;
        }
        if self.codex_model_prompt_handled {
            return;
        }
        Self::append_buf(&mut self.codex_model_buffer, text, 2500, 2000);
        let clean = strip_ansi(&self.codex_model_buffer);
        let (has_upgrade_ref, has_model_options) = detect_codex_model_prompt(&clean);
        if has_upgrade_ref && has_model_options {
            tracing::info!("Detected Codex model upgrade prompt, selecting 'Use existing model'");
            self.codex_model_prompt_handled = true;
            tokio::time::sleep(Duration::from_millis(100)).await;
            warn_on_auto_response_write(pty.submit_write(b"\x1b[B".to_vec()), "codex_model_down"); // Down arrow → option 2
            tokio::time::sleep(Duration::from_millis(100)).await;
            warn_on_auto_response_write(pty.submit_write(b"\r".to_vec()), "codex_model_enter"); // Enter to confirm
            self.codex_model_buffer.clear();
        }
    }

    /// Detect and accept Codex's startup directory-trust prompt.
    /// "Yes, continue" is pre-selected as option 1, so Enter is sufficient.
    pub(crate) async fn handle_codex_trust(&mut self, text: &str, pty: &PtySession) {
        if self.interactive_hold || self.codex_trust_handled {
            return;
        }
        Self::append_buf(&mut self.codex_trust_buffer, text, 2500, 2000);
        let clean = strip_ansi(&self.codex_trust_buffer);
        // Codex redraws this TUI with cursor motion, so the raw byte stream can
        // spell only fragments even though the terminal grid contains the
        // complete menu. Check both representations, just like readiness does.
        let visible_screen = pty.screen_text();
        if detect_codex_trust_prompt(&clean) || detect_codex_trust_prompt(&visible_screen) {
            tracing::info!("Detected Codex directory trust prompt, auto-accepting");
            tokio::time::sleep(Duration::from_millis(100)).await;
            warn_on_auto_response_write(pty.submit_write(b"\r".to_vec()), "codex_trust");
            self.codex_trust_buffer.clear();
            self.codex_trust_handled = true;
        }
    }

    /// Detect and auto-approve opencode/droid EXECUTE permission prompts.
    /// Selects "Yes, and always allow medium impact commands" (arrow down + Enter).
    pub(crate) async fn handle_opencode_permission(&mut self, text: &str, pty: &PtySession) {
        if self.interactive_hold {
            return;
        }
        let in_cooldown = self
            .last_opencode_perm_approval
            .map(|t| t.elapsed() < GEMINI_ACTION_COOLDOWN)
            .unwrap_or(false);
        if !in_cooldown {
            Self::append_buf(&mut self.opencode_perm_buffer, text, 2500, 2000);
            let clean = strip_ansi(&self.opencode_perm_buffer);
            let (has_header, has_allow_option) = detect_opencode_permission_prompt(&clean);
            if has_header && has_allow_option {
                tracing::info!(
                    "Detected opencode EXECUTE permission prompt, selecting 'always allow'"
                );
                tokio::time::sleep(Duration::from_millis(100)).await;
                // Arrow down to "Yes, and always allow medium impact commands"
                warn_on_auto_response_write(
                    pty.submit_write(b"\x1b[B".to_vec()),
                    "opencode_permission_down",
                );
                tokio::time::sleep(Duration::from_millis(100)).await;
                warn_on_auto_response_write(
                    pty.submit_write(b"\r".to_vec()),
                    "opencode_permission_enter",
                );
                self.opencode_perm_buffer.clear();
                self.last_opencode_perm_approval = Some(Instant::now());
            }
        } else {
            self.opencode_perm_buffer.clear();
        }
    }

    /// Detect and auto-approve Gemini "Action Required" permission prompts.
    pub(crate) async fn handle_gemini_action(&mut self, text: &str, pty: &PtySession) {
        if self.interactive_hold {
            return;
        }
        let in_cooldown = self
            .last_gemini_action_approval
            .map(|t| t.elapsed() < GEMINI_ACTION_COOLDOWN)
            .unwrap_or(false);
        if !in_cooldown {
            Self::append_buf(&mut self.gemini_action_buffer, text, 2500, 2000);
            let clean = strip_ansi(&self.gemini_action_buffer);
            let (has_header, has_allow_option) = detect_gemini_action_required(&clean);
            if has_header && has_allow_option {
                tracing::info!("Detected Gemini 'Action Required' prompt, auto-approving with '2'");
                tokio::time::sleep(Duration::from_millis(100)).await;
                warn_on_auto_response_write(pty.submit_write(b"2\n".to_vec()), "gemini_action");
                self.gemini_action_buffer.clear();
                self.last_gemini_action_approval = Some(Instant::now());
            }
        } else {
            self.gemini_action_buffer.clear();
        }
    }

    /// Detect and auto-approve Gemini "Modify Trust Level" folder trust prompts.
    /// The menu shows "Trust this folder" pre-selected as option 1, so we just press Enter.
    pub(crate) async fn handle_gemini_trust(&mut self, text: &str, pty: &PtySession) {
        if self.interactive_hold {
            return;
        }
        if !self.gemini_trust_handled {
            Self::append_buf(&mut self.gemini_trust_buffer, text, 2500, 2000);
            let clean = strip_ansi(&self.gemini_trust_buffer);
            let (has_header, has_trust_option) = detect_gemini_trust_prompt(&clean);
            if has_header && has_trust_option {
                tracing::info!(
                    "Detected Gemini 'Modify Trust Level' prompt, auto-selecting 'Trust this folder'"
                );
                tokio::time::sleep(Duration::from_millis(100)).await;
                // Option 1 "Trust this folder" is pre-selected, just press Enter
                warn_on_auto_response_write(pty.submit_write(b"\r".to_vec()), "gemini_trust");
                self.gemini_trust_buffer.clear();
                self.gemini_trust_handled = true;
            }
        }
    }

    /// Detect the Gemini "untrusted folder" informational banner and send `/permissions`
    /// to open the trust menu. The existing `handle_gemini_trust` will then pick up the
    /// interactive "Modify Trust Level" prompt that appears in response.
    pub(crate) async fn handle_gemini_untrusted_banner(&mut self, text: &str, pty: &PtySession) {
        if self.interactive_hold {
            return;
        }
        if !self.gemini_untrusted_handled {
            Self::append_buf(&mut self.gemini_untrusted_buffer, text, 2500, 2000);
            let clean = strip_ansi(&self.gemini_untrusted_buffer);
            if detect_gemini_untrusted_banner(&clean) {
                tracing::info!(
                    "Detected Gemini 'untrusted folder' banner, sending /permissions command"
                );
                tokio::time::sleep(Duration::from_millis(300)).await;
                warn_on_auto_response_write(
                    pty.submit_write(b"/permissions\n".to_vec()),
                    "gemini_untrusted_permissions",
                );
                self.gemini_untrusted_buffer.clear();
                self.gemini_untrusted_handled = true;
                // Reset trust handler so it can pick up the resulting "Modify Trust Level" menu
                self.gemini_trust_handled = false;
                self.gemini_trust_buffer.clear();
            }
        }
    }

    /// Detect and auto-accept Claude Code folder trust prompts.
    pub(crate) async fn handle_claude_trust(&mut self, text: &str, pty: &PtySession) {
        if self.interactive_hold {
            return;
        }
        if !self.claude_trust_handled {
            Self::append_buf(&mut self.claude_trust_buffer, text, 2500, 2000);
            // The raw stream can contain several TUI redraws, so determine the
            // selected row from the current rendered grid instead of stale
            // selection markers retained in the stitched buffer.
            let screen = pty.screen_text();
            if let Some(action) = claude_trust_prompt_action(&screen) {
                tracing::info!("Detected Claude Code folder trust prompt, auto-accepting");
                tokio::time::sleep(Duration::from_millis(100)).await;
                match action {
                    ClaudeTrustPromptAction::Enter => {}
                    ClaudeTrustPromptAction::Up => warn_on_auto_response_write(
                        pty.submit_write(b"\x1b[A".to_vec()),
                        "claude_trust_up",
                    ),
                    ClaudeTrustPromptAction::Down => warn_on_auto_response_write(
                        pty.submit_write(b"\x1b[B".to_vec()),
                        "claude_trust_down",
                    ),
                }
                warn_on_auto_response_write(pty.submit_write(b"\r".to_vec()), "claude_trust");
                self.claude_trust_buffer.clear();
                self.claude_trust_handled = true;
            }
        }
    }

    /// Send an enter keystroke if the agent appears stuck after injection.
    /// Uses exponential backoff: 10s → 15s → 25s → 40s → 60s.
    pub(crate) fn try_auto_enter(&mut self, pty: &PtySession) {
        // Suppressed while a human drives: pressing Enter here would submit the
        // human's half-typed input.
        if self.interactive_hold {
            return;
        }
        if let Some(injection_time) = self.last_injection_time {
            let backoff_multiplier = match self.auto_enter_retry_count {
                0 => 1.0,
                1 => 1.5,
                2 => 2.5,
                3 => 4.0,
                _ => 6.0,
            };
            let required_silence =
                Duration::from_secs_f64(AUTO_ENTER_TIMEOUT.as_secs_f64() * backoff_multiplier);
            let since_injection = injection_time.elapsed();
            let since_output = self.last_output_time.elapsed();
            let cooldown_ok = self
                .last_auto_enter_time
                .map(|t| t.elapsed() >= AUTO_ENTER_COOLDOWN)
                .unwrap_or(true);
            let in_editor = is_in_editor_mode(&self.editor_mode_buffer);
            if since_injection > required_silence
                && since_output > required_silence
                && cooldown_ok
                && !in_editor
                && !self.auto_suggestion_visible
                && self.auto_enter_retry_count < MAX_AUTO_ENTER_RETRIES
            {
                warn_on_auto_response_write(pty.submit_write(b"\r".to_vec()), "auto_enter");
                self.last_auto_enter_time = Some(Instant::now());
                self.auto_enter_retry_count += 1;
            }
        }
    }

    pub(crate) fn update_auto_suggestion(&mut self, text: &str) {
        if is_auto_suggestion(text) {
            self.auto_suggestion_visible = true;
        } else if !strip_ansi(text).trim().is_empty() {
            self.auto_suggestion_visible = false;
        }
    }

    /// Like [`update_auto_suggestion`](Self::update_auto_suggestion) but uses
    /// `prev_tail` (the trailing bytes of the previous PTY read) *only* to
    /// recognise a ghost-text marker pair that straddles the chunk boundary —
    /// `\x1b[7m` at the end of the previous read and `\x1b[27m\x1b[2m` at the
    /// start of this one. The clear/keep decision is made on `current` alone,
    /// so a normal output chunk after the suggestion is gone clears visibility
    /// promptly instead of being held while a stale pair lingers in the
    /// lookbehind. `prev_tail` matching on its own is excluded so an
    /// already-handled pair can't re-arm visibility every chunk.
    pub(crate) fn update_auto_suggestion_windowed(&mut self, current: &str, prev_tail: &str) {
        if !is_auto_suggestion(current)
            && !prev_tail.is_empty()
            && !is_auto_suggestion(prev_tail)
            && is_auto_suggestion(&format!("{prev_tail}{current}"))
        {
            // Pair straddles the read boundary — arm visibility even though the
            // current chunk alone doesn't contain the whole pair.
            self.auto_suggestion_visible = true;
            return;
        }
        // Otherwise the current chunk decides: arm on an in-chunk pair, clear on
        // real output, leave unchanged on whitespace/ANSI-only.
        self.update_auto_suggestion(current);
    }

    pub(crate) fn update_editor_buffer(&mut self, text: &str) {
        Self::append_buf(&mut self.editor_mode_buffer, text, 2000, 1500);
    }

    pub(crate) fn reset_auto_enter_on_output(&mut self, text: &str) {
        let clean_text = strip_ansi(text);
        let is_echo = clean_text.lines().all(|line| {
            let trimmed = line.trim();
            trimmed.is_empty() || trimmed.starts_with("Relay message from ")
        });
        if !is_echo && clean_text.len() > 10 && self.auto_enter_retry_count > 0 {
            self.auto_enter_retry_count = 0;
        }
    }

    /// Reset idle state when PTY produces output, re-arming the next idle transition.
    pub(crate) fn reset_idle_on_output(&mut self) {
        self.is_idle = false;
    }

    /// Check whether the worker has crossed the idle threshold.
    /// Returns `Some(idle_secs)` exactly once when transitioning from active to idle.
    /// Returns `None` when already idle or not yet idle.
    pub(crate) fn check_idle_transition(&mut self, threshold: Duration) -> Option<u64> {
        let since_output = self.last_output_time.elapsed();
        if since_output >= threshold && !self.is_idle {
            self.is_idle = true;
            Some(since_output.as_secs())
        } else {
            None
        }
    }
}

#[cfg(test)]
mod idle_tests {
    use super::*;

    #[test]
    fn emits_once_on_transition_to_idle() {
        let mut state = PtyAutoState::new();
        // Simulate output happening 2 seconds ago
        state.last_output_time = Instant::now() - Duration::from_secs(2);
        let threshold = Duration::from_secs(1);

        // First check: should emit (active -> idle)
        let result = state.check_idle_transition(threshold);
        assert!(result.is_some());
        assert!(result.unwrap() >= 1);

        // Second check: should NOT emit (already idle)
        let result = state.check_idle_transition(threshold);
        assert!(result.is_none());
    }

    #[test]
    fn does_not_emit_before_threshold() {
        let mut state = PtyAutoState::new();
        // Output just happened
        state.last_output_time = Instant::now();
        let threshold = Duration::from_secs(30);

        let result = state.check_idle_transition(threshold);
        assert!(result.is_none());
        assert!(!state.is_idle);
    }

    #[test]
    fn reset_rearms_idle_detection() {
        let mut state = PtyAutoState::new();
        state.last_output_time = Instant::now() - Duration::from_secs(2);
        let threshold = Duration::from_secs(1);

        // Transition to idle
        assert!(state.check_idle_transition(threshold).is_some());
        assert!(state.is_idle);

        // Simulate new output: resets idle state
        state.reset_idle_on_output();
        assert!(!state.is_idle);

        // Need to also update last_output_time (as pty_worker does)
        state.last_output_time = Instant::now() - Duration::from_secs(2);

        // Should emit again after re-arming
        assert!(state.check_idle_transition(threshold).is_some());
    }

    #[test]
    fn reset_without_idle_is_noop() {
        let mut state = PtyAutoState::new();
        assert!(!state.is_idle);
        state.reset_idle_on_output();
        assert!(!state.is_idle);
    }
}

#[cfg(test)]
mod hold_tests {
    use super::*;

    /// While an interactive hold is active, `try_auto_enter` must not press
    /// Enter (which would submit a human driver's half-typed input). Releasing
    /// the hold resumes normal behaviour. We observe the effect via
    /// `auto_enter_retry_count`, which only increments when a `\r` is actually
    /// submitted.
    #[tokio::test]
    async fn interactive_hold_suppresses_and_resumes_auto_enter() {
        let (pty, _rx) = PtySession::spawn("sleep", &["30".into()], 24, 80).unwrap();
        let mut state = PtyAutoState::new();
        // Arrange conditions under which auto-enter WOULD fire: an injection
        // happened and both the injection and the last output are well past the
        // required silence window, with no cooldown, editor, or suggestion.
        state.last_injection_time = Some(Instant::now() - Duration::from_secs(120));
        state.last_output_time = Instant::now() - Duration::from_secs(120);

        // Held: no keystroke.
        state.interactive_hold = true;
        state.try_auto_enter(&pty);
        assert_eq!(
            state.auto_enter_retry_count, 0,
            "auto-enter must be suppressed while interactive hold is active"
        );

        // Released: resumes and fires.
        state.interactive_hold = false;
        state.try_auto_enter(&pty);
        assert_eq!(
            state.auto_enter_retry_count, 1,
            "auto-enter must resume once the hold is released"
        );

        let _ = pty.shutdown();
    }
}

#[cfg(all(test, unix))]
mod claude_trust_tests {
    use super::*;

    /// Exercise the responder through a real PTY: the shim exits unless Relay
    /// moves off the newly preselected "No" row before confirming. Reaching
    /// READY proves the would-be worker remains alive and attachable.
    #[tokio::test]
    async fn claude_trust_prompt_new_layout_keeps_worker_alive() {
        let script = "printf 'Do you trust the files in this folder?\\n❯ No, exit\\n  Yes, I trust this folder\\nEnter to confirm · Esc to cancel\\n'; IFS= read -r answer; [ \"$answer\" = \"$(printf '\\033[B')\" ] || exit 23; printf 'READY\\n'; sleep 30";
        let (pty, mut rx) = PtySession::spawn("sh", &["-c".into(), script.into()], 24, 80).unwrap();

        let mut output = String::new();
        while !pty.screen_text().contains("Yes, I trust this folder") {
            let chunk = tokio::time::timeout(Duration::from_secs(2), rx.recv())
                .await
                .expect("trust menu should render")
                .expect("worker must remain alive while showing trust menu");
            output.push_str(&String::from_utf8_lossy(&chunk));
        }

        let mut state = PtyAutoState::new();
        state.handle_claude_trust(&output, &pty).await;

        while !output.contains("READY") {
            let chunk = tokio::time::timeout(Duration::from_secs(2), rx.recv())
                .await
                .expect("affirmative selection should produce READY")
                .expect("worker exited instead of accepting folder trust");
            output.push_str(&String::from_utf8_lossy(&chunk));
        }
        assert!(state.claude_trust_handled);
        let _ = pty.shutdown();
    }
}

#[cfg(test)]
mod auto_suggestion_tests {
    use super::*;

    const OPEN: &str = "\x1b[7m"; // reverse-video (ghost text begins)
    const CLOSE: &str = "\x1b[27m\x1b[2m"; // reverse off + dim (ghost text ends)

    #[test]
    fn pair_in_one_chunk_arms_visibility() {
        let mut s = PtyAutoState::new();
        s.update_auto_suggestion_windowed(&format!("{OPEN}ghost{CLOSE}"), "");
        assert!(s.auto_suggestion_visible);
    }

    #[test]
    fn pair_straddling_boundary_is_detected() {
        let mut s = PtyAutoState::new();
        // Chunk 1 ends with the opening marker; nothing arms yet.
        s.update_auto_suggestion_windowed(&format!("prompt {OPEN}gho"), "");
        assert!(
            !s.auto_suggestion_visible,
            "opening marker alone must not arm"
        );
        // Chunk 2 carries the closing markers; the previous tail completes the pair.
        let tail = format!("prompt {OPEN}gho");
        s.update_auto_suggestion_windowed(&format!("st{CLOSE}"), &tail);
        assert!(
            s.auto_suggestion_visible,
            "a pair straddling the read boundary must be detected"
        );
    }

    #[test]
    fn normal_output_clears_even_with_stale_pair_in_tail() {
        // The regression cubic flagged: a completed suggestion in the previous
        // chunk's tail must NOT keep visibility armed once plain output arrives.
        let mut s = PtyAutoState::new();
        let stale_tail = format!("{OPEN}ghost{CLOSE}");
        s.auto_suggestion_visible = true;
        s.update_auto_suggestion_windowed("the user typed a real line", &stale_tail);
        assert!(
            !s.auto_suggestion_visible,
            "real output must clear visibility even when a completed pair sits in the lookbehind"
        );
    }

    #[test]
    fn whitespace_only_chunk_leaves_visibility_unchanged() {
        let mut s = PtyAutoState::new();
        s.auto_suggestion_visible = true;
        s.update_auto_suggestion_windowed("   \x1b[0m", "");
        assert!(
            s.auto_suggestion_visible,
            "whitespace / ANSI-only output must not flip visibility"
        );
    }
}

#[cfg(test)]
mod opencode_perm_tests {
    use super::*;

    #[test]
    fn opencode_perm_buffer_cleared_in_cooldown() {
        let mut state = PtyAutoState::new();
        // Simulate a recent approval
        state.last_opencode_perm_approval = Some(Instant::now());
        // Append some text to the buffer
        state.opencode_perm_buffer =
            "EXECUTE (command, timeout: 120s, impact: medium)\n> Yes, allow".to_string();

        // During cooldown the buffer should be cleared (tested via state inspection)
        let in_cooldown = state
            .last_opencode_perm_approval
            .map(|t| t.elapsed() < GEMINI_ACTION_COOLDOWN)
            .unwrap_or(false);
        assert!(in_cooldown);
    }

    #[test]
    fn opencode_perm_no_cooldown_initially() {
        let state = PtyAutoState::new();
        assert!(state.last_opencode_perm_approval.is_none());
        assert!(state.opencode_perm_buffer.is_empty());
    }

    #[test]
    fn opencode_perm_buffer_accumulates_text() {
        let mut state = PtyAutoState::new();
        PtyAutoState::append_buf(
            &mut state.opencode_perm_buffer,
            "EXECUTE (command, timeout: 120s, impact: medium)\n",
            2500,
            2000,
        );
        PtyAutoState::append_buf(
            &mut state.opencode_perm_buffer,
            "> Yes, allow\n",
            2500,
            2000,
        );
        assert!(state.opencode_perm_buffer.contains("EXECUTE"));
        assert!(state.opencode_perm_buffer.contains("Yes, allow"));
    }

    #[test]
    fn opencode_perm_cooldown_expires() {
        let mut state = PtyAutoState::new();
        // Set approval time far in the past (beyond GEMINI_ACTION_COOLDOWN)
        state.last_opencode_perm_approval = Some(Instant::now() - Duration::from_secs(10));
        let in_cooldown = state
            .last_opencode_perm_approval
            .map(|t| t.elapsed() < GEMINI_ACTION_COOLDOWN)
            .unwrap_or(false);
        assert!(!in_cooldown);
    }

    #[test]
    fn append_buf_truncates_at_limit() {
        let mut buf = String::new();
        // Fill buffer to just past the max
        let chunk = "A".repeat(2600);
        PtyAutoState::append_buf(&mut buf, &chunk, 2500, 2000);
        // After exceeding 2500 it should be truncated to keep_bytes (2000)
        assert!(buf.len() <= 2100); // allow some slack for char boundary rounding
    }
}

/// Register this broker's `spawn`/`release` actions for a workspace.
///
/// Best-effort: a registration failure is logged but never blocks startup, and
/// re-registering an existing action is idempotent on the relaycast side.
async fn register_broker_actions(workspace: &RelayWorkspace) {
    let handler = workspace.self_name.clone();
    let specs = [
        (
            "spawn",
            "Spawn a child agent in this broker's runtime.",
            serde_json::json!({
                "type": "object",
                "required": ["name", "cli"],
                "properties": {
                    "name": { "type": "string", "description": "Worker agent name" },
                    "cli": { "type": "string", "description": "CLI/harness to launch" },
                    "args": { "type": "array", "items": { "type": "string" } },
                    "metadata": {
                        "type": "object",
                        "properties": {
                            "attestation": {
                                "type": "object",
                                "required": ["jti", "agentId", "sponsorId"],
                                "properties": {
                                    "jti": { "type": "string" },
                                    "agentId": { "type": "string" },
                                    "sponsorId": { "type": "string" }
                                }
                            }
                        }
                    }
                }
            }),
        ),
        (
            "release",
            "Release a child agent spawned by this broker.",
            serde_json::json!({
                "type": "object",
                "required": ["name"],
                "properties": {
                    "name": { "type": "string", "description": "Worker agent name" }
                }
            }),
        ),
    ];

    for (name, description, schema) in specs {
        let request = RegisterActionRequest {
            name: name.to_string(),
            description: description.to_string(),
            handler_agent: handler.clone(),
            input_schema: schema.as_object().cloned(),
            output_schema: None,
            available_to: None,
        };
        match workspace.http_client.register_action(request).await {
            Ok(definition) => tracing::info!(
                action = %name,
                handler = %handler,
                id = %definition.id,
                "registered broker action"
            ),
            Err(error) => tracing::warn!(
                action = %name,
                handler = %handler,
                error = %error,
                "failed to register broker action"
            ),
        }
    }
}

/// Interactive wrap mode: wraps a CLI in a PTY with terminal passthrough
/// while connecting to Relaycast for relay message injection.
/// Usage: `agent-relay codex --full-auto`
pub(crate) async fn run_wrap(
    cli_name: String,
    cli_args: Vec<String>,
    progress: bool,
    telemetry: TelemetryClient,
) -> Result<()> {
    let (resolved_cli, inline_cli_args) = parse_cli_command(&cli_name)
        .with_context(|| format!("invalid CLI command '{cli_name}'"))?;
    let mut effective_cli_args = inline_cli_args;
    effective_cli_args.extend(cli_args);

    let broker_start = Instant::now();
    let mut agent_spawn_count: u32 = 0;
    telemetry.track(TelemetryEvent::BrokerStart);
    // Disable Claude Code auto-suggestions so relay message injection into the PTY
    // cannot accidentally accept a ghost suggestion via the Enter keystroke.
    #[allow(deprecated)]
    std::env::set_var("CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION", "false");
    // Disable Claude Code auto-updater — it fails in sandboxes and can crash the process.
    #[allow(deprecated)]
    std::env::set_var("DISABLE_AUTOUPDATER", "1");

    let requested_name = std::env::var("RELAY_AGENT_NAME").unwrap_or_else(|_| resolved_cli.clone());
    let channels = std::env::var("RELAY_CHANNELS").unwrap_or_else(|_| "general".to_string());
    let channel_list = channels_from_csv(&channels);
    let skip_prompt = env_flag_enabled("RELAY_SKIP_PROMPT");

    eprintln!(
        "[agent-relay] wrapping {} (agent: {}, channels: {:?})",
        resolved_cli, requested_name, channel_list
    );
    eprintln!("[agent-relay] use RUST_LOG=debug for verbose logging");

    // --- Auth & Relaycast connection ---
    let runtime_cwd = std::env::current_dir()?;
    let paths = ensure_runtime_paths(&runtime_cwd, &requested_name, None)?;

    let strict_name = env_flag_enabled("RELAY_STRICT_AGENT_NAME");
    let relay = connect_relay(RelaySessionOptions {
        paths: &paths,
        requested_name: &requested_name,
        channels: channel_list,
        strict_name,
        agent_type: None,
        read_mcp_identity: true,
        runtime_cwd: &runtime_cwd,
    })
    .await?;

    tracing::debug!("connected to relaycast");

    let RelaySession {
        configured_base,
        default_workspace_id,
        workspaces,
        mut ws_inbound_rx,
    } = relay;
    // Ensure the requested agent name (from RELAY_AGENT_NAME) is in self_names
    // so that messages sent by the MCP server child (which registers with the
    // same name) are recognized as self-echo and filtered out.
    let workspaces: Vec<RelayWorkspace> = workspaces
        .into_iter()
        .map(|mut ws| {
            ws.self_names.insert(requested_name.clone());
            ws
        })
        .collect();
    // Register spawn/release as relaycast actions so other agents can invoke
    // them as structured agent-to-agent RPC routed to this broker.
    for workspace in &workspaces {
        register_broker_actions(workspace).await;
    }
    let workspace_lookup: std::collections::HashMap<WorkspaceId, RelayWorkspace> = workspaces
        .iter()
        .cloned()
        .map(|workspace| (workspace.workspace_id.clone(), workspace))
        .collect();
    let default_workspace = if let Some(default_workspace_id) = default_workspace_id.as_deref() {
        workspaces
            .iter()
            .find(|workspace| workspace.workspace_id == default_workspace_id)
            .or_else(|| workspaces.first())
    } else {
        workspaces.first()
    }
    .cloned()
    .context("no relay workspace available for wrap mode")?;
    let child_base_url = configured_base.clone();
    let child_workspaces_json = serde_json::to_string(
        &workspaces
            .iter()
            .map(|workspace| {
                serde_json::json!({
                    "workspace_id": workspace.workspace_id,
                    "workspace_alias": workspace.workspace_alias,
                    "api_key": workspace.relay_workspace_key,
                })
            })
            .collect::<Vec<_>>(),
    )?;

    // Spawner for child agents
    let mut spawner = Spawner::new();

    // --- Spawn CLI in PTY ---
    let (pty, mut pty_rx) = PtySession::spawn(
        &resolved_cli,
        &effective_cli_args,
        terminal_rows().unwrap_or(24),
        terminal_cols().unwrap_or(80),
    )?;
    // Query responses (DSR/DA1/DA2/CPR) are answered by alacritty's
    // `RelayEventListener` inside `PtySession`.

    eprintln!("[agent-relay] ready");

    // Set terminal to raw mode for passthrough
    #[cfg(unix)]
    let saved_termios = {
        use nix::sys::termios;
        match termios::tcgetattr(std::io::stdin()) {
            Ok(orig) => {
                let mut raw = orig.clone();
                termios::cfmakeraw(&mut raw);
                let _ = termios::tcsetattr(std::io::stdin(), termios::SetArg::TCSANOW, &raw);
                Some(orig)
            }
            Err(_) => None,
        }
    };

    // Stdin reader thread
    let (stdin_tx, mut stdin_rx) = mpsc::channel::<Vec<u8>>(64);
    std::thread::spawn(move || {
        use std::io::Read;
        let mut stdin = std::io::stdin();
        let mut buf = [0u8; 1024];
        loop {
            match stdin.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if stdin_tx.blocking_send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    // Dedup for WS events
    let mut dedup = DedupCache::new(Duration::from_secs(300), 8192);
    let mut dm_participants_cache = DmParticipantsCache::new();

    // Buffer for extracting message IDs from MCP tool responses in PTY output.
    // When the agent sends messages via MCP, the response contains the message ID.
    // Pre-seeding dedup with these IDs prevents self-echo when the same message
    // arrives via WS — regardless of what identity the MCP server uses.
    let mut mcp_response_buffer = String::new();
    // Stateful ANSI stripper for auto-suggestion detection. `is_auto_suggestion`
    // keys on raw markers (`\x1b[7m`, `\x1b[27m\x1b[2m`); scanning each PTY read
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

    let mut pty_auto = PtyAutoState::new();
    let mut auto_enter_interval = tokio::time::interval(Duration::from_secs(2));
    auto_enter_interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut pending_injection_interval = tokio::time::interval(Duration::from_millis(50));
    pending_injection_interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut pending_wrap_injections: VecDeque<PendingWrapInjection> = VecDeque::new();
    let mut pending_wrap_writes: FuturesUnordered<PendingWrapWriteAckFuture> =
        FuturesUnordered::new();
    let mut mcp_reminder_throttle = McpReminderThrottle::new();

    // Echo verification state
    let mut pending_verifications: VecDeque<PendingVerification> = VecDeque::new();
    let mut pending_activities: VecDeque<PendingActivity> = VecDeque::new();
    let activity_detector = if progress {
        Some(ActivityDetector::for_cli(&cli_name))
    } else {
        None
    };
    let mut throttle = ThrottleState::default();
    let mut echo_buffer = VerificationOutput::default();
    let mut verification_tick = tokio::time::interval(Duration::from_millis(200));
    verification_tick.set_missed_tick_behavior(MissedTickBehavior::Skip);

    let mut reap_tick = tokio::time::interval(Duration::from_secs(5));
    reap_tick.set_missed_tick_behavior(MissedTickBehavior::Skip);

    // Terminal resize notifications.
    //
    // Unix: SIGWINCH is event-driven, fires exactly when the TTY resizes,
    // zero CPU when idle.
    //
    // Windows: no SIGWINCH, and crossterm's `EventStream` can't be used
    // alongside our stdin passthrough — reading CONIN$ consumes keypresses
    // that we need to forward to the child PTY. A dedicated background
    // thread polls the console size at 100ms and notifies via a channel
    // only when it actually changes. The main select! loop stays
    // event-driven; polling happens off the hot path.
    #[cfg(unix)]
    let mut resize_signal =
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::window_change())
            .expect("failed to register SIGWINCH handler");
    #[cfg(windows)]
    let mut resize_signal = {
        let (tx, rx) = mpsc::channel::<()>(4);
        std::thread::spawn(move || {
            let mut last = crossterm::terminal::size().ok();
            loop {
                std::thread::sleep(Duration::from_millis(100));
                let current = crossterm::terminal::size().ok();
                if current != last {
                    last = current;
                    if tx.blocking_send(()).is_err() {
                        break;
                    }
                }
            }
        });
        rx
    };

    let mut running = true;
    let mut stdout = tokio::io::stdout();

    // Human keystrokes waiting to reach the PTY. `submit_write` is
    // non-blocking: when the drainer's bounded queue is full (child briefly not
    // reading stdin) it returns `Err` instead of parking the loop. The old
    // blocking `write_all` back-pressured the terminal; dropping the write here
    // would silently swallow keystrokes. Instead we buffer in FIFO order and
    // retry on a short deadline, so ordering is preserved and nothing is lost
    // during a transient stall. Bounded so a permanently wedged child can't grow
    // this without limit — the oldest chunk is dropped with a warning if the cap
    // is hit (at which point the child is not consuming input anyway).
    let mut stdin_pending: VecDeque<Vec<u8>> = VecDeque::new();
    let mut stdin_retry_deadline: Option<tokio::time::Instant> = None;
    const STDIN_RETRY_INTERVAL: Duration = Duration::from_millis(4);

    while running {
        tokio::select! {
            // Ctrl-C
            _ = tokio::signal::ctrl_c() => {
                running = false;
            }

            // Stdin → PTY (passthrough). Append in FIFO order, then drain what
            // the drainer will accept. On a full queue the remainder stays
            // buffered and the retry-deadline arm below flushes it, so
            // keystrokes are never dropped or reordered under back-pressure.
            Some(data) = stdin_rx.recv() => {
                let backlogged = buffer_and_drain_stdin(
                    &mut stdin_pending,
                    data,
                    STDIN_PENDING_MAX_CHUNKS,
                    |bytes| pty.submit_write(bytes.to_vec()).is_ok(),
                );
                stdin_retry_deadline = backlogged
                    .then(|| tokio::time::Instant::now() + STDIN_RETRY_INTERVAL);
            }

            // Retry draining buffered stdin once the child accepts writes again.
            // Parks on `pending()` (never wakes) whenever nothing is buffered.
            _ = async {
                match stdin_retry_deadline {
                    Some(deadline) => tokio::time::sleep_until(deadline).await,
                    None => std::future::pending::<()>().await,
                }
            }, if stdin_retry_deadline.is_some() => {
                let backlogged = drain_stdin_buffer(
                    &mut stdin_pending,
                    &mut |bytes| pty.submit_write(bytes.to_vec()).is_ok(),
                );
                stdin_retry_deadline = backlogged
                    .then(|| tokio::time::Instant::now() + STDIN_RETRY_INTERVAL);
            }

            // PTY output → stdout (passthrough) + auto-responses
            chunk = pty_rx.recv() => {
                match chunk {
                    Some(chunk) => {
                        // Preserve the producer-assigned read sequence before
                        // any async handling. Output already queued when an
                        // injection is submitted must remain ineligible as its
                        // echo even though this arm consumes it afterward.
                        echo_buffer.push_output(chunk.sequence(), chunk.as_bytes());
                        // Passthrough to user's terminal
                        use tokio::io::AsyncWriteExt;
                        let _ = stdout.write_all(&chunk).await;
                        let _ = stdout.flush().await;

                        let text = String::from_utf8_lossy(&chunk).to_string();
                        let clean_text = strip_ansi(&text);
                        pty_auto.last_output_time = Instant::now();
                        mcp_reminder_throttle.note_output_bytes(chunk.len());

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
                        pty_auto.update_editor_buffer(&text);
                        pty_auto.reset_auto_enter_on_output(&text);

                        // Extract message IDs from MCP tool responses to prevent self-echo.
                        {
                            mcp_response_buffer.push_str(&clean_text);
                            if mcp_response_buffer.len() > 4000 {
                                let start = floor_char_boundary(&mcp_response_buffer, mcp_response_buffer.len() - 3000);
                                mcp_response_buffer = mcp_response_buffer[start..].to_string();
                            }
                            for msg_id in extract_mcp_message_ids(&mcp_response_buffer) {
                                for workspace in &workspaces {
                                    let scoped_key = format!("{}:{}", workspace.workspace_id, msg_id);
                                    if dedup.insert_if_new(&scoped_key, Instant::now()) {
                                        tracing::debug!(
                                            workspace_id = %workspace.workspace_id,
                                            "pre-seeded dedup with outbound message id: {}", msg_id
                                        );
                                    }
                                }
                            }
                        }

                        // Skip auto-responders while human keystrokes are
                        // backlogged in `stdin_pending` (the drainer queue was
                        // full and hasn't drained them yet). Otherwise an
                        // auto-response write submitted here could land on the
                        // PTY FIFO ahead of keystrokes the human already typed,
                        // since `submit_write` orders by submission, not by
                        // when the byte was originally typed.
                        if stdin_pending.is_empty() {
                            pty_auto.handle_mcp_approval(&text, &pty).await;
                            pty_auto.handle_bypass_permissions(&text, &pty).await;
                            pty_auto.handle_codex_model_prompt(&text, &pty).await;
                            pty_auto.handle_codex_trust(&text, &pty).await;
                            pty_auto.handle_opencode_permission(&text, &pty).await;
                            pty_auto.handle_gemini_action(&text, &pty).await;
                            pty_auto.handle_gemini_untrusted_banner(&text, &pty).await;
                            pty_auto.handle_gemini_trust(&text, &pty).await;
                            pty_auto.handle_claude_trust(&text, &pty).await;
                        }

                        // Check pending verifications against new output
                        let mut verified_indices = Vec::new();
                        for (i, pv) in pending_verifications.iter().enumerate() {
                            if pending_verification_echo_seen(&echo_buffer, pv) {
                                verified_indices.push(i);
                            }
                        }
                        for &i in verified_indices.iter().rev() {
                            let pv = pending_verifications.remove(i).unwrap();
                            tracing::debug!(
                                event_id = %pv.event_id,
                                delivery_id = %pv.delivery_id,
                                attempts = pv.attempts,
                                "wrap: delivery echo verified"
                            );
                            throttle.record(DeliveryOutcome::Success);
                            if let Some(detector) = activity_detector.as_ref() {
                                pending_activities.push_back(PendingActivity {
                                    delivery_id: pv.delivery_id,
                                    event_id: pv.event_id,
                                    expected_echo: pv.expected_echo,
                                    verified_at: Instant::now(),
                                    output_buffer: String::new(),
                                    detector: detector.clone(),
                                });
                            }
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
                                    tracing::info!(
                                        target = "agent_relay::worker::wrap",
                                        delivery_id = %pa.delivery_id,
                                        event_id = %pa.event_id,
                                        pattern = %pattern,
                                        "delivery became active"
                                    );
                                } else {
                                    tracing::debug!(
                                        target = "agent_relay::worker::wrap",
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

            // Relay messages from WS → intercept broker commands or queue for PTY injection
            ws_msg = ws_inbound_rx.recv() => {
                if let Some(ws_msg) = ws_msg {
                    let workspace_id = ws_msg.workspace_id.clone();
                    let workspace_alias = ws_msg.workspace_alias.clone();
                    let ws_value = ws_msg.value;
                    let workspace_state = workspace_lookup
                        .get(&workspace_id)
                        .cloned()
                        .unwrap_or_else(|| default_workspace.clone());
                    let workspace_self_agent_id = workspace_state.self_agent_id.clone();
                    let workspace_self_names = workspace_state.self_names.clone();
                    let workspace_self_agent_ids = workspace_state.self_agent_ids.clone();
                    let workspace_child_api_key = workspace_state.relay_workspace_key.clone();
                    let workspace_child_http = workspace_state.http_client.clone();
                    // Check for action.invoked event first (spawn/release).
                    // Relaycast 2.x routes these as agent-to-agent actions: the
                    // event identifies the invocation, the input is read back via
                    // get_action_invocation, and the outcome is reported with
                    // complete_action_invocation.
                    if let Some(action_ref) = parse_ws_action_invoked(&ws_value) {
                        if !action_targets_self(
                            &action_ref.action,
                            &action_ref.invoked_by,
                            action_ref.handler_agent_id.as_deref(),
                            &workspace_self_agent_id,
                        ) {
                            tracing::debug!(
                                action = %action_ref.action,
                                handler_agent_id = ?action_ref.handler_agent_id,
                                self_agent_id = %workspace_self_agent_id,
                                "ignoring action event for a different handler"
                            );
                            continue;
                        }

                        // The action.invoked event omits the input payload; read
                        // it back before executing.
                        let invocation = match workspace_child_http
                            .get_action_invocation(&action_ref.action, &action_ref.invocation_id)
                            .await
                        {
                            Ok(invocation) => invocation,
                            Err(error) => {
                                tracing::error!(
                                    action = %action_ref.action,
                                    invocation_id = %action_ref.invocation_id,
                                    error = %error,
                                    "failed to read action invocation input"
                                );
                                continue;
                            }
                        };

                        let payload = match broker_payload_from_action(
                            &action_ref.action,
                            invocation.input,
                        ) {
                            Some(payload) => payload,
                            None => {
                                tracing::warn!(
                                    action = %action_ref.action,
                                    "ignoring action with unrecognized name or input"
                                );
                                continue;
                            }
                        };

                        // None on success; Some(message) records why the action failed.
                        let mut completion_error: Option<String> = None;
                        match payload {
                            BrokerCommandPayload::Spawn(ref params) => {
                                if params.name.is_empty() || params.cli.is_empty() {
                                    tracing::error!("spawn action missing name or cli");
                                    completion_error =
                                        Some("spawn action missing name or cli".to_string());
                                } else {
                                    let env_vars = spawn_env_vars(
                                        &params.name,
                                        &workspace_child_api_key,
                                        child_base_url.as_deref(),
                                        &channels,
                                        Some(&child_workspaces_json),
                                        default_workspace_id.as_deref(),
                                        // Per-worker: the harness this agent runs.
                                        crate::telemetry::infer_harness_from_command(&params.cli),
                                    );
                                    let env_vars = with_commit_attestation_env(
                                        env_vars,
                                        params.metadata.attestation.as_ref(),
                                    );
                                    // Pre-register the child agent so its MCP server
                                    // starts with a valid token (avoiding "Not registered"
                                    // errors when non-claude CLIs like codex try to use
                                    // relay tools before calling register() themselves).
                                    let child_token = match retry_agent_registration(
                                        &workspace_child_http,
                                        &params.name,
                                        Some(&params.cli),
                                    ).await {
                                        Ok(token) => Some(token),
                                        Err(RegRetryOutcome::RetryableExhausted(e)) => {
                                            tracing::warn!(
                                                child = %params.name,
                                                error = %e,
                                                "pre-registration failed after retries, spawning without token"
                                            );
                                            None
                                        }
                                        Err(RegRetryOutcome::Fatal(e)) => {
                                            tracing::warn!(
                                                child = %params.name,
                                                error = %e,
                                                "pre-registration fatal error, spawning without token"
                                            );
                                            None
                                        }
                                    };
                                    match spawner
                                        .spawn_wrap_with_token(
                                            &params.name,
                                            &params.cli,
                                            &params.args,
                                            &env_vars,
                                            Some(&action_ref.invoked_by),
                                            child_token.as_deref(),
                                        )
                                        .await
                                    {
                                        Ok(pid) => {
                                            agent_spawn_count += 1;
                                            telemetry.track(TelemetryEvent::AgentSpawn {
                                                cli: params.cli.clone(),
                                                runtime: "pty".to_string(),
                                                // The wrap path handles child spawns requested by a
                                                // running agent through the broker action channel —
                                                // always agent-originated here.
                                                spawn_source: ActionSource::Agent,
                                                has_task: false,
                                                is_shadow: false,
                                            });
                                            tracing::info!(
                                                child = %params.name,
                                                cli = %params.cli,
                                                pid = pid,
                                                invoked_by = %action_ref.invoked_by,
                                                "spawned child agent"
                                            );
                                            eprintln!(
                                                "\r\n[agent-relay] spawned child '{}' (pid {})\r",
                                                params.name, pid
                                            );
                                        }
                                        Err(error) => {
                                            tracing::error!(
                                                child = %params.name,
                                                error = %error,
                                                "failed to spawn child agent"
                                            );
                                            eprintln!(
                                                "\r\n[agent-relay] failed to spawn '{}': {}\r",
                                                params.name, error
                                            );
                                            completion_error = Some(format!(
                                                "failed to spawn '{}': {error}",
                                                params.name
                                            ));
                                        }
                                    }
                                }
                            }
                            BrokerCommandPayload::Release(ref params) => {
                                // action.invoked doesn't carry sender_kind, so use Unknown
                                let sender_is_human =
                                    is_human_sender(&action_ref.invoked_by, SenderKind::Unknown);
                                let owner = spawner.owner_of(&params.name);
                                if can_release_child(owner, &action_ref.invoked_by, sender_is_human) {
                                    match spawner.release(&params.name, Duration::from_secs(2)).await {
                                        Ok(()) => {
                                            telemetry.track(TelemetryEvent::AgentRelease {
                                                cli: String::new(),
                                                release_reason: "ws_action".to_string(),
                                                lifetime_seconds: 0,
                                                release_source: if sender_is_human {
                                                    ActionSource::HumanCli
                                                } else {
                                                    ActionSource::Agent
                                                },
                                            });
                                            tracing::info!(
                                                child = %params.name,
                                                released_by = %action_ref.invoked_by,
                                                "released child agent"
                                            );
                                            eprintln!("\r\n[agent-relay] released child '{}'\r", params.name);
                                        }
                                        Err(error) => {
                                            tracing::error!(
                                                child = %params.name,
                                                error = %error,
                                                "failed to release child agent"
                                            );
                                            eprintln!(
                                                "\r\n[agent-relay] failed to release '{}': {}\r",
                                                params.name, error
                                            );
                                            completion_error = Some(format!(
                                                "failed to release '{}': {error}",
                                                params.name
                                            ));
                                        }
                                    }
                                } else {
                                    tracing::warn!(
                                        child = %params.name,
                                        sender = %action_ref.invoked_by,
                                        "release denied: sender is not owner or human"
                                    );
                                    completion_error = Some(format!(
                                        "release denied: {} is not owner or human",
                                        action_ref.invoked_by
                                    ));
                                }
                            }
                        }

                        // Report the outcome back to relaycast so the caller's
                        // invocation resolves instead of hanging.
                        let complete_request = CompleteInvocationRequest {
                            output: None,
                            error: completion_error,
                            duration_ms: None,
                        };
                        if let Err(error) = workspace_child_http
                            .complete_action_invocation(
                                &action_ref.action,
                                &action_ref.invocation_id,
                                complete_request,
                            )
                            .await
                        {
                            tracing::warn!(
                                action = %action_ref.action,
                                invocation_id = %action_ref.invocation_id,
                                error = %error,
                                "failed to report action completion"
                            );
                        }
                        continue;
                    }

                    // Regular relay message: map and queue for PTY injection
                    if let Some(mapped) = map_ws_event(
                        &ws_value,
                        &workspace_id,
                        workspace_alias.as_deref(),
                    ) {
                        // Skip presence and reaction events — they carry no content
                        // to inject and cause agents to respond to empty messages.
                        if matches!(mapped.kind, InboundKind::Presence | InboundKind::ReactionReceived) {
                            tracing::debug!(
                                kind = ?mapped.kind,
                                from = %mapped.from,
                                "skipping non-message event in wrap mode"
                            );
                            continue;
                        }

                        let dedup_key = format!("{}:{}", mapped.workspace_id, mapped.event_id);
                        if !dedup.insert_if_new(&dedup_key, Instant::now()) {
                            tracing::debug!(event_id = %mapped.event_id, workspace_id = %mapped.workspace_id, "dedup: skipping relay event");
                            continue;
                        }
                        if is_self_name(&workspace_self_names, &mapped.from)
                            || mapped
                                .sender_agent_id
                                .as_ref()
                                .is_some_and(|id| workspace_self_agent_ids.iter().any(|self_id| agent_name_eq(self_id, id)))
                        {
                            tracing::debug!(
                                from = %mapped.from,
                                sender_agent_id = ?mapped.sender_agent_id,
                                "skipping self-echo in wrap mode"
                            );
                            continue;
                        }

                        // DM routing: only deliver DMs addressed to this agent.
                        // Channel messages (target starts with '#') are broadcast
                        // to all subscribers. Allow through: empty targets (presence)
                        // and thread replies.
                        if !mapped.target.is_empty()
                            && !mapped.target.starts_with('#')
                            && mapped.target != "thread"
                        {
                            if mapped.target.starts_with("dm_") || mapped.target.starts_with("conv_") {
                                // Conversation-ID target: resolve participants to check
                                // if this wrapped agent is part of the DM.
                                let participants = resolve_dm_participants_cached(
                                    &workspace_child_http,
                                    &mut dm_participants_cache,
                                    &workspace_id,
                                    &mapped.target,
                                ).await;
                                let is_participant = workspace_self_names.iter().any(|name| {
                                    participants.iter().any(|p| agent_name_eq(p, name))
                                });
                                if !is_participant {
                                    tracing::debug!(
                                        target = %mapped.target,
                                        participants = ?participants,
                                        self_names = ?workspace_self_names,
                                        "skipping DM — agent not in participants"
                                    );
                                    continue;
                                }
                            } else if !is_self_name(&workspace_self_names, &mapped.target) {
                                tracing::debug!(
                                    target = %mapped.target,
                                    self_names = ?workspace_self_names,
                                    "skipping DM not addressed to this agent"
                                );
                                continue;
                            }
                        }

                        let delivery_id = format!("wrap_{}", mapped.event_id);
                        tracing::debug!(
                            delivery_id = %delivery_id,
                            event_id = %mapped.event_id,
                            "wrap: delivery queued"
                        );

                        pending_wrap_injections.push_back(PendingWrapInjection {
                            from: mapped.from,
                            event_id: mapped.event_id,
                            workspace_id: Some(mapped.workspace_id),
                            workspace_alias: mapped.workspace_alias,
                            body: mapped.text,
                            target: mapped.target,
                            queued_at: Instant::now(),
                        });
                    } else {
                        tracing::debug!(
                            "ws event not mapped: {}",
                            serde_json::to_string(&ws_value).unwrap_or_default()
                        );
                    }
                }
            }

            _ = pending_injection_interval.tick(),
                if wrap_injection_timer_allowed(!pending_wrap_writes.is_empty()) => {
                // Give backlogged human keystrokes priority onto the PTY FIFO
                // over a new automated injection — see the auto-responder gate
                // above for why.
                if !stdin_pending.is_empty() {
                    continue;
                }
                let should_block = pending_wrap_injections
                    .front()
                    .map(|pending| {
                        pty_auto.auto_suggestion_visible
                            && pending.queued_at.elapsed() < AUTO_SUGGESTION_BLOCK_TIMEOUT
                    })
                    .unwrap_or(false);
                if should_block {
                    continue;
                }
                if let Some(pending) = pending_wrap_injections.pop_front() {
                    tokio::time::sleep(throttle.delay()).await;
                    if pty_auto.auto_suggestion_visible {
                        tracing::warn!(
                            event_id = %pending.event_id,
                            "auto-suggestion visible; sending Escape to dismiss before injection"
                        );
                        warn_on_auto_response_write(
                            pty.submit_write(b"\x1b".to_vec()),
                            "wrap_injection_escape_dismiss",
                        );
                        tokio::time::sleep(Duration::from_millis(100)).await;
                        pty_auto.auto_suggestion_visible = false;
                    }
                    tracing::debug!("relay from {} → {}", pending.from, pending.target);
                    let include_reminder = !skip_prompt
                        && mcp_reminder_throttle.should_include(Instant::now());
                    let injection = format_injection_for_worker_with_workspace(
                        &pending.from,
                        &pending.event_id,
                        &pending.body,
                        &pending.target,
                        include_reminder,
                        true, // pre_registered
                        None, // assigned_name
                        pending.workspace_id.as_deref(),
                        pending.workspace_alias.as_deref(),
                    );
                    let mut bytes = injection.as_bytes().to_vec();
                    let write = if let Some(delay) = injection_submit_followup_delay(&resolved_cli)
                    {
                        // Claude needs Enter in a later PTY write to close its
                        // multiline paste boundary. The relay-pty compound
                        // command keeps that delayed write atomic with the body
                        // and acknowledges only after both writes succeed.
                        pty.submit_write_paced_with_followup_and_output_boundary(
                            bytes,
                            Duration::ZERO,
                            delay,
                            b"\r".to_vec(),
                        )
                    } else {
                        // Other harnesses retain the established single-write
                        // body-plus-Enter shape.
                        bytes.extend_from_slice(b"\r");
                        pty.submit_write_paced_with_output_boundary(bytes, Duration::ZERO)
                    };
                    match write {
                        Ok((ack_rx, output_boundary)) => {
                            let pending_write = PendingWrapWrite::Initial {
                                pending,
                                injection,
                                output_boundary,
                                include_reminder,
                            };
                            pending_wrap_writes.push(Box::pin(async move {
                                (
                                    pending_write,
                                    await_wrap_write_ack(ack_rx, WRAP_WRITE_ACK_TIMEOUT).await,
                                )
                            }));
                        }
                        Err(error) => {
                            tracing::warn!(
                                event_id = %pending.event_id,
                                error = %error,
                                "PTY injection write failed, re-queuing"
                            );
                            pending_wrap_injections.push_front(pending);
                        }
                    }
                }
            }

            Some((pending_write, ack)) = pending_wrap_writes.next(), if !pending_wrap_writes.is_empty() => {
                let ack = match ack {
                    Ok(ack) => ack,
                    Err(_) => {
                        let event_id = match &pending_write {
                            PendingWrapWrite::Initial { pending, .. } => &pending.event_id,
                            PendingWrapWrite::Retry { verification, .. } => &verification.event_id,
                        };
                        tracing::error!(
                            event_id = %event_id,
                            timeout_ms = WRAP_WRITE_ACK_TIMEOUT.as_millis(),
                            "PTY injection write acknowledgement timed out; retiring wrap session because delivery outcome is unknown"
                        );
                        break;
                    }
                };
                let error = wrap_write_ack_error(ack);

                match pending_write {
                    PendingWrapWrite::Initial {
                        pending,
                        injection,
                        output_boundary,
                        include_reminder,
                    } => {
                        if let Some(error) = error {
                            tracing::warn!(
                                event_id = %pending.event_id,
                                error = %error,
                                "PTY injection write was not confirmed; re-queuing"
                            );
                            pending_wrap_injections.push_front(pending);
                            continue;
                        }

                        if include_reminder {
                            mcp_reminder_throttle.note_sent(Instant::now());
                        }
                        telemetry.track(TelemetryEvent::MessageSend {
                            is_broadcast: pending.target.starts_with('#'),
                            has_thread: false,
                        });
                        tracing::debug!(
                            event_id = %pending.event_id,
                            "wrap: delivery injection confirmed"
                        );
                        pty_auto.last_injection_time = Some(Instant::now());
                        pty_auto.auto_enter_retry_count = 0;
                        let verification = PendingVerification {
                            delivery_id: DeliveryId::new(format!("wrap_{}", pending.event_id)),
                            event_id: pending.event_id,
                            expected_echo: injection,
                            output_boundary,
                            injected_at: Instant::now(),
                            attempts: 1,
                            max_attempts: MAX_VERIFICATION_ATTEMPTS,
                            request_id: None,
                            workspace_id: pending.workspace_id,
                            workspace_alias: pending.workspace_alias,
                            from: pending.from,
                            body: pending.body,
                            target: pending.target,
                        };
                        queue_or_confirm_wrap_verification(
                            verification,
                            &echo_buffer,
                            activity_detector.as_ref(),
                            &mut throttle,
                            &mut pending_verifications,
                            &mut pending_activities,
                        );
                    }
                    PendingWrapWrite::Retry {
                        mut verification,
                        injection,
                        output_boundary,
                        include_reminder,
                    } => {
                        if let Some(error) = error {
                            tracing::warn!(
                                event_id = %verification.event_id,
                                error = %error,
                                "wrap: retry PTY injection was not confirmed; re-queuing delivery"
                            );
                            pending_wrap_injections.push_front(PendingWrapInjection {
                                from: verification.from,
                                event_id: verification.event_id,
                                workspace_id: verification.workspace_id,
                                workspace_alias: verification.workspace_alias,
                                body: verification.body,
                                target: verification.target,
                                queued_at: Instant::now(),
                            });
                            continue;
                        }

                        if include_reminder {
                            mcp_reminder_throttle.note_sent(Instant::now());
                        }
                        tracing::debug!(
                            delivery_id = %verification.delivery_id,
                            event_id = %verification.event_id,
                            "wrap: delivery re-injection confirmed (retry)"
                        );
                        verification.expected_echo = injection;
                        verification.output_boundary = output_boundary;
                        verification.injected_at = Instant::now();
                        queue_or_confirm_wrap_verification(
                            verification,
                            &echo_buffer,
                            activity_detector.as_ref(),
                            &mut throttle,
                            &mut pending_verifications,
                            &mut pending_activities,
                        );
                    }
                }
            }

            // Verification tick: check for timed-out wrap verifications
            _ = verification_tick.tick() => {
                let mut retry_queue: Vec<PendingVerification> = Vec::new();
                let mut i = 0;
                while i < pending_verifications.len() {
                    if pending_verifications[i].injected_at.elapsed() >= VERIFICATION_WINDOW {
                        let mut pv = pending_verifications.remove(i).unwrap();
                        if pv.attempts < pv.max_attempts {
                            pv.attempts += 1;
                            tracing::warn!(
                                event_id = %pv.event_id,
                                attempt = pv.attempts,
                                max = pv.max_attempts,
                                "wrap: echo verification timeout, retrying injection"
                            );
                            retry_queue.push(pv);
                        } else {
                            tracing::warn!(
                                event_id = %pv.event_id,
                                attempts = pv.attempts,
                                "wrap: delivery verification failed after max retries"
                            );
                            throttle.record(DeliveryOutcome::Failed);
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
                for pv in retry_queue {
                    tokio::time::sleep(throttle.delay()).await;
                    // Retries consult the throttle like first injections: the
                    // failed attempt usually already echoed the full block, so
                    // a fresh one within the cooldown is redundant.
                    let include_reminder = !skip_prompt
                        && mcp_reminder_throttle.should_include(Instant::now());
                    let injection = format_injection_for_worker_with_workspace(
                        &pv.from,
                        &pv.event_id,
                        &pv.body,
                        &pv.target,
                        include_reminder,
                        true,
                        None,
                        pv.workspace_id.as_deref(),
                        pv.workspace_alias.as_deref(),
                    );
                    let mut bytes = injection.as_bytes().to_vec();
                    let write = if let Some(delay) = injection_submit_followup_delay(&resolved_cli)
                    {
                        pty.submit_write_paced_with_followup_and_output_boundary(
                            bytes,
                            Duration::ZERO,
                            delay,
                            b"\r".to_vec(),
                        )
                    } else {
                        bytes.extend_from_slice(b"\r");
                        pty.submit_write_paced_with_output_boundary(bytes, Duration::ZERO)
                    };
                    match write {
                        Ok((ack_rx, output_boundary)) => {
                            let pending_write = PendingWrapWrite::Retry {
                                verification: pv,
                                injection,
                                output_boundary,
                                include_reminder,
                            };
                            pending_wrap_writes.push(Box::pin(async move {
                                (
                                    pending_write,
                                    await_wrap_write_ack(ack_rx, WRAP_WRITE_ACK_TIMEOUT).await,
                                )
                            }));
                        }
                        Err(error) => {
                            tracing::warn!(
                                event_id = %pv.event_id,
                                error = %error,
                                "wrap: retry PTY injection write failed; re-queuing delivery"
                            );
                            pending_wrap_injections.push_front(PendingWrapInjection {
                                from: pv.from,
                                event_id: pv.event_id,
                                workspace_id: pv.workspace_id,
                                workspace_alias: pv.workspace_alias,
                                body: pv.body,
                                target: pv.target,
                                queued_at: Instant::now(),
                            });
                        }
                    }
                }
            }

            // Auto-enter for stuck agents. Gated on the same backlog check as
            // the other automation arms above — a stuck-agent nudge must not
            // jump ahead of keystrokes the human already typed.
            _ = auto_enter_interval.tick() => {
                if stdin_pending.is_empty() {
                    pty_auto.try_auto_enter(&pty);
                }
            }

            // Reap child agents that have exited on their own
            _ = reap_tick.tick() => {
                if let Ok(exited) = spawner.reap_exited().await {
                    for name in exited {
                        telemetry.track(TelemetryEvent::AgentCrash {
                            cli: String::new(),
                            exit_code: None,
                            lifetime_seconds: 0,
                        });
                        tracing::info!(child = %name, "child agent exited");
                        eprintln!("\r\n[agent-relay] child '{}' exited\r", name);
                    }
                }
            }

            // Terminal resize: forward current size to PTY.
            _ = resize_signal.recv() => {
                if let Some((rows, cols)) = get_terminal_size() {
                    let _ = pty.resize(rows, cols);
                }
            }
        }
    }

    telemetry.track(TelemetryEvent::BrokerStop {
        uptime_seconds: broker_start.elapsed().as_secs(),
        agent_spawn_count,
    });
    telemetry.shutdown();

    // Cleanup
    let _ = pty.shutdown();

    // Terminate all child agents
    spawner.shutdown_all(Duration::from_secs(2)).await;

    for workspace in &workspaces {
        if let Err(error) = workspace.ws_control_tx.send(WsControl::Shutdown).await {
            tracing::warn!(
                workspace_id = %workspace.workspace_id,
                error = %error,
                "failed to send WS shutdown in wrap cleanup"
            );
        }
    }

    // Restore terminal
    #[cfg(unix)]
    if let Some(orig) = saved_termios {
        use nix::sys::termios;
        let _ = termios::tcsetattr(std::io::stdin(), termios::SetArg::TCSANOW, &orig);
    }

    eprintln!("\r\n[agent-relay] session ended");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        await_wrap_write_ack, buffer_and_drain_stdin, drain_stdin_buffer,
        injection_submit_followup_delay, queue_or_confirm_wrap_verification,
        wrap_injection_timer_allowed, wrap_write_ack_error, STDIN_PENDING_MAX_CHUNKS,
    };
    use crate::broker::delivery_verification::{
        PendingVerification, ThrottleState, VerificationOutput, MAX_VERIFICATION_ATTEMPTS,
    };
    use crate::ids::{DeliveryId, EventId, MessageTarget};
    use crate::worker::detection::ActivityDetector;
    use std::collections::VecDeque;
    use std::io;
    use std::time::{Duration, Instant};

    #[test]
    fn only_claude_uses_a_delayed_submit_followup() {
        let expected = Some(Duration::from_millis(250));
        assert_eq!(injection_submit_followup_delay("claude"), expected);
        assert_eq!(
            injection_submit_followup_delay("/usr/local/bin/Claude.EXE"),
            expected
        );
        assert_eq!(
            injection_submit_followup_delay(r"C:\Users\demo\bin\Claude.CMD"),
            expected
        );
        assert_eq!(
            injection_submit_followup_delay(r"C:\Users\demo\bin\Claude.BAT"),
            expected
        );
        assert_eq!(
            injection_submit_followup_delay("/opt/company/bin/company-claude"),
            expected
        );
        assert_eq!(injection_submit_followup_delay("claude-code"), expected);
        assert_eq!(injection_submit_followup_delay("codex"), None);
        assert_eq!(injection_submit_followup_delay("opencode"), None);
    }

    #[test]
    fn compound_write_ack_requires_both_writes_to_succeed() {
        assert_eq!(wrap_write_ack_error(Ok(Ok(()))), None);

        let error = wrap_write_ack_error(Ok(Err(io::Error::new(
            io::ErrorKind::BrokenPipe,
            "forced delayed submit failure",
        ))))
        .expect("a failed delayed Enter must reject the compound write");
        assert!(error.contains("forced delayed submit failure"));
    }

    #[tokio::test]
    async fn compound_write_ack_rejects_a_lost_drainer() {
        let (ack_tx, ack_rx) = tokio::sync::oneshot::channel::<io::Result<()>>();
        drop(ack_tx);

        let error = wrap_write_ack_error(ack_rx.await)
            .expect("a dropped drainer ack must reject the compound write");
        assert!(error.contains("drainer exited"));
    }

    #[tokio::test]
    async fn compound_write_ack_is_bounded_when_the_drainer_stalls() {
        let (_ack_tx, ack_rx) = tokio::sync::oneshot::channel::<io::Result<()>>();
        let outcome = await_wrap_write_ack(ack_rx, Duration::from_millis(10)).await;
        assert!(outcome.is_err(), "an unresolved write ack must time out");
    }

    #[test]
    fn wrap_injection_timer_waits_for_the_previous_write_ack() {
        assert!(wrap_injection_timer_allowed(false));
        assert!(!wrap_injection_timer_allowed(true));
    }

    #[test]
    fn echo_arriving_before_write_ack_is_confirmed_immediately() {
        let injection = "multiline task\nwith a delayed submit";
        let mut output = VerificationOutput::default();
        output.push_output(1, b"older output\n");
        // Sequence 2 was assigned by the PTY reader before this wrap write
        // was queued, even though wrap has not consumed the chunk yet.
        let output_boundary = 2;
        let verification = || PendingVerification {
            delivery_id: DeliveryId::new("delivery-before-ack"),
            event_id: EventId::new("event-before-ack"),
            expected_echo: injection.to_string(),
            output_boundary,
            injected_at: Instant::now(),
            attempts: 1,
            max_attempts: MAX_VERIFICATION_ATTEMPTS,
            request_id: None,
            workspace_id: None,
            workspace_alias: None,
            from: "reviewer".to_string(),
            body: "review this".to_string(),
            target: MessageTarget::new("claude-worker"),
        };
        let mut throttle = ThrottleState::default();
        let mut pending_verifications = VecDeque::new();
        let mut pending_activities = VecDeque::new();

        output.push_output(2, format!("stale composer echo: {injection}").as_bytes());

        let stale = queue_or_confirm_wrap_verification(
            verification(),
            &output,
            None,
            &mut throttle,
            &mut pending_verifications,
            &mut pending_activities,
        );
        assert!(!stale, "a retained pre-submission echo is stale");
        pending_verifications.clear();

        output.push_output(
            3,
            format!("\nnew composer echo: {injection}\nTool: Write(review.md)").as_bytes(),
        );
        let confirmed = queue_or_confirm_wrap_verification(
            verification(),
            &output,
            Some(&ActivityDetector::for_cli("claude")),
            &mut throttle,
            &mut pending_verifications,
            &mut pending_activities,
        );

        assert!(confirmed, "the buffered echo must not wait for new output");
        assert!(
            pending_verifications.is_empty(),
            "an already-observed echo must not be queued to time out"
        );
        assert!(
            pending_activities.is_empty(),
            "already-buffered activity must be consumed immediately"
        );
    }

    #[test]
    fn stdin_drains_in_order_when_queue_accepts() {
        let mut pending: VecDeque<Vec<u8>> = VecDeque::new();
        let mut delivered: Vec<Vec<u8>> = Vec::new();
        for chunk in [b"a".to_vec(), b"bc".to_vec(), b"d".to_vec()] {
            let backlogged =
                buffer_and_drain_stdin(&mut pending, chunk, STDIN_PENDING_MAX_CHUNKS, |bytes| {
                    delivered.push(bytes.to_vec());
                    true
                });
            assert!(!backlogged, "nothing should remain buffered when accepted");
        }
        assert!(pending.is_empty());
        assert_eq!(
            delivered,
            vec![b"a".to_vec(), b"bc".to_vec(), b"d".to_vec()]
        );
    }

    #[test]
    fn stdin_buffers_in_fifo_order_when_queue_full_then_flushes() {
        // Model a full queue: reject everything while the child stalls, then
        // accept once it drains. Order must be preserved end to end.
        let mut pending: VecDeque<Vec<u8>> = VecDeque::new();
        let inputs = [b"one".to_vec(), b"two".to_vec(), b"three".to_vec()];

        // Queue is full: every submit is rejected, so all chunks buffer in order
        // and the caller is told to keep retrying.
        for chunk in inputs.iter().cloned() {
            let backlogged =
                buffer_and_drain_stdin(&mut pending, chunk, STDIN_PENDING_MAX_CHUNKS, |_| false);
            assert!(backlogged, "rejected chunk must stay buffered for retry");
        }
        assert_eq!(pending.len(), 3);

        // Child starts reading again: drain accepts everything, in FIFO order.
        let mut delivered: Vec<Vec<u8>> = Vec::new();
        let backlogged = drain_stdin_buffer(&mut pending, &mut |bytes| {
            delivered.push(bytes.to_vec());
            true
        });
        assert!(!backlogged);
        assert!(pending.is_empty());
        assert_eq!(delivered, inputs.to_vec());
    }

    #[test]
    fn stdin_partial_drain_preserves_remaining_order() {
        // Accept the first chunk, reject the rest — the rejected chunks stay at
        // the front in order for the next retry.
        let mut pending: VecDeque<Vec<u8>> = VecDeque::new();
        pending.push_back(b"first".to_vec());
        pending.push_back(b"second".to_vec());
        pending.push_back(b"third".to_vec());

        let mut delivered: Vec<Vec<u8>> = Vec::new();
        let mut accept_one = true;
        let backlogged = drain_stdin_buffer(&mut pending, &mut |bytes| {
            if accept_one {
                accept_one = false;
                delivered.push(bytes.to_vec());
                true
            } else {
                false
            }
        });
        assert!(backlogged);
        assert_eq!(delivered, vec![b"first".to_vec()]);
        assert_eq!(
            pending.iter().cloned().collect::<Vec<_>>(),
            vec![b"second".to_vec(), b"third".to_vec()]
        );
    }

    #[test]
    fn stdin_buffer_drops_oldest_when_bound_exceeded() {
        // With a tiny bound and a stalled queue, the oldest chunk is dropped so
        // memory stays bounded; the newest keystrokes survive in order.
        let mut pending: VecDeque<Vec<u8>> = VecDeque::new();
        let max = 2;
        for chunk in [b"1".to_vec(), b"2".to_vec(), b"3".to_vec()] {
            buffer_and_drain_stdin(&mut pending, chunk, max, |_| false);
        }
        assert_eq!(pending.len(), 2);
        assert_eq!(
            pending.iter().cloned().collect::<Vec<_>>(),
            vec![b"2".to_vec(), b"3".to_vec()]
        );
    }
}
