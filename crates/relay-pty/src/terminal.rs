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

/// One row of Claude Code's folder-trust selection menu.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct TrustRow {
    line: usize,
    affirmative: bool,
    /// Row carries Claude's `❯` selection glyph.
    caret: bool,
    /// Row carries a plain `>` marker — only trusted when no `❯` is present
    /// anywhere in the block, since `>` also shows up in ordinary prose.
    fallback_marker: bool,
}

/// How to answer a Claude Code folder-trust menu.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClaudeTrustPlan {
    /// Move the highlight `steps` rows (positive = down, negative = up) and
    /// press Enter. `steps == 0` means the affirmative row is already selected.
    Confirm { steps: i32 },
    /// A trust dialog is on screen but the affirmative row or the highlight
    /// could not be identified. Fail closed — send nothing and wait for a
    /// more complete repaint.
    Ambiguous,
    /// No trust menu in this output.
    Absent,
}

/// Collapse a rendered menu line to a comparable key.
///
/// Claude's first paint arrives with the inter-word spacing carried by cursor
/// positioning rather than literal spaces, so an ANSI-stripped row can read
/// `❯No,exit` on the first frame and `❯ No, exit` on the repaint. Dropping all
/// whitespace makes both forms compare equal.
fn normalize_menu_line(line: &str) -> String {
    line.chars()
        .filter(|c| !c.is_whitespace())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

/// Classify a normalized menu row by the identity of its label.
///
/// Returns `Some(true)` for the affirmative row, `Some(false)` for the decline
/// row, `None` for anything else. Deliberately keyed on wording, never on the
/// row's position or its list number: menu *order* is exactly what changed
/// between Claude Code 2.1.236 and 2.1.259+, and 2.1.259+ dropped the numbers.
fn classify_trust_row(norm: &str) -> Option<bool> {
    // Affirmative wordings seen in the wild:
    //   2.1.19  "1. Yes, proceed"
    //   2.1.236 "1. Yes, I trust this folder"
    //   2.1.261 "Yes, I trust this folder"
    if norm.contains("trustthisfolder") || norm.contains("yes,proceed") {
        return Some(true);
    }
    // Decline wordings: "2. No, exit" / "No, exit".
    if norm.contains("no,exit") {
        return Some(false);
    }
    None
}

/// Claude renders the selection highlight as a `❯` glyph. The reverse-video
/// attribute it also sets does not survive `strip_ansi`, so the glyph is the
/// only signal left by the time we see the text.
fn row_has_caret(line: &str) -> bool {
    line.contains('❯')
}

/// Decide how to answer Claude Code's "Do you trust the files in this folder?"
/// menu by reading the rendered menu state.
///
/// Relay used to assume the affirmative option was preselected and answered
/// with a bare Enter. Claude Code 2.1.259+ preselects `No, exit`, so that bare
/// Enter confirmed *exit*: the worker died while its roster row survived, which
/// presents as a ghost agent.
///
/// This resolves the affirmative row by its label and the highlighted row by
/// its glyph, then returns the row delta between them. Because both endpoints
/// are read from the frame rather than assumed, it handles the old order, the
/// new order, and any future reordering. Fails closed when the frame is partial
/// or ambiguous.
pub fn plan_claude_trust_response(clean_output: &str) -> ClaudeTrustPlan {
    let (has_trust_ref, _) = detect_claude_trust_prompt(clean_output);
    if !has_trust_ref {
        return ClaudeTrustPlan::Absent;
    }

    let mut rows: Vec<TrustRow> = Vec::new();
    for (idx, line) in clean_output.lines().enumerate() {
        let norm = normalize_menu_line(line);
        if let Some(affirmative) = classify_trust_row(&norm) {
            rows.push(TrustRow {
                line: idx,
                affirmative,
                caret: row_has_caret(line),
                fallback_marker: line.contains('>'),
            });
        }
    }
    if rows.is_empty() {
        return ClaudeTrustPlan::Absent;
    }

    // The buffer accumulates every repaint, so the same menu can appear several
    // times and only the newest paint says where the highlight actually sits.
    // Anchor on the *last* highlighted row and grow the menu block outward from
    // it across adjacent rows. Anchoring on the newest highlight rather than
    // slicing the row list into groups keeps this correct even when two paints
    // land close enough together to look contiguous.
    //
    // Prefer the real `❯` glyph; a bare `>` counts only when no row carries a
    // caret, so stray prose punctuation cannot steal the highlight from the row
    // that actually holds it.
    let anchor = rows
        .iter()
        .rposition(|r| r.caret)
        .or_else(|| rows.iter().rposition(|r| r.fallback_marker));
    let Some(anchor) = anchor else {
        // Options are painting but nothing is highlighted yet.
        return ClaudeTrustPlan::Ambiguous;
    };

    let mut start = anchor;
    while start > 0 && rows[start].line.saturating_sub(rows[start - 1].line) <= MAX_TRUST_ROW_GAP {
        start -= 1;
    }
    let mut end = anchor;
    while end + 1 < rows.len()
        && rows[end + 1].line.saturating_sub(rows[end].line) <= MAX_TRUST_ROW_GAP
    {
        end += 1;
    }
    let block = &rows[start..=end];
    let cursor = anchor - start;

    // Take the affirmative row nearest the highlight. If a stale paint ever did
    // sit close enough to be absorbed into this block, its copy of the
    // affirmative row is further from the live highlight than the live one is.
    let target = block
        .iter()
        .enumerate()
        .filter(|(_, r)| r.affirmative)
        .min_by_key(|(idx, _)| idx.abs_diff(cursor))
        .map(|(idx, _)| idx);

    match target {
        Some(target) => ClaudeTrustPlan::Confirm {
            steps: target as i32 - cursor as i32,
        },
        // The highlight has painted but the affirmative row has not. The frame
        // is still arriving — never guess which way to move.
        None => ClaudeTrustPlan::Ambiguous,
    }
}

/// Menu rows sit on adjacent lines; a larger gap means a different repaint.
const MAX_TRUST_ROW_GAP: usize = 3;

/// Detect Claude Code auto-suggestion ghost text.
pub fn is_auto_suggestion(output: &str) -> bool {
    let has_cursor_ghost = output.contains("\x1b[7m") && output.contains("\x1b[27m\x1b[2m");
    let has_send_hint = output.contains("↵ send");
    has_cursor_ghost || has_send_hint
}

#[cfg(test)]
mod tests {
    use super::*;

    // ==================== plan_claude_trust_response ====================
    //
    // Fixtures below are verbatim ANSI-stripped captures from real PTY spawns
    // into a directory absent from ~/.claude.json, taken 2026-09-05.
    //
    // Claude paints the dialog with cursor-positioning escapes rather than
    // literal spaces, so the first frame arrives with the inter-word spacing
    // collapsed ("❯No,exit"). Repaints come through spaced. Both forms appear
    // here on purpose.

    /// claude-code 2.1.261 — `No, exit` preselected, affirmative second,
    /// options unnumbered. This is the layout that kills relay workers today.
    const TRUST_2_1_261: &str = "\
────────────────────────────────────────\n\
\n\
Accessingworkspace:\n\
\n\
/private/var/folders/6d/T/cap1654-x9931vba\n\
\n\
Quicksafetycheck:Isthisaprojectyoucreatedoroneyoutrust?(Likeyourowncode,awell-knownopensource\n\
project,orworkfromyourteam).Ifnot,takeamomenttoreviewwhat'sinthisfolderfirst.\n\
\n\
ClaudeCode'llbeabletoread,edit,andexecutefileshere.\n\
\n\
Securityguide\n\
\n\
❯No,exit\n\
\n\
Yes,Itrustthisfolder\n\
\n\
Entertoconfirm·Esctocancel\n";

    /// claude-code 2.1.236 — affirmative preselected and numbered.
    const TRUST_2_1_236: &str = "\
────────────────────────────────────────\n\
\n\
Accessingworkspace:\n\
\n\
/private/var/folders/6d/T/cap1654-n7dhlxc6\n\
\n\
Quicksafetycheck:Isthisaprojectyoucreatedoroneyoutrust?(Likeyourowncode,awell-knownopensource\n\
project,orworkfromyourteam).Ifnot,takeamomenttoreviewwhat'sinthisfolderfirst.\n\
\n\
ClaudeCode'llbeabletoread,edit,andexecutefileshere.\n\
\n\
Securityguide\n\
\n\
❯1.Yes,Itrustthisfolder\n\
\n\
2.No,exit\n\
\n\
Entertoconfirm·Esctocancel\n";

    #[test]
    fn claude_trust_new_ordering_steps_down_to_affirmative() {
        // 2.1.259+ preselects "No, exit"; the affirmative row is one below.
        assert_eq!(
            plan_claude_trust_response(TRUST_2_1_261),
            ClaudeTrustPlan::Confirm { steps: 1 }
        );
    }

    #[test]
    fn claude_trust_legacy_ordering_confirms_without_moving() {
        // 2.1.236 already sits on the affirmative row — moving would select
        // "No, exit" and reintroduce the bug in the other direction.
        assert_eq!(
            plan_claude_trust_response(TRUST_2_1_236),
            ClaudeTrustPlan::Confirm { steps: 0 }
        );
    }

    #[test]
    fn claude_trust_legacy_yes_proceed_wording() {
        // claude-code 2.1.19 wording, captured in relay#756.
        let output = "Do you trust the files in this folder?\n\
                      /project\n\
                      \n\
                      ❯ 1. Yes, proceed\n\
                        2. No, exit\n\
                      \n\
                      Enter to confirm · Esc to cancel\n";
        assert_eq!(
            plan_claude_trust_response(output),
            ClaudeTrustPlan::Confirm { steps: 0 }
        );
    }

    #[test]
    fn claude_trust_spaced_repaint_matches_collapsed_frame() {
        // Same menu, repainted with real spaces. Must resolve identically to
        // the collapsed first frame.
        let output = "Do you trust the files in this folder?\n\
                      \n\
                      ❯ No, exit\n\
                        Yes, I trust this folder\n";
        assert_eq!(
            plan_claude_trust_response(output),
            ClaudeTrustPlan::Confirm { steps: 1 }
        );
    }

    #[test]
    fn claude_trust_uses_the_latest_repaint() {
        // The buffer accumulates frames. An earlier frame had the highlight on
        // the affirmative row; the current one has it on "No, exit". Answering
        // from the stale frame would confirm exit.
        let mut output = String::from("Do you trust the files in this folder?\n");
        output.push_str("❯ Yes, I trust this folder\n  No, exit\n");
        output.push_str("\n\n\n\n\n\n");
        output.push_str("Do you trust the files in this folder?\n");
        output.push_str("❯ No, exit\n  Yes, I trust this folder\n");
        assert_eq!(
            plan_claude_trust_response(&output),
            ClaudeTrustPlan::Confirm { steps: 1 }
        );
    }

    #[test]
    fn claude_trust_resolves_against_adjacent_stale_paint() {
        // A stale paint sitting close enough to be absorbed into the same block
        // as the live one. The highlight anchors on the newest row, and the
        // affirmative row nearest that highlight is the live one.
        let output = "Do you trust the files in this folder?\n\
                      ❯ Yes, I trust this folder\n\
                        No, exit\n\
                      ❯ No, exit\n\
                        Yes, I trust this folder\n";
        assert_eq!(
            plan_claude_trust_response(output),
            ClaudeTrustPlan::Confirm { steps: 1 }
        );
    }

    #[test]
    fn claude_trust_options_without_highlight_are_ambiguous() {
        // Both rows painted, highlight not yet drawn. The old code would have
        // pressed Enter here.
        let output = "Do you trust the files in this folder?\n\
                        No, exit\n\
                        Yes, I trust this folder\n";
        assert_eq!(
            plan_claude_trust_response(output),
            ClaudeTrustPlan::Ambiguous
        );
    }

    #[test]
    fn claude_trust_partial_frame_is_ambiguous() {
        // Header and one option have painted, the highlight has not. Sending
        // Enter here is exactly the old bug.
        let output = "Do you trust the files in this folder?\n\
                      Yes, I trust this folder\n";
        assert_eq!(
            plan_claude_trust_response(output),
            ClaudeTrustPlan::Ambiguous
        );
    }

    #[test]
    fn claude_trust_absent_from_normal_output() {
        let output = "Reading files...\nWrote src/main.rs\n";
        assert_eq!(plan_claude_trust_response(output), ClaudeTrustPlan::Absent);
    }

    #[test]
    fn claude_trust_header_without_menu_is_absent() {
        // Trust wording in prose, no menu rows — must not act.
        let output = "This folder is not in your trust list yet.\n";
        assert_eq!(plan_claude_trust_response(output), ClaudeTrustPlan::Absent);
    }

    #[test]
    fn claude_trust_survives_a_future_reordering() {
        // A third layout nobody has shipped: affirmative two rows below the
        // highlight. Position is read, never assumed.
        let output = "Do you trust the files in this folder?\n\
                      ❯ No, exit\n\
                        No, exit and forget this folder\n\
                        Yes, I trust this folder\n";
        assert_eq!(
            plan_claude_trust_response(output),
            ClaudeTrustPlan::Confirm { steps: 2 }
        );
    }

    #[test]
    fn claude_trust_steps_up_when_affirmative_is_above() {
        let output = "Do you trust the files in this folder?\n\
                        Yes, I trust this folder\n\
                      ❯ No, exit\n";
        assert_eq!(
            plan_claude_trust_response(output),
            ClaudeTrustPlan::Confirm { steps: -1 }
        );
    }

    #[test]
    fn claude_trust_prose_caret_does_not_steal_the_highlight() {
        // A stray `>` on the decline row must not outrank the real `❯`.
        let output = "Do you trust the files in this folder?\n\
                        No, exit  ->  quits immediately\n\
                      ❯ Yes, I trust this folder\n";
        assert_eq!(
            plan_claude_trust_response(output),
            ClaudeTrustPlan::Confirm { steps: 0 }
        );
    }

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
