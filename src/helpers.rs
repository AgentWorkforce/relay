use std::{
    ffi::OsStr,
    path::Path,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use anyhow::{anyhow, Result};
use serde_json::{json, Value};

pub(crate) const ACTIVITY_WINDOW: Duration = Duration::from_secs(5);
pub(crate) const ACTIVITY_BUFFER_MAX_BYTES: usize = 16_000;
pub(crate) const ACTIVITY_BUFFER_KEEP_BYTES: usize = 12_000;

/// Parse a CLI command string into executable and embedded arguments.
///
/// Supports shell-style quoting, e.g.:
/// - `claude --model haiku`
/// - `codex --profile "my profile"`
pub(crate) fn parse_cli_command(raw: &str) -> Result<(String, Vec<String>)> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(anyhow!("CLI command cannot be empty"));
    }

    let parts = shlex::split(trimmed)
        .ok_or_else(|| anyhow!("invalid CLI command syntax (check quoting)"))?;
    let (command, args) = parts
        .split_first()
        .ok_or_else(|| anyhow!("CLI command cannot be empty"))?;
    let command = command.to_string();
    let mut args = args.to_vec();

    let cli_lower = normalize_cli_name(&command).to_lowercase();
    if cli_lower == "cursor" && !args.iter().any(|arg| arg == "--force") {
        args.insert(0, "--force".to_string());
    }

    Ok((command, args))
}

/// Best-effort normalized CLI name for feature detection.
/// If `cli` is a path, returns the executable file name.
pub(crate) fn normalize_cli_name(cli: &str) -> String {
    Path::new(cli)
        .file_name()
        .and_then(OsStr::to_str)
        .unwrap_or(cli)
        .to_string()
}

#[derive(Debug, Clone, Copy)]
pub(crate) enum DeliveryOutcome {
    Success,
    #[allow(dead_code)]
    Failed,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct ThrottleState {
    delay: Duration,
    consecutive_failures: u32,
    consecutive_successes: u32,
}

impl Default for ThrottleState {
    fn default() -> Self {
        Self {
            delay: Duration::from_millis(100),
            consecutive_failures: 0,
            consecutive_successes: 0,
        }
    }
}

impl ThrottleState {
    pub(crate) fn delay(&self) -> Duration {
        self.delay
    }

    pub(crate) fn record(&mut self, outcome: DeliveryOutcome) {
        match outcome {
            DeliveryOutcome::Success => {
                self.consecutive_failures = 0;
                self.consecutive_successes += 1;
                if self.consecutive_successes >= 3 {
                    self.consecutive_successes = 0;
                    let halved = Duration::from_millis(self.delay.as_millis() as u64 / 2);
                    self.delay = halved.max(Duration::from_millis(100));
                }
            }
            DeliveryOutcome::Failed => {
                self.consecutive_successes = 0;
                self.consecutive_failures += 1;
                self.delay = match self.consecutive_failures {
                    1 => Duration::from_millis(100),
                    2 => Duration::from_millis(200),
                    3 => Duration::from_millis(500),
                    4 => Duration::from_millis(1_000),
                    5 => Duration::from_millis(2_000),
                    _ => Duration::from_millis(5_000),
                };
            }
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct PendingActivity {
    pub delivery_id: String,
    pub event_id: String,
    pub expected_echo: String,
    pub verified_at: Instant,
    pub output_buffer: String,
    pub detector: ActivityDetector,
}

#[derive(Debug, Clone)]
pub(crate) struct ActivityDetector {
    patterns: Vec<&'static str>,
}

impl ActivityDetector {
    pub(crate) fn for_cli(cli: &str) -> Self {
        let lower = cli.to_lowercase();
        let patterns = if lower.contains("claude") {
            vec!["⠋", "⠙", "⠹", "Tool:", "Read(", "Write(", "Edit("]
        } else if lower.contains("codex") {
            vec!["Thinking...", "Running:", "$ ", "function_call"]
        } else if lower.contains("gemini") {
            vec!["Generating", "Action:", "Executing"]
        } else {
            Vec::new()
        };

        Self { patterns }
    }

    pub(crate) fn detect_activity(&self, output: &str, expected_echo: &str) -> Option<String> {
        let clean_output = strip_ansi(output);
        let relevant_output = if let Some(pos) = clean_output.find(expected_echo) {
            let before = &clean_output[..pos];
            let after = &clean_output[pos + expected_echo.len()..];
            format!("{before}{after}")
        } else {
            clean_output
        };

        if self.patterns.is_empty() {
            if relevant_output.trim().is_empty() {
                None
            } else {
                Some("any_output".to_string())
            }
        } else {
            self.patterns
                .iter()
                .find(|pattern| relevant_output.contains(**pattern))
                .map(|pattern| (*pattern).to_string())
        }
    }
}

/// Maximum number of injection attempts before accepting delivery via timeout.
/// Set to 1 to avoid re-injecting the same message when echo detection fails —
/// duplicate injections cause agents to process messages multiple times,
/// multiplying Relaycast API calls and triggering rate limits.
pub(crate) const MAX_VERIFICATION_ATTEMPTS: usize = 1;

/// Time window to wait for echo verification before accepting delivery.
pub(crate) const VERIFICATION_WINDOW: std::time::Duration = std::time::Duration::from_secs(5);

/// A pending delivery waiting for echo verification in PTY output.
#[derive(Debug)]
pub(crate) struct PendingVerification {
    pub delivery_id: String,
    pub event_id: String,
    pub expected_echo: String,
    pub injected_at: std::time::Instant,
    pub attempts: usize,
    pub max_attempts: usize,
    pub request_id: Option<String>,
    pub from: String,
    pub body: String,
    pub target: String,
}

/// Check if the expected echo string appears in PTY output (after stripping ANSI).
pub(crate) fn check_echo_in_output(output: &str, expected: &str) -> bool {
    let clean = strip_ansi(output);
    clean.contains(expected)
}

/// Detect whether a CLI has finished startup and is ready to receive input.
/// Checks for known prompt patterns (from relay-pty parser) and a byte-count fallback.
pub(crate) fn detect_cli_ready(cli: &str, output: &str, total_bytes: usize) -> bool {
    let clean = strip_ansi(output);
    let lower_cli = cli.to_lowercase();

    // Explicit ready signal from relay protocol
    if clean.contains("->pty:ready") {
        return true;
    }

    // Prompt patterns (from relay-pty parser.rs)
    // ›  = U+203A (single right-pointing angle quotation mark)
    // ❯  = U+276F (heavy right-pointing angle quotation mark, Claude Code v2.1.52+)
    let prompt_patterns: &[&str] = if lower_cli.contains("codex") {
        &["> ", "$ ", "codex> ", ">>> ", "›", "❯"]
    } else {
        &["> ", "$ ", ">>> ", "›", "❯"]
    };

    // Check last 500 chars of output for prompt patterns
    let check_region = if clean.len() > 500 {
        let start = floor_char_boundary(&clean, clean.len() - 500);
        &clean[start..]
    } else {
        &clean
    };

    for pattern in prompt_patterns {
        if check_region.contains(pattern) {
            return true;
        }
    }

    // Fallback: CLI produced substantial output (startup complete)
    total_bytes > 500
}

#[derive(Debug, Clone, Copy, Default)]
pub(crate) enum TerminalQueryState {
    #[default]
    Idle,
    Esc,
    Csi,
    CsiQmark,
    Csi6,
    CsiQmark6,
    /// CSI 0 — could be DA1 param (ESC [ 0 c)
    Csi0,
    /// CSI 5 — could be DSR (ESC [ 5 n)
    Csi5,
    /// CSI > — DA2 prefix (ESC [ > c)
    CsiGt,
}

#[derive(Debug, Default)]
pub(crate) struct TerminalQueryParser {
    pub(crate) state: TerminalQueryState,
}

impl TerminalQueryParser {
    pub(crate) fn feed(&mut self, chunk: &[u8]) -> Vec<&'static [u8]> {
        const ESC: u8 = 0x1b;
        const CSI: u8 = b'[';
        const QMARK: u8 = b'?';
        const SIX: u8 = b'6';
        const N: u8 = b'n';

        let mut out = Vec::new();
        for byte in chunk {
            self.state = match (self.state, *byte) {
                (_, ESC) => TerminalQueryState::Esc,
                (TerminalQueryState::Esc, CSI) => TerminalQueryState::Csi,
                (TerminalQueryState::Csi, QMARK) => TerminalQueryState::CsiQmark,
                (TerminalQueryState::Csi, b'>') => TerminalQueryState::CsiGt,
                (TerminalQueryState::Csi, SIX) => TerminalQueryState::Csi6,
                (TerminalQueryState::Csi, b'0') => TerminalQueryState::Csi0,
                (TerminalQueryState::Csi, b'5') => TerminalQueryState::Csi5,
                (TerminalQueryState::CsiQmark, SIX) => TerminalQueryState::CsiQmark6,
                // CSI 6 n → Cursor Position Report (CPR)
                (TerminalQueryState::Csi6, N) => {
                    out.push(b"\x1b[1;1R".as_slice());
                    TerminalQueryState::Idle
                }
                (TerminalQueryState::CsiQmark6, N) => {
                    out.push(b"\x1b[?1;1R".as_slice());
                    TerminalQueryState::Idle
                }
                // CSI c → DA1 (Device Attributes primary, no params)
                (TerminalQueryState::Csi, b'c') => {
                    out.push(b"\x1b[?1;2c".as_slice()); // VT100 with AVO
                    TerminalQueryState::Idle
                }
                // CSI 0 c → DA1 with explicit 0 param
                (TerminalQueryState::Csi0, b'c') => {
                    out.push(b"\x1b[?1;2c".as_slice());
                    TerminalQueryState::Idle
                }
                // CSI > c → DA2 (Device Attributes secondary)
                (TerminalQueryState::CsiGt, b'c') => {
                    out.push(b"\x1b[>1;10;0c".as_slice()); // VT100, version 10
                    TerminalQueryState::Idle
                }
                // CSI 5 n → DSR (Device Status Report)
                (TerminalQueryState::Csi5, N) => {
                    out.push(b"\x1b[0n".as_slice()); // terminal OK
                    TerminalQueryState::Idle
                }
                _ => TerminalQueryState::Idle,
            };
        }
        out
    }
}

#[cfg(test)]
pub(crate) fn terminal_query_responses(chunk: &[u8]) -> Vec<&'static [u8]> {
    let mut parser = TerminalQueryParser::default();
    parser.feed(chunk)
}

fn sender_display_name(from: &str) -> &str {
    let normalized = from
        .strip_prefix("human:")
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or(from);

    if is_broker_identity(normalized) {
        "Dashboard"
    } else {
        normalized
    }
}

fn sender_reply_target(from: &str) -> &str {
    from.strip_prefix("human:")
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or(from)
}

fn is_broker_identity(name: &str) -> bool {
    let trimmed = name.trim();
    let Some(rest) = trimmed.strip_prefix("broker-") else {
        return false;
    };
    !rest.is_empty() && rest.chars().all(|ch| ch.is_ascii_alphanumeric())
}

fn detect_channel_context(message: &str, target: &str) -> Option<String> {
    if target.starts_with('#') {
        return Some(target.trim().to_string());
    }
    if let Some(start) = message.find("[#") {
        let rest = &message[start + 1..];
        if let Some(end) = rest.find(']') {
            let channel = rest[..end].trim();
            if channel.starts_with('#') && channel.len() > 1 {
                return Some(channel.to_string());
            }
        }
    }
    if let Some(start) = message.find(" in #") {
        let rest = &message[start + 4..];
        let end = rest.find([' ', ':', ']', '\n']).unwrap_or(rest.len());
        let candidate = rest[..end].trim();
        if candidate.starts_with('#') && candidate.len() > 1 {
            return Some(candidate.to_string());
        }
    }
    None
}

fn build_mcp_reminder(
    sender: &str,
    target: &str,
    relay_line: &str,
    pre_registered: bool,
    assigned_name: Option<&str>,
) -> String {
    let sender_name = sender_display_name(sender);
    let reply_target = sender_reply_target(sender);
    let channel_context = detect_channel_context(relay_line, target);
    let channel_hint = channel_context
        .as_deref()
        .unwrap_or("#general")
        .trim_start_matches('#');

    // Tool names differ by MCP client: Claude uses mcp__relaycast__<tool>,
    // Codex/others use relaycast.<tool>.  Include both so any agent can act.
    let dm_hint = if reply_target.eq_ignore_ascii_case(sender_name) {
        format!(
            "- For direct replies to \"{sender_name}\", use mcp__relaycast__send_dm or relaycast.send_dm (to: \"{sender_name}\")."
        )
    } else {
        format!(
            "- For direct replies to \"{sender_name}\", use mcp__relaycast__send_dm or relaycast.send_dm (to: \"{reply_target}\")."
        )
    };
    let channel_hint_line = format!(
        "- For channel replies, use mcp__relaycast__post_message or relaycast.post_message (channel: \"{channel_hint}\")."
    );

    let registration_lines: [String; 2] = if pre_registered {
        [
            "You are pre-registered by the broker under your assigned worker name.".to_string(),
            "Do not call mcp__relaycast__register unless a send/reply fails with \"Not registered\"."
                .to_string(),
        ]
    } else if let Some(name) = assigned_name {
        [
            "This worker was not pre-registered by the broker.".to_string(),
            format!(
                "Before replying, call mcp__relaycast__register (name: \"{name}\", type: \"agent\")."
            ),
        ]
    } else {
        [
            "This worker was not pre-registered by the broker.".to_string(),
            "Before replying, call mcp__relaycast__register (name: \"<worker-name>\", type: \"agent\")."
                .to_string(),
        ]
    };

    [
        "<system-reminder>".to_string(),
        "Relaycast MCP tools are available for replies.".to_string(),
        registration_lines[0].clone(),
        registration_lines[1].clone(),
        dm_hint,
        channel_hint_line,
        "- For thread replies, use mcp__relaycast__reply_to_thread or relaycast.reply_to_thread.".to_string(),
        "- To check unread messages/reactions, use mcp__relaycast__check_inbox or relaycast.check_inbox.".to_string(),
        "- To self-terminate when your task is complete, call remove_agent(name: \"<your-agent-name>\") or output /exit on its own line.".to_string(),
        "</system-reminder>".to_string(),
    ]
    .join("\n")
}

fn build_mcp_short_hint(
    sender: &str,
    target: &str,
    relay_line: &str,
    pre_registered: bool,
    assigned_name: Option<&str>,
) -> String {
    let sender_name = sender_display_name(sender);
    let reply_target = sender_reply_target(sender);
    let dm_target = if reply_target.eq_ignore_ascii_case(sender_name) {
        sender_name.to_string()
    } else {
        reply_target.to_string()
    };
    let channel_context = detect_channel_context(relay_line, target);
    let channel_hint = channel_context
        .as_deref()
        .unwrap_or("#general")
        .trim_start_matches('#');

    let register_hint = if pre_registered {
        String::new()
    } else if let Some(name) = assigned_name {
        format!(
            " If unregistered, call mcp__relaycast__register(name: \"{name}\", type: \"agent\") first."
        )
    } else {
        " If unregistered, call mcp__relaycast__register(name: \"<worker-name>\", type: \"agent\") first."
            .to_string()
    };

    format!(
        "<system-reminder>Reply via Relaycast MCP: mcp__relaycast__send_dm/relaycast.send_dm (to: \"{dm_target}\") or mcp__relaycast__post_message/relaycast.post_message (channel: \"{channel_hint}\").{register_hint}</system-reminder>"
    )
}

pub(crate) fn format_injection(from: &str, event_id: &str, body: &str, target: &str) -> String {
    format_injection_with_reminder(from, event_id, body, target, true)
}

pub(crate) fn format_injection_with_reminder(
    from: &str,
    event_id: &str,
    body: &str,
    target: &str,
    include_reminder: bool,
) -> String {
    format_injection_for_worker(from, event_id, body, target, include_reminder, true, None)
}

pub(crate) fn format_injection_for_worker(
    from: &str,
    event_id: &str,
    body: &str,
    target: &str,
    include_reminder: bool,
    pre_registered: bool,
    assigned_name: Option<&str>,
) -> String {
    let sender_name = sender_display_name(from);
    let relay_line = if body.starts_with("Relay message from ") {
        body.trim().to_string()
    } else if target.starts_with('#') {
        format!(
            "Relay message from {} in {} [{}]: {}",
            sender_name, target, event_id, body
        )
    } else {
        format!(
            "Relay message from {} [{}]: {}",
            sender_name, event_id, body
        )
    };

    if !include_reminder {
        let short_hint =
            build_mcp_short_hint(from, target, &relay_line, pre_registered, assigned_name);
        return format!("{short_hint}\n{relay_line}");
    }

    let reminder = build_mcp_reminder(from, target, &relay_line, pre_registered, assigned_name);
    format!("{reminder}\n{relay_line}")
}

/// Find the nearest character boundary at or before the given byte index.
pub(crate) fn floor_char_boundary(s: &str, index: usize) -> usize {
    if index >= s.len() {
        return s.len();
    }
    let mut i = index;
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

/// Strip ANSI escape sequences from text for robust pattern matching.
///
/// Cursor-forward (`ESC[<n>C`) sequences are replaced with spaces so that
/// CLIs which render injected text using cursor movement (e.g. Claude Code
/// v2.1.49+) still produce readable output for echo detection.
pub(crate) fn strip_ansi(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            match chars.peek() {
                Some('[') => {
                    chars.next();
                    // Collect parameter bytes (digits, ';', '?')
                    let mut param_buf = String::new();
                    while let Some(&nc) = chars.peek() {
                        chars.next();
                        if nc.is_ascii_alphabetic() || nc == '@' || nc == '`' {
                            // Cursor-forward: replace with spaces
                            if nc == 'C' {
                                let count = param_buf.parse::<usize>().unwrap_or(1);
                                for _ in 0..count {
                                    result.push(' ');
                                }
                            }
                            break;
                        }
                        param_buf.push(nc);
                    }
                }
                Some(']') => {
                    chars.next();
                    while let Some(nc) = chars.next() {
                        if nc == '\x07' {
                            break;
                        }
                        if nc == '\x1b' && chars.peek() == Some(&'\\') {
                            chars.next();
                            break;
                        }
                    }
                }
                Some('(' | ')' | '*' | '+') => {
                    chars.next();
                    chars.next();
                }
                Some(c) if *c >= '0' && *c <= '~' => {
                    chars.next();
                }
                _ => {}
            }
        } else {
            result.push(c);
        }
    }
    result
}

pub(crate) fn current_timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis())
        .min(u128::from(u64::MAX)) as u64
}

pub(crate) fn delivery_queued_event_payload(
    delivery_id: &str,
    event_id: &str,
    worker_name: &str,
    timestamp_ms: u64,
) -> Value {
    json!({
        "delivery_id": delivery_id,
        "event_id": event_id,
        "worker_name": worker_name,
        "timestamp": timestamp_ms,
    })
}

pub(crate) fn delivery_injected_event_payload(
    delivery_id: &str,
    event_id: &str,
    worker_name: &str,
    timestamp_ms: u64,
) -> Value {
    json!({
        "delivery_id": delivery_id,
        "event_id": event_id,
        "worker_name": worker_name,
        "timestamp": timestamp_ms,
    })
}

/// Detect Claude Code --dangerously-skip-permissions confirmation prompt.
/// Returns (has_bypass_ref, has_confirmation).
pub(crate) fn detect_bypass_permissions_prompt(clean_output: &str) -> (bool, bool) {
    let lower = clean_output.to_lowercase();
    let has_bypass_ref =
        (lower.contains("bypass") && lower.contains("permission")) || lower.contains("dangerously");
    let has_confirmation = lower.contains("(yes/no)")
        || lower.contains("(y/n)")
        || (lower.contains("proceed") && lower.contains("yes"))
        || (lower.contains("accept") && lower.contains("risk"))
        || (lower.contains("accept") && lower.contains("no,") && lower.contains("exit"));
    (has_bypass_ref, has_confirmation)
}

/// Check if the bypass permissions prompt is in selection menu format.
pub(crate) fn is_bypass_selection_menu(clean_output: &str) -> bool {
    let lower = clean_output.to_lowercase();
    let has_accept = lower.contains("accept");
    let has_exit_option = lower.contains("exit");
    let has_enter_confirm = lower.contains("enter") && lower.contains("confirm");
    has_accept && has_exit_option && has_enter_confirm
}

/// Detect if the agent is in an editor mode (vim INSERT, nano, etc.).
/// When in editor mode, auto-Enter should be suppressed.
pub(crate) fn is_in_editor_mode(recent_output: &str) -> bool {
    let clean = strip_ansi(recent_output);
    let last_output = if clean.len() > 500 {
        let start = floor_char_boundary(&clean, clean.len() - 500);
        &clean[start..]
    } else {
        &clean
    };

    // Claude CLI status bar with mode indicator - NOT vim
    let claude_ui_chars = ['⏵', '⏴', '►', '▶'];
    let has_claude_ui = last_output.chars().any(|c| claude_ui_chars.contains(&c));
    if has_claude_ui
        && (last_output.contains("-- INSERT --")
            || last_output.contains("-- NORMAL --")
            || last_output.contains("-- VISUAL --"))
    {
        return false;
    }

    // Vim/Neovim mode indicators
    let vim_patterns = [
        "-- INSERT --",
        "-- REPLACE --",
        "-- VISUAL --",
        "-- VISUAL LINE --",
        "-- VISUAL BLOCK --",
        "-- SELECT --",
        "-- TERMINAL --",
    ];
    for pattern in vim_patterns {
        if let Some(pos) = last_output.rfind(pattern) {
            let after_pattern = &last_output[pos + pattern.len()..];
            let trimmed = after_pattern.trim_start();
            if trimmed.is_empty() || trimmed.starts_with('\n') {
                return true;
            }
        }
    }

    // Nano / Emacs / pager indicators
    if last_output.contains("GNU nano") || last_output.contains("^G Get Help") {
        return true;
    }
    if last_output.contains("(END)") || last_output.contains("--More--") {
        return true;
    }

    false
}

/// Detect Codex model upgrade/selection prompt in output.
pub(crate) fn detect_codex_model_prompt(clean_output: &str) -> (bool, bool) {
    let lower = clean_output.to_lowercase();
    let has_upgrade_ref = (lower.contains("codex") && lower.contains("upgrade"))
        || (lower.contains("codex") && lower.contains("new") && lower.contains("model"))
        || (lower.contains("just") && lower.contains("got") && lower.contains("upgrade"));
    let has_model_options = lower.contains("try") && lower.contains("existing");
    (has_upgrade_ref, has_model_options)
}

/// Detect Gemini "Action Required" permission prompt in output.
pub(crate) fn detect_gemini_action_required(clean_output: &str) -> (bool, bool) {
    let has_header = clean_output.contains("Action Required");
    let has_allow_option =
        clean_output.contains("Allow once") || clean_output.contains("Allow for this session");
    (has_header, has_allow_option)
}

/// Continuity actions that an agent can request via PTY output.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ContinuityAction {
    Save,
    Load,
    Uncertain,
}

impl ContinuityAction {
    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            ContinuityAction::Save => "save",
            ContinuityAction::Load => "load",
            ContinuityAction::Uncertain => "uncertain",
        }
    }
}

/// Parse a `KIND: continuity` command block from accumulated PTY output.
///
/// The format is:
/// ```text
/// KIND: continuity
/// ACTION: save|load|uncertain
///
/// Optional body content here
/// ```
///
/// Returns `Some((action, content, bytes_consumed))` when a complete block is found,
/// where `bytes_consumed` is the number of bytes to trim from the start of `buf`.
///
/// The block must have:
/// - A line containing `KIND:` with value `continuity` (case-insensitive)
/// - A line containing `ACTION:` with a valid action (case-insensitive)
/// - Optionally followed by a blank line and body content
///
/// The function looks for the pattern anywhere in the buffer and returns the
/// offset past the detected block so the caller can advance their buffer.
pub(crate) fn parse_continuity_command(buf: &str) -> Option<(ContinuityAction, String, usize)> {
    // Find a line with KIND: continuity
    let kind_prefix = "kind:";
    let action_prefix = "action:";

    let lines: Vec<&str> = buf.lines().collect();

    for (i, line) in lines.iter().enumerate() {
        let trimmed = line.trim().to_lowercase();
        if !trimmed.starts_with(kind_prefix) {
            continue;
        }
        let kind_value = trimmed[kind_prefix.len()..].trim();
        if kind_value != "continuity" {
            continue;
        }

        // Found KIND: continuity — look for ACTION: on the next non-empty line
        let mut action: Option<ContinuityAction> = None;
        let mut body_start_line: Option<usize> = None;

        for (j, line_at_j) in lines.iter().enumerate().skip(i + 1) {
            let next = line_at_j.trim();
            if next.is_empty() {
                // Blank line may precede body; record where body starts
                if action.is_some() && body_start_line.is_none() {
                    body_start_line = Some(j + 1);
                }
                continue;
            }
            let lower = next.to_lowercase();
            if let Some(action_value) = lower.strip_prefix(action_prefix).map(str::trim) {
                action = match action_value {
                    "save" => Some(ContinuityAction::Save),
                    "load" => Some(ContinuityAction::Load),
                    "uncertain" => Some(ContinuityAction::Uncertain),
                    _ => None,
                };
                continue;
            }
            // Non-empty, non-header line — this is body content
            if action.is_some() {
                if body_start_line.is_none() {
                    body_start_line = Some(j);
                }
                break;
            }
        }

        let action = action?;

        // Collect body lines
        let content = if let Some(start) = body_start_line {
            lines[start..]
                .iter()
                .take_while(|l| !l.trim().to_lowercase().starts_with(kind_prefix))
                .cloned()
                .collect::<Vec<_>>()
                .join("\n")
                .trim()
                .to_string()
        } else {
            String::new()
        };

        // Compute bytes consumed: everything up to and including the last body line
        // (or the ACTION: line if there's no body). We advance past the block
        // by consuming byte offset of the line after the last consumed line.
        let end_line = body_start_line
            .map(|s| {
                s + lines[s..]
                    .iter()
                    .take_while(|l| !l.trim().to_lowercase().starts_with(kind_prefix))
                    .count()
            })
            .unwrap_or(i + 2); // at minimum, consume KIND + ACTION lines

        // Re-derive byte offset of end_line in original buf
        let bytes_consumed = lines[..end_line.min(lines.len())]
            .iter()
            .map(|l| l.len() + 1) // +1 for '\n'
            .sum::<usize>()
            .min(buf.len());

        return Some((action, content, bytes_consumed));
    }

    None
}

/// Detect Claude Code auto-suggestion ghost text.
pub(crate) fn is_auto_suggestion(output: &str) -> bool {
    let has_cursor_ghost = output.contains("\x1b[7m") && output.contains("\x1b[27m\x1b[2m");
    let has_send_hint = output.contains("↵ send");
    has_cursor_ghost || has_send_hint
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn check_echo_clean_text() {
        let output = "some preamble\nRelay message from Alice [evt_1]: hello world\nmore output";
        assert!(check_echo_in_output(
            output,
            "Relay message from Alice [evt_1]: hello world"
        ));
    }

    #[test]
    fn check_echo_with_ansi() {
        let output =
            "\x1b[32mRelay message from Alice [evt_1]: hello world\x1b[0m\nsome other text";
        assert!(check_echo_in_output(
            output,
            "Relay message from Alice [evt_1]: hello world"
        ));
    }

    #[test]
    fn check_echo_no_match() {
        let output = "some unrelated output\nprompt> ";
        assert!(!check_echo_in_output(
            output,
            "Relay message from Alice [evt_1]: hello world"
        ));
    }

    #[test]
    fn check_echo_partial_match() {
        let output = "Relay message from Alice [evt_1]: hell";
        assert!(!check_echo_in_output(
            output,
            "Relay message from Alice [evt_1]: hello world"
        ));
    }

    #[test]
    fn check_echo_channel_format() {
        let output = "Relay message from Bob in #general [evt_2]: status update";
        assert!(check_echo_in_output(
            output,
            "Relay message from Bob in #general [evt_2]: status update"
        ));
    }

    #[test]
    fn test_throttle_healthy() {
        let mut throttle = ThrottleState::default();
        for _ in 0..10 {
            throttle.record(DeliveryOutcome::Success);
        }
        assert_eq!(throttle.delay(), Duration::from_millis(100));
    }

    #[test]
    fn test_throttle_backoff() {
        let mut throttle = ThrottleState::default();
        throttle.record(DeliveryOutcome::Failed);
        assert_eq!(throttle.delay(), Duration::from_millis(100));
        throttle.record(DeliveryOutcome::Failed);
        assert_eq!(throttle.delay(), Duration::from_millis(200));
        throttle.record(DeliveryOutcome::Failed);
        assert_eq!(throttle.delay(), Duration::from_millis(500));
        throttle.record(DeliveryOutcome::Failed);
        assert_eq!(throttle.delay(), Duration::from_secs(1));
        throttle.record(DeliveryOutcome::Failed);
        assert_eq!(throttle.delay(), Duration::from_secs(2));
        throttle.record(DeliveryOutcome::Failed);
        assert_eq!(throttle.delay(), Duration::from_secs(5));
    }

    #[test]
    fn test_throttle_recovery() {
        let mut throttle = ThrottleState::default();
        for _ in 0..5 {
            throttle.record(DeliveryOutcome::Failed);
        }
        let failed_delay = throttle.delay();
        for _ in 0..3 {
            throttle.record(DeliveryOutcome::Success);
        }
        let expected = Duration::from_millis(failed_delay.as_millis() as u64 / 2);
        assert_eq!(throttle.delay(), expected);
    }

    #[test]
    fn detect_activity_for_claude_patterns() {
        let detector = ActivityDetector::for_cli("claude");
        let output = "⠋ processing request\nRelay message from Alice [evt_1]: hello";
        assert_eq!(
            detector.detect_activity(output, "Relay message from Alice [evt_1]: hello"),
            Some("⠋".to_string())
        );
        assert_eq!(
            detector.detect_activity(
                "Tool: Write(file)",
                "Relay message from Alice [evt_1]: hello"
            ),
            Some("Tool:".to_string())
        );
    }

    #[test]
    fn detect_activity_removes_expected_echo_from_output() {
        let detector = ActivityDetector::for_cli("claude");
        let expected_echo = "Relay message from Alice [evt_1]: hello";
        let output = format!("{}\nTool: Write(file)", expected_echo);
        assert_eq!(
            detector.detect_activity(&output, expected_echo),
            Some("Tool:".to_string())
        );
    }

    #[test]
    fn detect_activity_for_codex_patterns() {
        let detector = ActivityDetector::for_cli("codex");
        assert_eq!(
            detector.detect_activity(
                "Thinking... running tool",
                "Relay message from Alice [evt_1]: hello"
            ),
            Some("Thinking...".to_string())
        );
    }

    #[test]
    fn detect_activity_for_gemini_patterns() {
        let detector = ActivityDetector::for_cli("gemini");
        assert_eq!(
            detector.detect_activity(
                "Action: execute task",
                "Relay message from Alice [evt_1]: hello"
            ),
            Some("Action:".to_string())
        );
    }

    #[test]
    fn detect_activity_uses_default_when_any_output_present_for_unknown_cli() {
        let detector = ActivityDetector::for_cli("mystery-cli");
        assert_eq!(
            detector.detect_activity(
                "Output after echo",
                "Relay message from Alice [evt_1]: hello"
            ),
            Some("any_output".to_string())
        );
    }

    #[test]
    fn detect_activity_defaults_to_any_output() {
        let detector = ActivityDetector::for_cli("mystery-cli");
        assert_eq!(
            detector.detect_activity(
                "Agent output line",
                "Relay message from Alice [evt_1]: hello"
            ),
            Some("any_output".to_string())
        );
        assert_eq!(
            detector.detect_activity(
                "Relay message from Alice [evt_1]: hello",
                "Relay message from Alice [evt_1]: hello"
            ),
            None
        );
    }

    #[test]
    fn detect_activity_strips_ansi_before_matching_patterns() {
        let detector = ActivityDetector::for_cli("claude");
        let expected_echo = "Relay message from Alice [evt_1]: hello";
        let output = format!("{}\n\x1b[32m⠙\x1b[0m writing output\n", expected_echo);
        assert_eq!(
            detector.detect_activity(&output, expected_echo),
            Some("⠙".to_string())
        );
    }

    #[test]
    fn detect_activity_does_not_match_pattern_in_echo() {
        let detector = ActivityDetector::for_cli("claude");
        let expected_echo = "Relay message from Alice [evt_1]: Tool: Write(file)";
        let output = expected_echo.to_string();
        assert_eq!(detector.detect_activity(&output, expected_echo), None);
    }

    #[test]
    fn detect_cli_ready_prompt_patterns() {
        assert!(detect_cli_ready("claude", "Welcome to Claude\n> ", 100));
        assert!(detect_cli_ready("codex", "Ready\ncodex> ", 100));
        assert!(detect_cli_ready("claude", "some output $ ", 100));
    }

    #[test]
    fn detect_cli_ready_byte_fallback() {
        assert!(!detect_cli_ready("claude", "loading...", 200));
        assert!(detect_cli_ready("claude", "loading...", 600));
    }

    #[test]
    fn detect_cli_ready_explicit_signal() {
        assert!(detect_cli_ready("claude", "->pty:ready", 0));
    }

    #[test]
    fn terminal_query_da1_no_param() {
        let mut parser = TerminalQueryParser::default();
        let responses = parser.feed(b"\x1b[c");
        assert_eq!(responses.len(), 1);
        assert_eq!(responses[0], b"\x1b[?1;2c");
    }

    #[test]
    fn terminal_query_da1_with_zero() {
        let mut parser = TerminalQueryParser::default();
        let responses = parser.feed(b"\x1b[0c");
        assert_eq!(responses.len(), 1);
        assert_eq!(responses[0], b"\x1b[?1;2c");
    }

    #[test]
    fn terminal_query_da2() {
        let mut parser = TerminalQueryParser::default();
        let responses = parser.feed(b"\x1b[>c");
        assert_eq!(responses.len(), 1);
        assert_eq!(responses[0], b"\x1b[>1;10;0c");
    }

    #[test]
    fn terminal_query_dsr() {
        let mut parser = TerminalQueryParser::default();
        let responses = parser.feed(b"\x1b[5n");
        assert_eq!(responses.len(), 1);
        assert_eq!(responses[0], b"\x1b[0n");
    }

    #[test]
    fn terminal_query_cpr_still_works() {
        let mut parser = TerminalQueryParser::default();
        let responses = parser.feed(b"\x1b[6n");
        assert_eq!(responses.len(), 1);
        assert_eq!(responses[0], b"\x1b[1;1R");
    }

    // ==================== detect_codex_model_prompt tests ====================

    #[test]
    fn codex_model_prompt_upgrade_with_options() {
        let output = "Codex just got an upgrade! A new model is available.\nTry the new model\nKeep existing";
        let (has_upgrade, has_options) = detect_codex_model_prompt(output);
        assert!(has_upgrade, "should detect upgrade reference");
        assert!(has_options, "should detect try/existing options");
    }

    #[test]
    fn codex_model_prompt_new_model_available() {
        let output = "Codex has a new model ready.\nWould you like to try it or keep existing?";
        let (has_upgrade, has_options) = detect_codex_model_prompt(output);
        assert!(has_upgrade, "should detect 'codex' + 'new' + 'model'");
        assert!(has_options, "should detect try/existing options");
    }

    #[test]
    fn codex_model_prompt_no_match_normal_output() {
        let output = "Running codex analysis...\nFile processed successfully.";
        let (has_upgrade, has_options) = detect_codex_model_prompt(output);
        assert!(!has_upgrade, "normal output should not match upgrade");
        assert!(!has_options, "normal output should not match options");
    }

    #[test]
    fn codex_model_prompt_upgrade_without_options() {
        let output = "Codex just got an upgrade! Loading...";
        let (has_upgrade, has_options) = detect_codex_model_prompt(output);
        assert!(has_upgrade, "should detect upgrade reference");
        assert!(!has_options, "no try/existing options present");
    }

    #[test]
    fn codex_model_prompt_case_insensitive() {
        let output = "CODEX JUST GOT AN UPGRADE!\nTRY the new model or keep EXISTING";
        let (has_upgrade, has_options) = detect_codex_model_prompt(output);
        assert!(has_upgrade);
        assert!(has_options);
    }

    // ==================== detect_gemini_action_required tests ====================

    #[test]
    fn gemini_action_required_allow_once() {
        let output = "⚠ Action Required\nThe tool wants to execute a command.\nAllow once\nDeny";
        let (has_header, has_allow) = detect_gemini_action_required(output);
        assert!(has_header, "should detect Action Required header");
        assert!(has_allow, "should detect Allow once option");
    }

    #[test]
    fn gemini_action_required_allow_session() {
        let output = "Action Required\nAllow for this session\nDeny";
        let (has_header, has_allow) = detect_gemini_action_required(output);
        assert!(has_header);
        assert!(has_allow);
    }

    #[test]
    fn gemini_action_required_no_match() {
        let output = "Generating response...\nAction: execute ls command";
        let (has_header, has_allow) = detect_gemini_action_required(output);
        assert!(!has_header, "normal output should not match");
        assert!(!has_allow);
    }

    #[test]
    fn gemini_action_required_header_only_no_options() {
        let output = "Action Required\nPlease wait...";
        let (has_header, has_allow) = detect_gemini_action_required(output);
        assert!(has_header, "should detect header");
        assert!(!has_allow, "no allow options present");
    }

    #[test]
    fn gemini_action_required_case_sensitive_header() {
        // "Action Required" is case-sensitive (exact match)
        let output = "action required\nAllow once";
        let (has_header, has_allow) = detect_gemini_action_required(output);
        assert!(!has_header, "lowercase should not match");
        assert!(has_allow, "Allow once should still match");
    }

    // ==================== detect_cli_ready edge cases ====================

    #[test]
    fn detect_cli_ready_ansi_in_prompt() {
        // Prompt with ANSI codes should still be detected after stripping
        assert!(detect_cli_ready("claude", "\x1b[32m> \x1b[0m", 100));
    }

    #[test]
    fn detect_cli_ready_empty_output() {
        assert!(!detect_cli_ready("claude", "", 0));
    }

    #[test]
    fn detect_cli_ready_exact_500_bytes() {
        // At exactly 500 bytes, should NOT trigger byte fallback (> 500 required)
        assert!(!detect_cli_ready("claude", "loading...", 500));
        // At 501 bytes, should trigger
        assert!(detect_cli_ready("claude", "loading...", 501));
    }

    #[test]
    fn detect_cli_ready_prompt_in_early_output_ignored() {
        // If output is >500 chars, only last 500 chars are checked
        let mut long_output = "x".repeat(600);
        long_output.push_str("no prompt here");
        // The "> " is at the start, outside the last 500 chars check region
        let output_with_early_prompt = format!("> {}", "x".repeat(600));
        assert!(!detect_cli_ready("claude", &output_with_early_prompt, 100));
    }

    #[test]
    fn detect_cli_ready_aider_prompt() {
        assert!(detect_cli_ready("aider", "aider v0.50.0\n> ", 100));
    }

    #[test]
    fn detect_cli_ready_unknown_cli_fallback() {
        // Unknown CLIs use the same default patterns
        assert!(detect_cli_ready("mystery-cli", "$ ", 50));
        assert!(detect_cli_ready("mystery-cli", "loading...", 600));
    }

    #[test]
    fn detect_cli_ready_ready_signal_zero_bytes() {
        // Explicit ready signal works even with zero bytes
        assert!(detect_cli_ready("claude", "->pty:ready", 0));
        assert!(detect_cli_ready("codex", "->pty:ready", 0));
    }

    // ==================== terminal query parser edge cases ====================

    #[test]
    fn terminal_query_multiple_queries_in_one_chunk() {
        let mut parser = TerminalQueryParser::default();
        // DA1 + CPR + DSR all in one chunk
        let responses = parser.feed(b"\x1b[c\x1b[6n\x1b[5n");
        assert_eq!(responses.len(), 3);
        assert_eq!(responses[0], b"\x1b[?1;2c"); // DA1
        assert_eq!(responses[1], b"\x1b[1;1R"); // CPR
        assert_eq!(responses[2], b"\x1b[0n"); // DSR
    }

    #[test]
    fn terminal_query_interleaved_with_text() {
        let mut parser = TerminalQueryParser::default();
        // Normal text + DA1 query + more text
        let responses = parser.feed(b"Hello\x1b[cWorld");
        assert_eq!(responses.len(), 1);
        assert_eq!(responses[0], b"\x1b[?1;2c");
    }

    #[test]
    fn terminal_query_split_across_chunks() {
        let mut parser = TerminalQueryParser::default();
        // ESC in first chunk, [6n in second
        let r1 = parser.feed(b"\x1b");
        assert_eq!(r1.len(), 0);
        let r2 = parser.feed(b"[6n");
        assert_eq!(r2.len(), 1);
        assert_eq!(r2[0], b"\x1b[1;1R");
    }

    #[test]
    fn terminal_query_incomplete_sequence_reset() {
        let mut parser = TerminalQueryParser::default();
        // ESC [ but then a regular char (not a query) — should reset
        let responses = parser.feed(b"\x1b[A");
        assert_eq!(responses.len(), 0, "cursor up should not generate response");
    }

    #[test]
    fn terminal_query_qmark_cpr() {
        let mut parser = TerminalQueryParser::default();
        let responses = parser.feed(b"\x1b[?6n");
        assert_eq!(responses.len(), 1);
        assert_eq!(responses[0], b"\x1b[?1;1R");
    }

    // ==================== throttle edge cases ====================

    #[test]
    fn throttle_delay_floor_never_below_100ms() {
        let mut throttle = ThrottleState::default();
        // Many successes should not push delay below 100ms
        for _ in 0..100 {
            throttle.record(DeliveryOutcome::Success);
        }
        assert_eq!(throttle.delay(), Duration::from_millis(100));
    }

    #[test]
    fn throttle_cap_at_5s() {
        let mut throttle = ThrottleState::default();
        // Many failures should cap at 5s
        for _ in 0..20 {
            throttle.record(DeliveryOutcome::Failed);
        }
        assert_eq!(throttle.delay(), Duration::from_secs(5));
    }

    #[test]
    fn throttle_recovery_after_mixed_outcomes() {
        let mut throttle = ThrottleState::default();
        // Fail 3 times → 500ms
        for _ in 0..3 {
            throttle.record(DeliveryOutcome::Failed);
        }
        assert_eq!(throttle.delay(), Duration::from_millis(500));
        // One success resets failure count but doesn't halve yet
        throttle.record(DeliveryOutcome::Success);
        assert_eq!(throttle.delay(), Duration::from_millis(500));
        // Two more successes → 3 consecutive → halve to 250ms
        throttle.record(DeliveryOutcome::Success);
        throttle.record(DeliveryOutcome::Success);
        assert_eq!(throttle.delay(), Duration::from_millis(250));
    }

    #[test]
    fn throttle_failure_resets_success_counter() {
        let mut throttle = ThrottleState::default();
        // 2 successes, then a failure, then 2 more successes
        // should NOT trigger the 3-consecutive-success halving
        throttle.record(DeliveryOutcome::Success);
        throttle.record(DeliveryOutcome::Success);
        throttle.record(DeliveryOutcome::Failed);
        throttle.record(DeliveryOutcome::Success);
        throttle.record(DeliveryOutcome::Success);
        assert_eq!(throttle.delay(), Duration::from_millis(100));
    }

    // ==================== strip_ansi tests ====================

    #[test]
    fn strip_ansi_removes_csi_sequences() {
        assert_eq!(strip_ansi("\x1b[32mgreen\x1b[0m"), "green");
        assert_eq!(strip_ansi("\x1b[1;31mred bold\x1b[0m"), "red bold");
    }

    #[test]
    fn strip_ansi_removes_osc_sequences() {
        // OSC with BEL terminator
        assert_eq!(strip_ansi("\x1b]0;title\x07text"), "text");
        // OSC with ST terminator
        assert_eq!(strip_ansi("\x1b]0;title\x1b\\text"), "text");
    }

    #[test]
    fn strip_ansi_preserves_plain_text() {
        let plain = "Hello, world! 123\nNew line";
        assert_eq!(strip_ansi(plain), plain);
    }

    #[test]
    fn strip_ansi_handles_charset_sequences() {
        // ESC ( B — designate ASCII charset
        assert_eq!(strip_ansi("\x1b(Btext"), "text");
    }

    // ==================== format_injection tests ====================

    #[test]
    fn format_injection_dm() {
        let result = format_injection("Alice", "evt_1", "hello world", "Bob");
        assert!(result.contains("<system-reminder>"));
        assert!(result.contains("Relaycast MCP tools"));
        assert!(result.contains("pre-registered by the broker"));
        assert!(result.contains("mcp__relaycast__send_dm"));
        assert!(result.contains("Relay message from Alice [evt_1]: hello world"));
    }

    #[test]
    fn format_injection_channel() {
        let result = format_injection("Alice", "evt_1", "hello world", "#general");
        assert!(result.contains("<system-reminder>"));
        assert!(result.contains("mcp__relaycast__post_message"));
        assert!(result.contains("channel: \"general\""));
        assert!(result.contains("Relay message from Alice in #general [evt_1]: hello world"));
    }

    #[test]
    fn format_injection_worker_without_preregistration_includes_register_guidance() {
        let result = format_injection_for_worker(
            "Alice",
            "evt_1",
            "hello world",
            "Bob",
            true,
            false,
            Some("Lead"),
        );
        assert!(result.contains("<system-reminder>"));
        assert!(result.contains("not pre-registered by the broker"));
        assert!(result.contains("mcp__relaycast__register"));
        assert!(result.contains("name: \"Lead\""));
    }

    #[test]
    fn format_injection_pre_formatted() {
        let body = "Relay message from Bob [evt_0]: previous message";
        let result = format_injection("Alice", "evt_1", body, "Charlie");
        assert!(result.contains("<system-reminder>"));
        assert!(result.contains(body));
    }

    #[test]
    fn format_injection_strips_human_prefix_from_sender() {
        let result = format_injection("human:alice", "evt_1", "status?", "Bob");
        assert!(result.contains("Relay message from alice [evt_1]: status?"));
        assert!(result.contains("to \"alice\""));
    }

    #[test]
    fn format_injection_maps_broker_sender_to_dashboard_with_reply_target() {
        let result = format_injection("broker-951762d5", "evt_1", "status?", "Lead");
        assert!(result.contains("Relay message from Dashboard [evt_1]: status?"));
        assert!(result.contains("to: \"broker-951762d5\""));
    }

    #[test]
    fn format_injection_detects_channel_from_preformatted_body() {
        let body = "Relay message from bob [abc123] [#dev-team]: Channel update";
        let result = format_injection("system", "evt_1", body, "Worker");
        assert!(result.contains("mcp__relaycast__post_message"));
        assert!(result.contains("channel: \"dev-team\""));
        assert!(result.contains(body));
    }

    #[test]
    fn format_injection_without_reminder_includes_short_mcp_hint() {
        let result = format_injection_with_reminder("alice", "evt_9", "retry body", "bob", false);
        assert!(result.contains("<system-reminder>Reply via Relaycast MCP"));
        assert!(result.contains("mcp__relaycast__send_dm"));
        assert!(result.contains("mcp__relaycast__post_message"));
        assert!(result.contains("Relay message from alice [evt_9]: retry body"));
    }

    // ==================== is_auto_suggestion edge cases ====================

    #[test]
    fn auto_suggestion_no_false_positive_on_partial_ansi() {
        // Has reverse video but not the dim pattern
        assert!(!is_auto_suggestion("\x1b[7msome text\x1b[27m normal text"));
    }

    // ==================== CLI command parsing ====================

    #[test]
    fn parse_cli_command_supports_inline_args() {
        let (cli, args) = parse_cli_command("claude --model haiku").unwrap();
        assert_eq!(cli, "claude");
        assert_eq!(args, vec!["--model".to_string(), "haiku".to_string()]);
    }

    #[test]
    fn parse_cli_command_supports_quotes() {
        let (cli, args) = parse_cli_command("codex --profile \"my profile\"").unwrap();
        assert_eq!(cli, "codex");
        assert_eq!(
            args,
            vec!["--profile".to_string(), "my profile".to_string()]
        );
    }

    #[test]
    fn parse_cli_command_rejects_empty() {
        let err = parse_cli_command("   ").unwrap_err().to_string();
        assert!(err.contains("cannot be empty"));
    }

    #[test]
    fn parse_cli_command_maps_cursor_to_force() {
        let (cli, args) = parse_cli_command("cursor").unwrap();
        assert_eq!(cli, "cursor");
        assert_eq!(args, vec!["--force".to_string()]);
    }

    #[test]
    fn parse_cli_command_maps_cursor_agent_to_cursor_with_force() {
        let (cli, args) = parse_cli_command("cursor agent --model opus").unwrap();
        assert_eq!(cli, "cursor");
        assert_eq!(
            args,
            vec![
                "--force".to_string(),
                "agent".to_string(),
                "--model".to_string(),
                "opus".to_string()
            ]
        );
    }

    #[test]
    fn parse_cli_command_dedups_force_for_cursor() {
        let (cli, args) = parse_cli_command("cursor --force --model opus").unwrap();
        assert_eq!(cli, "cursor");
        assert_eq!(
            args,
            vec![
                "--force".to_string(),
                "--model".to_string(),
                "opus".to_string()
            ]
        );
    }

    #[test]
    fn normalize_cli_name_uses_executable_for_paths() {
        assert_eq!(normalize_cli_name("/usr/local/bin/claude"), "claude");
        assert_eq!(normalize_cli_name("codex"), "codex");
    }
}
