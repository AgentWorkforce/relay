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
        format!("Relay message from {} in {} [{}]: {}", from, target, event_id, body)
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
