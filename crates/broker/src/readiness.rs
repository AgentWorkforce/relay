use crate::{
    helpers::{floor_char_boundary, strip_ansi},
    wait::{for_cli, WaitSnapshot},
};

/// Rendered terminal state used by readiness checks.
#[derive(Debug, Clone, Copy)]
pub(crate) struct GridReadinessSnapshot<'a> {
    /// Plain text rendered from the visible VT grid.
    pub screen: &'a str,
    /// Current 1-indexed cursor position, if known.
    pub cursor: Option<(u16, u16)>,
}

/// Detect CLI readiness from the visible VT grid.
///
/// The raw output buffer is used for protocol-level ready/auth markers
/// and the byte-count startup guard.
pub(crate) fn detect_cli_ready(
    cli: &str,
    output: &str,
    total_bytes: usize,
    grid: GridReadinessSnapshot<'_>,
) -> bool {
    let clean = strip_ansi(output);
    let lower_cli = cli.to_lowercase();

    if clean.contains("->pty:ready") {
        return true;
    }

    if lower_cli.contains("claude") {
        return claude_grid_ready(grid);
    }

    let grid_snapshot = snapshot_for_grid(grid);

    if lower_cli.contains("gemini") {
        let clean_window = tail_chars(&clean, 2000).to_lowercase();
        let screen_lower = grid.screen.to_lowercase();
        if clean_window.contains("waiting for auth") || screen_lower.contains("waiting for auth") {
            return false;
        }
        return for_cli::gemini().evaluate(&grid_snapshot).is_some();
    }

    let set = if lower_cli.contains("codex") {
        for_cli::codex()
    } else {
        for_cli::generic()
    };
    if set.evaluate(&grid_snapshot).is_some() {
        return true;
    }

    total_bytes > 500
}

/// Detect prompt visibility from the rendered grid.
pub(crate) fn cli_prompt_ready(cli: &str, grid: GridReadinessSnapshot<'_>) -> bool {
    let lower_cli = cli.to_lowercase();
    let grid_snapshot = snapshot_for_grid(grid);

    if lower_cli.contains("claude") {
        return claude_prompt_row(grid);
    }
    if lower_cli.contains("gemini") {
        return for_cli::gemini().evaluate(&grid_snapshot).is_some();
    }

    let set = if lower_cli.contains("codex") {
        for_cli::codex()
    } else {
        for_cli::generic()
    };
    set.evaluate(&grid_snapshot).is_some()
}

fn claude_grid_ready(grid: GridReadinessSnapshot<'_>) -> bool {
    let has_welcome = grid.screen.contains("Welcome back") || grid.screen.contains("Welcome to ");
    has_welcome && claude_prompt_row(grid)
}

fn claude_prompt_row(grid: GridReadinessSnapshot<'_>) -> bool {
    let Some((row, _col)) = grid.cursor else {
        return false;
    };
    if row == 0 {
        return false;
    }
    grid.screen
        .lines()
        .nth((row - 1) as usize)
        .map(str::trim)
        .is_some_and(|line| matches!(line, "❯" | ">"))
}

/// Return the suffix of `s` containing at most `n` bytes, snapped to a
/// char boundary so multi-byte sequences aren't sliced.
fn tail_chars(s: &str, n: usize) -> &str {
    if s.len() > n {
        let start = floor_char_boundary(s, s.len() - n);
        &s[start..]
    } else {
        s
    }
}

fn snapshot_for_grid(grid: GridReadinessSnapshot<'_>) -> WaitSnapshot<'_> {
    let snap = WaitSnapshot::text_only(grid.screen);
    if let Some((row, col)) = grid.cursor {
        snap.with_cursor(row, col)
    } else {
        snap
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_cli_ready_prompt_patterns() {
        assert!(detect_cli_ready(
            "claude",
            "",
            100,
            GridReadinessSnapshot {
                screen: "Welcome back Khaliq!\n❯\n",
                cursor: Some((2, 2)),
            },
        ));
        assert!(detect_cli_ready(
            "claude",
            "",
            100,
            GridReadinessSnapshot {
                screen: "Welcome to Opus 4.5\n>\n",
                cursor: Some((2, 2)),
            },
        ));
        assert!(detect_cli_ready(
            "codex",
            "",
            100,
            GridReadinessSnapshot {
                screen: "Ready\ncodex> \n",
                cursor: Some((2, 8)),
            },
        ));
        assert!(detect_cli_ready(
            "aider",
            "",
            100,
            GridReadinessSnapshot {
                screen: "some output\n$ \n",
                cursor: Some((2, 3)),
            },
        ));
    }

    #[test]
    fn detect_cli_ready_byte_fallback() {
        let loading_grid = GridReadinessSnapshot {
            screen: "loading...\n",
            cursor: Some((1, 11)),
        };

        assert!(!detect_cli_ready("claude", "loading...", 600, loading_grid));
        assert!(!detect_cli_ready("aider", "loading...", 500, loading_grid));
        assert!(detect_cli_ready("aider", "loading...", 501, loading_grid));
    }

    #[test]
    fn detect_cli_ready_gemini_waiting_for_auth_not_ready() {
        let waiting = "Gemini CLI update available!\n\
            Waiting for auth... (Press ESC or CTRL+C to cancel)\n";
        assert!(!detect_cli_ready(
            "gemini",
            waiting,
            5_000,
            GridReadinessSnapshot {
                screen: waiting,
                cursor: Some((2, 1)),
            },
        ));
    }

    #[test]
    fn detect_cli_ready_gemini_compose_prompt_ready() {
        let ready = "? for shortcuts\n\
            Type your message or @path/to/file\n\
            /model Auto (Gemini 3)\n";
        assert!(detect_cli_ready(
            "gemini",
            "",
            5_000,
            GridReadinessSnapshot {
                screen: ready,
                cursor: Some((2, 36)),
            },
        ));
    }

    #[test]
    fn detect_cli_ready_explicit_signal() {
        assert!(detect_cli_ready(
            "claude",
            "->pty:ready",
            0,
            GridReadinessSnapshot {
                screen: "",
                cursor: None,
            },
        ));
    }

    #[test]
    fn detect_cli_ready_claude_menu_rows_not_ready() {
        for screen in [
            "Welcome to Claude Code v2.1.19\nChoose the text style\n❯ 1. Dark mode\n2. Light mode\n",
            "Welcome to Claude Code v2.1.19\nWARNING: Claude Code running in Bypass Permissions mode\n❯ 1. No, exit\n2. Yes, I accept\n",
            "Welcome to Claude Code v2.1.19\nSelect login method:\n❯ 1  Claude account with subscription\n2  Anthropic Console account\n",
        ] {
            assert!(!detect_cli_ready(
                "claude",
                "",
                500,
                GridReadinessSnapshot {
                    screen,
                    cursor: Some((3, 2)),
                },
            ));
        }

        assert!(!detect_cli_ready(
            "claude",
            "",
            100,
            GridReadinessSnapshot {
                screen: "some startup output\n❯\n",
                cursor: Some((2, 2)),
            },
        ));
    }

    #[test]
    fn detect_cli_ready_uses_visible_screen() {
        let cleared_prompt_output = "prompt\n> \n\x1b[2Jstill loading";
        let grid = GridReadinessSnapshot {
            screen: "still loading\n",
            cursor: Some((1, 14)),
        };

        assert!(!detect_cli_ready("aider", cleared_prompt_output, 100, grid));
    }

    #[test]
    fn detect_cli_ready_detects_visible_generic_prompt() {
        let grid = GridReadinessSnapshot {
            screen: "ready\n$ \n",
            cursor: Some((2, 3)),
        };

        assert!(detect_cli_ready("aider", "loading...", 100, grid));
    }

    #[test]
    fn detect_cli_ready_requires_claude_cursor_on_bare_prompt_row() {
        let ready_grid = GridReadinessSnapshot {
            screen: "Welcome back Khaliq!\nOpus 4.5\n❯\n",
            cursor: Some((3, 2)),
        };
        assert!(detect_cli_ready("claude", "", 100, ready_grid));

        let cursor_elsewhere = GridReadinessSnapshot {
            screen: ready_grid.screen,
            cursor: Some((2, 1)),
        };
        assert!(!detect_cli_ready("claude", "", 100, cursor_elsewhere));

        let menu_grid = GridReadinessSnapshot {
            screen: "Welcome to Claude Code v2.1.19\n❯ 1. Dark mode\n  2. Light mode\n",
            cursor: Some((2, 2)),
        };
        assert!(!detect_cli_ready("claude", "", 100, menu_grid));
    }

    #[test]
    fn detect_cli_ready_uses_visible_gemini_prompt() {
        let cleared_prompt_output = "Type your message or @path/to/file\n\x1b[2JWaiting for auth";
        let grid = GridReadinessSnapshot {
            screen: "Waiting for auth... (Press ESC or CTRL+C to cancel)\n",
            cursor: Some((1, 1)),
        };
        assert!(!detect_cli_ready(
            "gemini",
            cleared_prompt_output,
            5_000,
            grid
        ));

        let grid = GridReadinessSnapshot {
            screen: "Type your message or @path/to/file\n",
            cursor: Some((1, 36)),
        };
        assert!(detect_cli_ready("gemini", "", 5_000, grid));
    }

    #[test]
    fn detect_cli_ready_empty_output() {
        assert!(!detect_cli_ready(
            "claude",
            "",
            0,
            GridReadinessSnapshot {
                screen: "",
                cursor: None,
            },
        ));
    }

    #[test]
    fn detect_cli_ready_unknown_cli_fallback() {
        let prompt_grid = GridReadinessSnapshot {
            screen: "$ \n",
            cursor: Some((1, 3)),
        };
        let loading_grid = GridReadinessSnapshot {
            screen: "loading...\n",
            cursor: Some((1, 11)),
        };

        assert!(detect_cli_ready("mystery-cli", "", 50, prompt_grid));
        assert!(detect_cli_ready(
            "mystery-cli",
            "loading...",
            600,
            loading_grid,
        ));
    }
}
