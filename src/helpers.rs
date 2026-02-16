use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

pub(crate) const ACTIVITY_WINDOW: Duration = Duration::from_secs(5);
pub(crate) const ACTIVITY_BUFFER_MAX_BYTES: usize = 16_000;
pub(crate) const ACTIVITY_BUFFER_KEEP_BYTES: usize = 12_000;
pub(crate) const CLI_READY_TIMEOUT: Duration = Duration::from_secs(15);

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

/// Check if the expected echo string appears in PTY output (after stripping ANSI).
#[cfg(test)]
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
    let prompt_patterns: &[&str] = if lower_cli.contains("claude") {
        &["> ", "$ ", ">>> "]
    } else if lower_cli.contains("codex") {
        &["> ", "$ ", "codex> ", ">>> "]
    } else if lower_cli.contains("gemini") {
        &["> ", "$ ", ">>> "]
    } else if lower_cli.contains("aider") {
        &["> ", "$ ", ">>> "]
    } else {
        &["> ", "$ ", ">>> "]
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

pub(crate) fn format_injection(from: &str, event_id: &str, body: &str, target: &str) -> String {
    // If body is already formatted (from orchestrator), don't double-wrap
    if body.starts_with("Relay message from ") {
        return body.to_string();
    }
    if target.starts_with('#') {
        format!(
            "Relay message from {} in {} [{}]: {}",
            from, target, event_id, body
        )
    } else {
        format!("Relay message from {} [{}]: {}", from, event_id, body)
    }
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
pub(crate) fn strip_ansi(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            match chars.peek() {
                Some('[') => {
                    chars.next();
                    while let Some(&nc) = chars.peek() {
                        chars.next();
                        if nc.is_ascii_alphabetic() || nc == '@' || nc == '`' {
                            break;
                        }
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
        let output = format!("{}", expected_echo);
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
        assert_eq!(responses[1], b"\x1b[1;1R");   // CPR
        assert_eq!(responses[2], b"\x1b[0n");     // DSR
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
        assert_eq!(result, "Relay message from Alice [evt_1]: hello world");
    }

    #[test]
    fn format_injection_channel() {
        let result = format_injection("Alice", "evt_1", "hello world", "#general");
        assert_eq!(result, "Relay message from Alice in #general [evt_1]: hello world");
    }

    #[test]
    fn format_injection_pre_formatted() {
        let body = "Relay message from Bob [evt_0]: previous message";
        let result = format_injection("Alice", "evt_1", body, "Charlie");
        assert_eq!(result, body, "pre-formatted messages should pass through unchanged");
    }

    // ==================== is_auto_suggestion edge cases ====================

    #[test]
    fn auto_suggestion_no_false_positive_on_partial_ansi() {
        // Has reverse video but not the dim pattern
        assert!(!is_auto_suggestion("\x1b[7msome text\x1b[27m normal text"));
    }
}
