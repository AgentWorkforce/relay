use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

pub(crate) const VERIFICATION_WINDOW: Duration = Duration::from_secs(3);
pub(crate) const ACTIVITY_WINDOW: Duration = Duration::from_secs(5);
pub(crate) const ACTIVITY_BUFFER_MAX_BYTES: usize = 16_000;
pub(crate) const ACTIVITY_BUFFER_KEEP_BYTES: usize = 12_000;
pub(crate) const MAX_VERIFICATION_ATTEMPTS: u32 = 3;

#[derive(Debug, Clone, Copy)]
pub(crate) enum DeliveryOutcome {
    Success,
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
pub(crate) struct PendingVerification {
    pub delivery_id: String,
    pub event_id: String,
    pub expected_echo: String,
    pub injected_at: Instant,
    pub attempts: u32,
    pub max_attempts: u32,
    pub request_id: Option<String>,
    // Original delivery data for retry
    pub from: String,
    pub body: String,
    pub target: String,
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
pub(crate) fn check_echo_in_output(output: &str, expected: &str) -> bool {
    let clean = strip_ansi(output);
    clean.contains(expected)
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
                (TerminalQueryState::Csi, SIX) => TerminalQueryState::Csi6,
                (TerminalQueryState::CsiQmark, SIX) => TerminalQueryState::CsiQmark6,
                (TerminalQueryState::Csi6, N) => {
                    out.push(b"\x1b[1;1R".as_slice());
                    TerminalQueryState::Idle
                }
                (TerminalQueryState::CsiQmark6, N) => {
                    out.push(b"\x1b[?1;1R".as_slice());
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

}
