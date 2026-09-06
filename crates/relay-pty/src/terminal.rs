use crate::ansi::{floor_char_boundary, strip_ansi};

/// Detect Claude Code --dangerously-skip-permissions confirmation prompt.
/// Returns (has_bypass_ref, has_confirmation).
pub fn detect_bypass_permissions_prompt(clean_output: &str) -> (bool, bool) {
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
pub fn is_bypass_selection_menu(clean_output: &str) -> bool {
    let lower = clean_output.to_lowercase();
    let has_accept = lower.contains("accept");
    let has_exit_option = lower.contains("exit");
    let has_enter_confirm = lower.contains("enter") && lower.contains("confirm");
    has_accept && has_exit_option && has_enter_confirm
}

/// Detect if the agent is in an editor mode (vim INSERT, nano, etc.).
/// When in editor mode, auto-Enter should be suppressed.
pub fn is_in_editor_mode(recent_output: &str) -> bool {
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
            let trimmed = after_pattern.trim_start_matches([' ', '\t']);
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
pub fn detect_codex_model_prompt(clean_output: &str) -> (bool, bool) {
    let lower = clean_output.to_lowercase();
    let has_upgrade_ref = (lower.contains("codex") && lower.contains("upgrade"))
        || (lower.contains("codex") && lower.contains("new") && lower.contains("model"))
        || (lower.contains("just") && lower.contains("got") && lower.contains("upgrade"));
    let has_model_options = lower.contains("try") && lower.contains("existing");
    (has_upgrade_ref, has_model_options)
}

/// Detect Codex's startup directory-trust prompt.
///
/// Codex shows this interstitial before its normal input prompt when the
/// selected working directory has not been trusted yet. A spawned worker
/// cannot receive its queued initial task until this menu is dismissed.
pub fn detect_codex_trust_prompt(clean_output: &str) -> bool {
    let lower = clean_output.to_lowercase();
    lower.contains("do you trust the contents of this directory?")
        && lower.contains("yes, continue")
        && lower.contains("no, quit")
}

/// Detect opencode/droid EXECUTE permission prompt in output.
/// Returns (has_header, has_allow_option).
/// The prompt looks like:
/// ```text
/// EXECUTE (command, timeout: 120s, impact: medium)
/// > Yes, allow
///   Yes, and always allow medium impact commands (all commands that are reversible)
///   No, cancel
/// ```
pub fn detect_opencode_permission_prompt(clean_output: &str) -> (bool, bool) {
    let has_header = clean_output.contains("EXECUTE") && clean_output.contains("impact:");
    let has_allow_option =
        clean_output.contains("Yes, allow") || clean_output.contains("Yes, and always allow");
    (has_header, has_allow_option)
}

/// Detect Gemini "Action Required" permission prompt in output.
pub fn detect_gemini_action_required(clean_output: &str) -> (bool, bool) {
    let has_header = clean_output.contains("Action Required");
    let has_allow_option =
        clean_output.contains("Allow once") || clean_output.contains("Allow for this session");
    (has_header, has_allow_option)
}

/// Detect Gemini "untrusted folder" informational banner in output.
/// Returns true when the banner is present (not an interactive menu — requires `/permissions`).
pub fn detect_gemini_untrusted_banner(clean_output: &str) -> bool {
    clean_output.contains("folder is untrusted") && clean_output.contains("/permissions")
}

/// Detect Gemini "Modify Trust Level" folder trust prompt in output.
/// Returns (has_header, has_trust_option).
pub fn detect_gemini_trust_prompt(clean_output: &str) -> (bool, bool) {
    let has_header = clean_output.contains("Modify Trust Level");
    let has_trust_option =
        clean_output.contains("Trust this folder") || clean_output.contains("Trust parent folder");
    (has_header, has_trust_option)
}

/// Detect Claude Code folder trust prompt in output.
/// Returns (has_trust_ref, has_confirmation).
pub fn detect_claude_trust_prompt(clean_output: &str) -> (bool, bool) {
    let lower = clean_output.to_lowercase();
    let has_trust_ref = lower.contains("trust") && lower.contains("folder");
    let has_confirmation = (lower.contains("yes") && lower.contains("trust"))
        && lower.contains("no,")
        && lower.contains("exit");
    (has_trust_ref, has_confirmation)
}

/// The keystrokes needed to select Claude Code's affirmative folder-trust row.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ClaudeTrustPromptAction {
    Confirm,
    MoveUpAndConfirm,
    MoveDownAndConfirm,
}

/// Determine how to accept a fully rendered Claude Code folder-trust menu.
///
/// Claude has shipped the same two choices in both orders, with either choice
/// initially selected. Require exactly one affirmative row, one exit row, and
/// one selected-row marker so partial output and unrelated text fail closed.
pub fn claude_trust_prompt_action(clean_output: &str) -> Option<ClaudeTrustPromptAction> {
    let mut yes_row = None;
    let mut no_row = None;
    let mut selected_row = None;

    for (row, line) in clean_output.lines().enumerate() {
        let lower = line.to_lowercase();
        let normalized = lower.split_whitespace().collect::<Vec<_>>().join(" ");
        let is_yes = normalized.contains("yes, i trust this folder");
        let is_no = normalized.contains("no, exit");

        if is_yes && yes_row.replace(row).is_some() {
            return None;
        }
        if is_no && no_row.replace(row).is_some() {
            return None;
        }
        if (is_yes || is_no) && line.contains('❯') && selected_row.replace(row).is_some() {
            return None;
        }
    }

    let (yes_row, no_row, selected_row) = (yes_row?, no_row?, selected_row?);
    if selected_row == yes_row {
        Some(ClaudeTrustPromptAction::Confirm)
    } else if selected_row == no_row && yes_row < no_row {
        Some(ClaudeTrustPromptAction::MoveUpAndConfirm)
    } else if selected_row == no_row && yes_row > no_row {
        Some(ClaudeTrustPromptAction::MoveDownAndConfirm)
    } else {
        None
    }
}

/// Detect Claude Code auto-suggestion ghost text.
pub fn is_auto_suggestion(output: &str) -> bool {
    let has_cursor_ghost = output.contains("\x1b[7m") && output.contains("\x1b[27m\x1b[2m");
    let has_send_hint = output.contains("↵ send");
    has_cursor_ghost || has_send_hint
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn codex_directory_trust_prompt() {
        let output =
            "Do you trust the contents of this directory? Working with untrusted contents\n\
                      comes with higher risk of prompt injection.\n\
                      > 1. Yes, continue\n\
                        2. No, quit";
        assert!(detect_codex_trust_prompt(output));
    }

    #[test]
    fn codex_directory_trust_requires_the_complete_menu() {
        assert!(!detect_codex_trust_prompt(
            "Do you trust the contents of this directory?"
        ));
        assert!(!detect_codex_trust_prompt(
            "The agent said yes, continue, then no, quit."
        ));
    }

    #[test]
    fn claude_trust_action_supports_both_menu_orderings() {
        let old_layout = "❯ 1. Yes, I trust this folder\n  2. No, exit";
        let new_layout = "❯ No, exit\n  Yes, I trust this folder";

        assert_eq!(
            claude_trust_prompt_action(old_layout),
            Some(ClaudeTrustPromptAction::Confirm)
        );
        assert_eq!(
            claude_trust_prompt_action(new_layout),
            Some(ClaudeTrustPromptAction::MoveDownAndConfirm)
        );
    }

    #[test]
    fn claude_trust_action_fails_closed_without_unambiguous_selection() {
        assert_eq!(
            claude_trust_prompt_action("Yes, I trust this folder\nNo, exit"),
            None
        );
        assert_eq!(
            claude_trust_prompt_action("❯ Yes, I trust this folder\n❯ No, exit\nEnter to confirm"),
            None
        );
    }

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
        let output = "action required\nAllow once";
        let (has_header, has_allow) = detect_gemini_action_required(output);
        assert!(!has_header, "lowercase should not match");
        assert!(has_allow, "Allow once should still match");
    }

    #[test]
    fn gemini_trust_prompt_trust_this_folder() {
        let output = "Modify Trust Level\nFolder: /Users/test/project\nCurrent Level: DO_NOT_TRUST\n1. Trust this folder (project)\n2. Trust parent folder\n3. Don't trust";
        let (has_header, has_trust) = detect_gemini_trust_prompt(output);
        assert!(has_header);
        assert!(has_trust);
    }

    #[test]
    fn gemini_trust_prompt_trust_parent() {
        let output = "Modify Trust Level\n2. Trust parent folder (Projects)";
        let (has_header, has_trust) = detect_gemini_trust_prompt(output);
        assert!(has_header);
        assert!(has_trust);
    }

    #[test]
    fn gemini_trust_prompt_no_match() {
        let output = "Some other prompt\nNothing to see here";
        let (has_header, has_trust) = detect_gemini_trust_prompt(output);
        assert!(!has_header);
        assert!(!has_trust);
    }

    #[test]
    fn gemini_trust_prompt_header_only() {
        let output = "Modify Trust Level\nNo options yet";
        let (has_header, has_trust) = detect_gemini_trust_prompt(output);
        assert!(has_header);
        assert!(!has_trust);
    }

    #[test]
    fn gemini_untrusted_banner_full_match() {
        let output = "ℹ This folder is untrusted, project settings, hooks, MCPs, and GEMINI.md files will not be applied for this folder.\n  Use the /permissions command to change the trust level.";
        assert!(detect_gemini_untrusted_banner(output));
    }

    #[test]
    fn gemini_untrusted_banner_no_match() {
        let output = "Welcome to Gemini CLI\n> ";
        assert!(!detect_gemini_untrusted_banner(output));
    }

    #[test]
    fn gemini_untrusted_banner_partial_no_permissions() {
        let output = "This folder is untrusted, some settings will not apply.";
        assert!(!detect_gemini_untrusted_banner(output));
    }

    #[test]
    fn opencode_permission_prompt_full_match() {
        let output = "EXECUTE (command, timeout: 120s, impact: medium)\n> Yes, allow\n  Yes, and always allow medium impact commands (all commands that are reversible)\n  No, cancel";
        let (has_header, has_allow) = detect_opencode_permission_prompt(output);
        assert!(has_header);
        assert!(has_allow);
    }

    #[test]
    fn opencode_permission_prompt_always_allow() {
        let output = "EXECUTE (command, timeout: 60s, impact: high)\nYes, and always allow";
        let (has_header, has_allow) = detect_opencode_permission_prompt(output);
        assert!(has_header);
        assert!(has_allow);
    }

    #[test]
    fn opencode_permission_prompt_no_match() {
        let output = "Running command...\nDone.";
        let (has_header, has_allow) = detect_opencode_permission_prompt(output);
        assert!(!has_header);
        assert!(!has_allow);
    }

    #[test]
    fn opencode_permission_prompt_header_only() {
        let output = "EXECUTE (command, timeout: 120s, impact: medium)\nLoading...";
        let (has_header, has_allow) = detect_opencode_permission_prompt(output);
        assert!(has_header);
        assert!(!has_allow);
    }

    #[test]
    fn opencode_permission_prompt_yes_allow_only() {
        let output = "EXECUTE (command, timeout: 30s, impact: low)\n> Yes, allow\n  No, cancel";
        let (has_header, has_allow) = detect_opencode_permission_prompt(output);
        assert!(has_header);
        assert!(has_allow);
    }

    #[test]
    fn opencode_permission_prompt_high_impact() {
        let output = "EXECUTE (command, timeout: 300s, impact: high)\n> Yes, allow\n  Yes, and always allow high impact commands\n  No, cancel";
        let (has_header, has_allow) = detect_opencode_permission_prompt(output);
        assert!(has_header);
        assert!(has_allow);
    }

    #[test]
    fn opencode_permission_prompt_no_false_positive_execute_word() {
        let output = "EXECUTE SQL query completed successfully.";
        let (has_header, has_allow) = detect_opencode_permission_prompt(output);
        assert!(!has_header);
        assert!(!has_allow);
    }

    #[test]
    fn opencode_permission_prompt_no_false_positive_yes_allow_alone() {
        let output = "The user said: Yes, allow me to explain.";
        let (has_header, has_allow) = detect_opencode_permission_prompt(output);
        assert!(!has_header);
        assert!(has_allow);
    }

    #[test]
    fn opencode_permission_prompt_without_execute_prefix() {
        let output = "(command, timeout: 120s, impact: medium)\n> Yes, allow";
        let (has_header, has_allow) = detect_opencode_permission_prompt(output);
        assert!(!has_header);
        assert!(has_allow);
    }

    #[test]
    fn opencode_permission_prompt_multiline_with_ansi_stripped() {
        let output = "EXECUTE (command, timeout: 120s, impact: medium)\n  Yes, allow\n  Yes, and always allow medium impact commands (all commands that are reversible)\n  No, cancel";
        let (has_header, has_allow) = detect_opencode_permission_prompt(output);
        assert!(has_header);
        assert!(has_allow);
    }

    #[test]
    fn opencode_permission_prompt_empty_input() {
        let (has_header, has_allow) = detect_opencode_permission_prompt("");
        assert!(!has_header);
        assert!(!has_allow);
    }

    #[test]
    fn auto_suggestion_no_false_positive_on_partial_ansi() {
        assert!(!is_auto_suggestion("\x1b[7msome text\x1b[27m normal text"));
    }
}
