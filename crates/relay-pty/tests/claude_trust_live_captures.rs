//! Trust-menu planning driven by unmodified PTY captures from real Claude Code
//! binaries.
//!
//! The unit tests in `terminal.rs` assert against hand-transcribed menus. These
//! run the production `strip_ansi` over the raw bytes a real `claude` wrote to a
//! real pty, so a regression in ANSI handling — not just in the menu parser —
//! also trips them.
//!
//! Captures were taken on 2026-09-05 by spawning each binary into a freshly
//! created `/private/tmp/relay-trust-fixture`, absent from the `projects` map in
//! `~/.claude.json`, in a 120x40 pty, recording every byte up to the trust
//! dialog. The bytes are stored exactly as the child wrote them.

use relay_pty::ansi::strip_ansi;
use relay_pty::terminal::{plan_claude_trust_response, ClaudeTrustPlan};

/// claude-code 2.1.261: `No, exit` preselected, affirmative second, unnumbered.
/// This is the layout reported in relay#1654.
const CAPTURE_2_1_261: &[u8] = include_bytes!("fixtures/claude-trust-2.1.261.pty");

/// claude-code 2.1.236: affirmative preselected and numbered.
const CAPTURE_2_1_236: &[u8] = include_bytes!("fixtures/claude-trust-2.1.236.pty");

fn plan_for(capture: &[u8]) -> ClaudeTrustPlan {
    let text = String::from_utf8_lossy(capture);
    plan_claude_trust_response(&strip_ansi(&text))
}

#[test]
fn live_2_1_261_capture_steps_down_to_the_affirmative_row() {
    // Answering this frame with a bare Enter confirms "No, exit" and kills the
    // worker while its roster row survives — the relay#1654 ghost agent.
    assert_eq!(
        plan_for(CAPTURE_2_1_261),
        ClaudeTrustPlan::Confirm { steps: 1 }
    );
}

#[test]
fn live_2_1_236_capture_confirms_without_moving() {
    assert_eq!(
        plan_for(CAPTURE_2_1_236),
        ClaudeTrustPlan::Confirm { steps: 0 }
    );
}

#[test]
fn live_captures_really_do_disagree_about_ordering() {
    // Guards the fixtures themselves: if someone re-records both captures from
    // the same Claude version, the pair stops covering two orderings and the
    // tests above would agree for the wrong reason.
    assert_ne!(
        plan_for(CAPTURE_2_1_261),
        plan_for(CAPTURE_2_1_236),
        "fixtures must capture two different menu orderings"
    );
}
