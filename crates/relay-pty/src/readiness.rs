use crate::{
    ansi::{floor_char_boundary, strip_ansi},
    terminal::detect_muse_device_auth_prompt,
    wait::{for_cli, WaitSnapshot},
};

/// Rendered terminal state used by readiness checks.
#[derive(Debug, Clone, Copy)]
pub struct GridReadinessSnapshot<'a> {
    /// Plain text rendered from the visible VT grid.
    pub screen: &'a str,
    /// Current 1-indexed cursor position, if known.
    pub cursor: Option<(u16, u16)>,
}

/// Detect CLI readiness from the visible VT grid.
///
/// The raw output buffer is used for protocol-level ready/auth markers
/// and the byte-count startup guard.
pub fn detect_cli_ready(
    cli: &str,
    output: &str,
    total_bytes: usize,
    grid: GridReadinessSnapshot<'_>,
) -> bool {
    let clean = strip_ansi(output);
    let lower_cli = cli.to_lowercase();

    if is_devin_cli(cli) {
        return devin_prompt_ready(grid);
    }

    if clean.contains("->pty:ready") {
        return true;
    }

    if lower_cli.contains("claude") {
        return claude_grid_ready(grid);
    }

    let grid_snapshot = snapshot_for_grid(grid);

    if is_muse_cli(cli) {
        // Muse's device login is an interactive interstitial that draws
        // prompt-like glyphs and plenty of output, so neither a glyph anywhere
        // in the grid nor output volume proves it can accept a task. The
        // cursor must be on a bare composer row and no authentication layout
        // may be visible: the
        // `total_bytes` fallback below is deliberately NOT applied to Muse.
        // Refusing to prove readiness is cheap here — Muse's initial task is
        // passed in argv, so a worker whose prompt is never recognised still
        // does its assigned work.
        return !detect_muse_device_auth_prompt(grid.screen) && muse_prompt_ready(grid);
    }

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
pub fn cli_prompt_ready(cli: &str, grid: GridReadinessSnapshot<'_>) -> bool {
    if is_devin_cli(cli) {
        return devin_prompt_ready(grid);
    }
    let lower_cli = cli.to_lowercase();
    let grid_snapshot = snapshot_for_grid(grid);

    if lower_cli.contains("claude") {
        return claude_prompt_row(grid);
    }
    if is_muse_cli(cli) {
        return muse_prompt_ready(grid);
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

/// Muse reuses prompt glyphs in non-composer UI and rendered transcript text.
/// Only a bare prompt on the cursor's current row is evidence of an active
/// composer; searching the entire grid lets an unrelated glyph prove ready.
fn muse_prompt_ready(grid: GridReadinessSnapshot<'_>) -> bool {
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
        .is_some_and(|line| matches!(line, "›" | "❯" | ">"))
}

/// Match a native executable basename, tolerating Windows suffixes.
///
/// Mirrors the broker's `is_muse_executable` spelling rules; `relay-pty` is
/// the lower crate and cannot depend on the broker.
pub fn is_muse_cli(cli: &str) -> bool {
    let base = cli
        .rsplit(['/', '\\'])
        .next()
        .filter(|part| !part.is_empty())
        .unwrap_or(cli)
        .to_ascii_lowercase();
    let stem = base
        .strip_suffix(".exe")
        .or_else(|| base.strip_suffix(".cmd"))
        .or_else(|| base.strip_suffix(".bat"))
        .unwrap_or(&base);
    stem == "muse"
}

/// Match a native executable basename, including the Windows .exe suffix.
pub fn is_devin_cli(cli: &str) -> bool {
    let base = cli
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(cli)
        .to_ascii_lowercase();
    matches!(base.as_str(), "devin" | "devin.exe")
}

fn devin_prompt_ready(grid: GridReadinessSnapshot<'_>) -> bool {
    let Some((row, _)) = grid.cursor else {
        return false;
    };
    // A trust choice also uses ❭. Require the exact idle placeholder across
    // its visual rows, with the cursor inside that composer. Devin word-wraps
    // continuation rows with two spaces at narrow terminal widths.
    const IDLE: &str = "❭ Ask Devin to build features, fix bugs, or work on your code";
    let Some(cursor_row) = row.checked_sub(1).map(usize::from) else {
        return false;
    };
    let lines: Vec<_> = grid.screen.lines().collect();
    for start in 0..=cursor_row.min(lines.len().saturating_sub(1)) {
        let Some(first) = lines.get(start) else {
            continue;
        };
        if !first.trim().starts_with("❭ ") {
            continue;
        }
        let mut composer = String::new();
        for (end, line) in lines.iter().enumerate().skip(start) {
            if end > start {
                if !line.starts_with("  ") || line.trim().is_empty() {
                    break;
                }
                composer.push(' ');
            }
            composer.push_str(line.trim());
            if composer == IDLE {
                if cursor_row <= end {
                    return true;
                }
                break;
            }
            if !IDLE.starts_with(&composer) {
                break;
            }
        }
    }
    false
}

fn claude_grid_ready(grid: GridReadinessSnapshot<'_>) -> bool {
    let has_welcome = grid.screen.contains("Welcome back")
        || grid.screen.contains("Welcome to ")
        || grid.screen.contains("Claude Code v")
        || grid.screen.contains("ClaudeCodev");
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
    fn devin_requires_live_idle_composer_for_all_executable_spellings() {
        for cli in ["devin", "/usr/local/bin/devin", r"C:\tools\Devin.EXE"] {
            assert!(is_devin_cli(cli));
            let screen = "Devin CLI\n❭ Ask Devin to build features, fix bugs, or work on your code\nSWE-2 High";
            assert!(detect_cli_ready(
                cli,
                "",
                0,
                GridReadinessSnapshot {
                    screen,
                    cursor: Some((2, 3))
                }
            ));
            for blocked in [
                "❭ 1 Yes, trust",
                "❭ Guide Devin while it works",
                "Loading...",
                "❭ submitted text",
            ] {
                assert!(!detect_cli_ready(
                    cli,
                    "->pty:ready",
                    99999,
                    GridReadinessSnapshot {
                        screen: blocked,
                        cursor: Some((1, 3))
                    }
                ));
            }
            assert!(!cli_prompt_ready(
                cli,
                GridReadinessSnapshot {
                    screen,
                    cursor: Some((3, 3))
                }
            ));
        }
        assert!(!is_devin_cli("not-devin"));
        assert!(!is_devin_cli("devin.cmd"));
        assert!(!is_devin_cli("devin.bat"));
    }

    #[test]
    fn devin_wrapped_idle_composer_requires_cursor_in_exact_placeholder() {
        // Captured from Devin 3000.10.31 at 40 columns, including indentation.
        let screen = "────────────────────────────────────────\n❭ Ask Devin to build features, fix \n  bugs, or work on your code\n────────────────────────────────────────\nSWE-2 High";
        for row in [2, 3] {
            let grid = GridReadinessSnapshot {
                screen,
                cursor: Some((row, 3)),
            };
            assert!(cli_prompt_ready("devin", grid));
            assert!(detect_cli_ready("devin", "", 0, grid));
        }
        for row in [0, 1, 4, 5, 99] {
            assert!(!cli_prompt_ready(
                "devin",
                GridReadinessSnapshot {
                    screen,
                    cursor: Some((row, 3))
                }
            ));
        }
        for blocked in [
            "❭ Guide Devin while it works\n  bugs, or work on your code",
            "❭ Ask Devin to build features, fix\n  changed text",
            "❭ Ask Devin to build features, fix\n\n  bugs, or work on your code",
            "❭ Ask Devin to build features, fix\nbugs, or work on your code",
            "❭ 1 Yes, trust\n  this workspace",
        ] {
            assert!(!cli_prompt_ready(
                "devin",
                GridReadinessSnapshot {
                    screen: blocked,
                    cursor: Some((1, 3))
                }
            ));
        }
    }

    #[test]
    fn versioned_claude_banner_with_real_composer_is_ready_without_greeting() {
        let screen = "Claude Code v2.1.263\nOpus 5 · Claude Max\n────────────────\n❯ \n────────────────\n⏵⏵ bypass permissions on";
        assert!(detect_cli_ready(
            "claude",
            "",
            1600,
            GridReadinessSnapshot {
                screen,
                cursor: Some((4, 3))
            }
        ));
    }

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
    fn detect_cli_ready_muse_requires_a_prompt_and_no_auth_screen() {
        // Muse's readiness arm is the generic prompt set minus the byte-count
        // fallback, vetoed by its device-login screen. Output volume cannot
        // prove a Muse worker can accept a task: its device login renders a
        // prompt-like glyph and far more than 500 bytes while waiting on a
        // human, which is how a fleet-spawned worker came to report itself
        // ready and occupy capacity forever.
        let prompt_grid = GridReadinessSnapshot {
            screen: "muse session ready\n❯ \n",
            cursor: Some((2, 3)),
        };
        assert!(detect_cli_ready("muse", "", 100, prompt_grid));
        assert!(detect_cli_ready(
            "/Users/khaliqgant/.local/bin/muse",
            "",
            100,
            prompt_grid
        ));
        assert!(cli_prompt_ready("muse", prompt_grid));

        // A prompt glyph rendered in transcript/output is not the active
        // composer. The generic matcher searches the entire grid, so Muse
        // must additionally prove that the cursor is on the prompt row.
        let transcript_glyph_grid = GridReadinessSnapshot {
            screen: "Previous output uses › as a bullet\nstill loading\n",
            cursor: Some((2, 14)),
        };
        assert!(!detect_cli_ready("muse", "", 100, transcript_glyph_grid));

        let loading_grid = GridReadinessSnapshot {
            screen: "loading...\n",
            cursor: Some((1, 11)),
        };
        assert!(!detect_cli_ready("muse", "loading...", 100, loading_grid));
        assert!(
            !detect_cli_ready("muse", "loading...", 5_001, loading_grid),
            "output volume must not prove Muse readiness"
        );

        // The reported stall: a device-login screen that also carries a
        // prompt glyph and plenty of output.
        let device_auth_grid = GridReadinessSnapshot {
            screen: "Sign in to continue\nVisit https://www.facebook.com/device\n                     and enter this code: ABCD-1234\nWaiting for authentication...\n›\n",
            cursor: Some((5, 3)),
        };
        assert!(!detect_cli_ready("muse", "", 5_001, device_auth_grid));
        assert!(!detect_cli_ready(
            "/Users/khaliqgant/.local/bin/muse.exe",
            "",
            5_001,
            device_auth_grid
        ));

        // Device providers may change the surrounding copy. The URL +
        // labelled code layout must remain blocked even when none of the
        // known authentication phrases are present.
        let unknown_device_auth_grid = GridReadinessSnapshot {
            screen: "Visit https://example.org/activate\nCode: WXYZ\n›\n",
            cursor: Some((3, 2)),
        };
        assert!(!detect_cli_ready(
            "muse",
            "",
            5_001,
            unknown_device_auth_grid
        ));

        // The protocol marker still outranks every screen heuristic, for Muse
        // as for every other CLI: an explicit ready frame from the harness is
        // stronger evidence than anything we infer from a grid.
        assert!(detect_cli_ready(
            "muse",
            "->pty:ready",
            10,
            device_auth_grid
        ));

        // The veto is scoped to the startup gate. `cli_prompt_ready` answers
        // "is a prompt visible" for delivery, where an agent that renders
        // these words mid-session must not have its messages parked — the
        // same split Gemini's `waiting for auth` veto already uses.
        assert!(cli_prompt_ready("muse", device_auth_grid));
    }

    #[test]
    fn is_muse_cli_matches_spellings_without_false_positives() {
        for cli in [
            "muse",
            "Muse",
            "MUSE",
            "muse.exe",
            "muse.cmd",
            "muse.bat",
            "/Users/khaliqgant/.local/bin/muse",
            r"C:\Tools\Muse.CMD",
        ] {
            assert!(is_muse_cli(cli), "{cli} must classify as Muse");
        }
        for cli in ["claude", "codex", "xmuse", "muse2", "amuse.exe", "my-muse"] {
            assert!(!is_muse_cli(cli), "{cli} must not classify as Muse");
        }
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
