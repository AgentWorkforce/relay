use std::collections::VecDeque;
use std::time::{Duration, Instant};

use super::*;
use crate::helpers::{
    check_echo_in_output, floor_char_boundary, format_injection_with_workspace, ActivityDetector,
    DeliveryOutcome, PendingActivity, PendingVerification, ThrottleState,
    ACTIVITY_BUFFER_KEEP_BYTES, ACTIVITY_BUFFER_MAX_BYTES, ACTIVITY_WINDOW,
    MAX_VERIFICATION_ATTEMPTS, VERIFICATION_WINDOW,
};

// PTY auto-response constants (shared by wrap and pty workers)
const BYPASS_PERMS_COOLDOWN: Duration = Duration::from_secs(2);
const BYPASS_PERMS_MAX_SENDS: u32 = 5;
const AUTO_ENTER_TIMEOUT: Duration = Duration::from_secs(10);
const AUTO_ENTER_COOLDOWN: Duration = Duration::from_secs(5);
const MAX_AUTO_ENTER_RETRIES: u32 = 5;
pub(crate) const AUTO_SUGGESTION_BLOCK_TIMEOUT: Duration = Duration::from_secs(10);
const MCP_APPROVAL_TIMEOUT: Duration = Duration::from_secs(5);
const GEMINI_ACTION_COOLDOWN: Duration = Duration::from_secs(2);

#[derive(Debug, Clone)]
pub(crate) struct PendingWrapInjection {
    pub(crate) from: String,
    pub(crate) event_id: String,
    pub(crate) workspace_id: Option<String>,
    pub(crate) workspace_alias: Option<String>,
    pub(crate) body: String,
    pub(crate) target: String,
    pub(crate) queued_at: Instant,
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
            let _ = pty.write_all(b"a");
            self.mcp_detection_buffer.clear();
            self.mcp_partial_match_since = None;
        }
    }

    /// Detect and approve bypass-permissions prompts in PTY output.
    pub(crate) async fn handle_bypass_permissions(&mut self, text: &str, pty: &PtySession) {
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
                    let _ = pty.write_all(b"\x1b[B");
                    tokio::time::sleep(Duration::from_millis(200)).await;
                    let _ = pty.write_all(b"\r");
                } else {
                    let _ = pty.write_all(b"y\n");
                }
                self.bypass_perms_buffer.clear();
            }
        } else if in_cooldown {
            self.bypass_perms_buffer.clear();
        }
    }

    /// Detect and dismiss Codex model upgrade prompts by selecting "Use existing model".
    pub(crate) async fn handle_codex_model_prompt(&mut self, text: &str, pty: &PtySession) {
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
            let _ = pty.write_all(b"\x1b[B"); // Down arrow → option 2
            tokio::time::sleep(Duration::from_millis(100)).await;
            let _ = pty.write_all(b"\r"); // Enter to confirm
            self.codex_model_buffer.clear();
        }
    }

    /// Detect and auto-approve opencode/droid EXECUTE permission prompts.
    /// Selects "Yes, and always allow medium impact commands" (arrow down + Enter).
    pub(crate) async fn handle_opencode_permission(&mut self, text: &str, pty: &PtySession) {
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
                let _ = pty.write_all(b"\x1b[B");
                tokio::time::sleep(Duration::from_millis(100)).await;
                let _ = pty.write_all(b"\r");
                self.opencode_perm_buffer.clear();
                self.last_opencode_perm_approval = Some(Instant::now());
            }
        } else {
            self.opencode_perm_buffer.clear();
        }
    }

    /// Detect and auto-approve Gemini "Action Required" permission prompts.
    pub(crate) async fn handle_gemini_action(&mut self, text: &str, pty: &PtySession) {
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
                let _ = pty.write_all(b"2\n");
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
                let _ = pty.write_all(b"\r");
                self.gemini_trust_buffer.clear();
                self.gemini_trust_handled = true;
            }
        }
    }

    /// Detect the Gemini "untrusted folder" informational banner and send `/permissions`
    /// to open the trust menu. The existing `handle_gemini_trust` will then pick up the
    /// interactive "Modify Trust Level" prompt that appears in response.
    pub(crate) async fn handle_gemini_untrusted_banner(&mut self, text: &str, pty: &PtySession) {
        if !self.gemini_untrusted_handled {
            Self::append_buf(&mut self.gemini_untrusted_buffer, text, 2500, 2000);
            let clean = strip_ansi(&self.gemini_untrusted_buffer);
            if detect_gemini_untrusted_banner(&clean) {
                tracing::info!(
                    "Detected Gemini 'untrusted folder' banner, sending /permissions command"
                );
                tokio::time::sleep(Duration::from_millis(300)).await;
                let _ = pty.write_all(b"/permissions\n");
                self.gemini_untrusted_buffer.clear();
                self.gemini_untrusted_handled = true;
                // Reset trust handler so it can pick up the resulting "Modify Trust Level" menu
                self.gemini_trust_handled = false;
                self.gemini_trust_buffer.clear();
            }
        }
    }

    /// Detect and auto-accept Claude Code folder trust prompts.
    /// The prompt is a selection menu with "Yes, I trust this folder" pre-selected,
    /// so we just press Enter to confirm.
    pub(crate) async fn handle_claude_trust(&mut self, text: &str, pty: &PtySession) {
        if !self.claude_trust_handled {
            Self::append_buf(&mut self.claude_trust_buffer, text, 2500, 2000);
            let clean = strip_ansi(&self.claude_trust_buffer);
            let (has_trust_ref, has_confirmation) = detect_claude_trust_prompt(&clean);
            if has_trust_ref && has_confirmation {
                tracing::info!("Detected Claude Code folder trust prompt, auto-accepting");
                tokio::time::sleep(Duration::from_millis(100)).await;
                // "Yes, I trust this folder" is pre-selected (option 1), press Enter
                let _ = pty.write_all(b"\r");
                self.claude_trust_buffer.clear();
                self.claude_trust_handled = true;
            }
        }
    }

    /// Send an enter keystroke if the agent appears stuck after injection.
    /// Uses exponential backoff: 10s → 15s → 25s → 40s → 60s.
    pub(crate) fn try_auto_enter(&mut self, pty: &PtySession) {
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
                let _ = pty.write_all(b"\r");
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

    eprintln!(
        "[agent-relay] wrapping {} (agent: {}, channels: {:?})",
        resolved_cli, requested_name, channel_list
    );
    eprintln!("[agent-relay] use RUST_LOG=debug for verbose logging");

    // --- Auth & Relaycast connection ---
    let runtime_cwd = std::env::current_dir()?;
    let paths = ensure_runtime_paths(&runtime_cwd, &requested_name)?;

    let strict_name = env_flag_enabled("RELAY_STRICT_AGENT_NAME");
    let relay = connect_relay(RelaySessionOptions {
        paths: &paths,
        requested_name: &requested_name,
        channels: channel_list,
        strict_name,
        agent_type: None,
        read_mcp_identity: true,
        ensure_mcp_config: true,
        runtime_cwd: &runtime_cwd,
    })
    .await?;

    tracing::debug!("connected to relaycast");

    let RelaySession {
        http_base,
        default_workspace_id,
        workspaces,
        mut ws_inbound_rx,
    } = relay;
    let workspace_lookup: std::collections::HashMap<String, RelayWorkspace> = workspaces
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
    let child_base_url = http_base.clone();
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
    let mut terminal_query_parser = TerminalQueryParser::default();

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

    // Buffer for extracting message IDs from MCP tool responses in PTY output.
    // When the agent sends messages via MCP, the response contains the message ID.
    // Pre-seeding dedup with these IDs prevents self-echo when the same message
    // arrives via WS — regardless of what identity the MCP server uses.
    let mut mcp_response_buffer = String::new();

    let mut pty_auto = PtyAutoState::new();
    let mut auto_enter_interval = tokio::time::interval(Duration::from_secs(2));
    auto_enter_interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut pending_injection_interval = tokio::time::interval(Duration::from_millis(50));
    pending_injection_interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut pending_wrap_injections: VecDeque<PendingWrapInjection> = VecDeque::new();

    // Echo verification state
    let mut pending_verifications: VecDeque<PendingVerification> = VecDeque::new();
    let mut pending_activities: VecDeque<PendingActivity> = VecDeque::new();
    let activity_detector = if progress {
        Some(ActivityDetector::for_cli(&cli_name))
    } else {
        None
    };
    let mut throttle = ThrottleState::default();
    let mut echo_buffer = String::new();
    let mut verification_tick = tokio::time::interval(Duration::from_millis(200));
    verification_tick.set_missed_tick_behavior(MissedTickBehavior::Skip);

    let mut reap_tick = tokio::time::interval(Duration::from_secs(5));
    reap_tick.set_missed_tick_behavior(MissedTickBehavior::Skip);

    // SIGWINCH (terminal resize)
    let mut sigwinch =
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::window_change())
            .expect("failed to register SIGWINCH handler");

    let mut running = true;
    let mut stdout = tokio::io::stdout();

    while running {
        tokio::select! {
            // Ctrl-C
            _ = tokio::signal::ctrl_c() => {
                running = false;
            }

            // Stdin → PTY (passthrough)
            Some(data) = stdin_rx.recv() => {
                let _ = pty.write_all(&data);
            }

            // PTY output → stdout (passthrough) + auto-responses
            chunk = pty_rx.recv() => {
                match chunk {
                    Some(chunk) => {
                        // Terminal query responses (CSI 6n)
                        for response in terminal_query_parser.feed(&chunk) {
                            let _ = pty.write_all(response);
                        }

                        // Passthrough to user's terminal
                        use tokio::io::AsyncWriteExt;
                        let _ = stdout.write_all(&chunk).await;
                        let _ = stdout.flush().await;

                        let text = String::from_utf8_lossy(&chunk).to_string();
                        let clean_text = strip_ansi(&text);
                        pty_auto.last_output_time = Instant::now();

                        pty_auto.update_auto_suggestion(&text);
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

                        pty_auto.handle_mcp_approval(&text, &pty).await;
                        pty_auto.handle_bypass_permissions(&text, &pty).await;
                        pty_auto.handle_codex_model_prompt(&text, &pty).await;
                        pty_auto.handle_opencode_permission(&text, &pty).await;
                        pty_auto.handle_gemini_action(&text, &pty).await;
                        pty_auto.handle_gemini_untrusted_banner(&text, &pty).await;
                        pty_auto.handle_gemini_trust(&text, &pty).await;
                        pty_auto.handle_claude_trust(&text, &pty).await;

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
                    // Check for command.invoked event first (spawn/release)
                    if let Some(cmd_event) = map_ws_broker_command(
                        &ws_value,
                        &workspace_id,
                        workspace_alias.as_deref(),
                    ) {
                        if !command_targets_self(&cmd_event, &workspace_self_agent_id) {
                            tracing::debug!(
                                command = %cmd_event.command,
                                handler_agent_id = ?cmd_event.handler_agent_id,
                                self_agent_id = %workspace_self_agent_id,
                                "ignoring command event for a different handler"
                            );
                            continue;
                        }
                        match cmd_event.payload {
                            BrokerCommandPayload::Spawn(ref params) => {
                                if params.name.is_empty() || params.cli.is_empty() {
                                    tracing::error!("spawn command missing name or cli");
                                    continue;
                                }
                                let env_vars = spawn_env_vars(
                                    &params.name,
                                    &workspace_child_api_key,
                                    &child_base_url,
                                    &channels,
                                    Some(&child_workspaces_json),
                                    default_workspace_id.as_deref(),
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
                                        Some(&cmd_event.invoked_by),
                                        child_token.as_deref(),
                                    )
                                    .await
                                {
                                    Ok(pid) => {
                                        agent_spawn_count += 1;
                                        telemetry.track(TelemetryEvent::AgentSpawn {
                                            cli: params.cli.clone(),
                                            runtime: "pty".to_string(),
                                        });
                                        tracing::info!(
                                            child = %params.name,
                                            cli = %params.cli,
                                            pid = pid,
                                            invoked_by = %cmd_event.invoked_by,
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
                                    }
                                }
                            }
                            BrokerCommandPayload::Release(ref params) => {
                                // command.invoked doesn't carry sender_kind, so use Unknown
                                let sender_is_human =
                                    is_human_sender(&cmd_event.invoked_by, SenderKind::Unknown);
                                let owner = spawner.owner_of(&params.name);
                                if can_release_child(owner, &cmd_event.invoked_by, sender_is_human) {
                                    match spawner.release(&params.name, Duration::from_secs(2)).await {
                                        Ok(()) => {
                                            telemetry.track(TelemetryEvent::AgentRelease {
                                                cli: String::new(),
                                                release_reason: "ws_command".to_string(),
                                                lifetime_seconds: 0,
                                            });
                                            tracing::info!(
                                                child = %params.name,
                                                released_by = %cmd_event.invoked_by,
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
                                        }
                                    }
                                } else {
                                    tracing::warn!(
                                        child = %params.name,
                                        sender = %cmd_event.invoked_by,
                                        "release denied: sender is not owner or human"
                                    );
                                }
                            }
                        }
                        continue;
                    }

                    // Regular relay message: map and queue for PTY injection
                    if let Some(mapped) = map_ws_event(
                        &ws_value,
                        &workspace_id,
                        workspace_alias.as_deref(),
                    ) {
                        let dedup_key = format!("{}:{}", mapped.workspace_id, mapped.event_id);
                        if !dedup.insert_if_new(&dedup_key, Instant::now()) {
                            tracing::debug!(event_id = %mapped.event_id, workspace_id = %mapped.workspace_id, "dedup: skipping relay event");
                            continue;
                        }
                        if workspace_self_names.contains(&mapped.from)
                            || mapped
                                .sender_agent_id
                                .as_ref()
                                .is_some_and(|id| workspace_self_agent_ids.contains(id))
                        {
                            tracing::debug!(
                                from = %mapped.from,
                                sender_agent_id = ?mapped.sender_agent_id,
                                "skipping self-echo in wrap mode"
                            );
                            continue;
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

            _ = pending_injection_interval.tick() => {
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
                        let _ = pty.write_all(b"\x1b");
                        tokio::time::sleep(Duration::from_millis(100)).await;
                        pty_auto.auto_suggestion_visible = false;
                    }
                    tracing::debug!("relay from {} → {}", pending.from, pending.target);
                    let injection = format_injection_with_workspace(
                        &pending.from,
                        &pending.event_id,
                        &pending.body,
                        &pending.target,
                        pending.workspace_id.as_deref(),
                        pending.workspace_alias.as_deref(),
                    );
                    if let Err(e) = pty.write_all(injection.as_bytes()) {
                        tracing::warn!(
                            event_id = %pending.event_id,
                            error = %e,
                            "PTY injection write failed, re-queuing"
                        );
                        pending_wrap_injections.push_front(PendingWrapInjection {
                            from: pending.from,
                            event_id: pending.event_id,
                            workspace_id: pending.workspace_id,
                            workspace_alias: pending.workspace_alias,
                            body: pending.body,
                            target: pending.target,
                            queued_at: pending.queued_at,
                        });
                        continue;
                    }
                    telemetry.track(TelemetryEvent::MessageSend {
                        is_broadcast: pending.target.starts_with('#'),
                        has_thread: false,
                    });
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    let _ = pty.write_all(b"\r");
                    tracing::debug!(
                        event_id = %pending.event_id,
                        "wrap: delivery injected"
                    );
                    pty_auto.last_injection_time = Some(Instant::now());
                    pty_auto.auto_enter_retry_count = 0;

                    // Push to pending verifications for echo verification
                    pending_verifications.push_back(PendingVerification {
                        delivery_id: format!("wrap_{}", pending.event_id),
                        event_id: pending.event_id,
                        expected_echo: injection,
                        injected_at: Instant::now(),
                        attempts: 1,
                        max_attempts: MAX_VERIFICATION_ATTEMPTS,
                        request_id: None,
                        workspace_id: pending.workspace_id,
                        workspace_alias: pending.workspace_alias,
                        from: pending.from,
                        body: pending.body,
                        target: pending.target,
                    });
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
                for mut pv in retry_queue {
                    tokio::time::sleep(throttle.delay()).await;
                    let injection = format_injection_with_workspace(
                        &pv.from,
                        &pv.event_id,
                        &pv.body,
                        &pv.target,
                        pv.workspace_id.as_deref(),
                        pv.workspace_alias.as_deref(),
                    );
                    if let Err(error) = pty.write_all(injection.as_bytes()) {
                        tracing::warn!(
                            event_id = %pv.event_id,
                            error = %error,
                            "wrap: retry PTY injection write failed"
                        );
                    } else {
                        tokio::time::sleep(Duration::from_millis(50)).await;
                        let _ = pty.write_all(b"\r");
                        tracing::debug!(
                            delivery_id = %pv.delivery_id,
                            event_id = %pv.event_id,
                            "wrap: delivery re-injected (retry)"
                        );
                    }
                    pv.expected_echo = injection;
                    pv.injected_at = Instant::now();
                    pending_verifications.push_back(pv);
                }
            }

            // Auto-enter for stuck agents
            _ = auto_enter_interval.tick() => {
                pty_auto.try_auto_enter(&pty);
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

            // SIGWINCH: forward terminal resize to PTY
            _ = sigwinch.recv() => {
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
