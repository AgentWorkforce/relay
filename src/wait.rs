//! Composable wait conditions for PTY readiness and friends.
//!
//! Each `WaitCondition` is a single primitive — Text / Idle / Change /
//! Exit / Cursor — and a `WaitSet` is the AND-composition of one or
//! more of them. A `WaitState` is the streaming evaluator: feed it
//! output chunks, then ask whether all the conditions are simultaneously
//! satisfied.
//!
//! Readiness code can combine text, idle, change, exit, and cursor
//! conditions. Cursor waits are evaluated against the 1-indexed cursor
//! position exposed by the alacritty-backed PTY grid.
//! ```ignore
//! use std::time::Duration;
//!
//! let claude_ready = WaitSet::new()
//!     .text("Welcome back")
//!     .idle(Duration::from_millis(200));
//!
//! let mut state = claude_ready.state();
//! state.feed("Welcome back Khaliq!\n❯\n");
//! // Idle hasn't elapsed yet, so not ready.
//! assert!(!state.is_ready());
//! ```

use std::time::{Duration, Instant};

use regex::Regex;

/// A single wait primitive. `WaitSet` composes these with logical AND.
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub enum WaitCondition {
    /// The (ANSI-stripped) screen must contain the given match.
    Text(TextMatch),
    /// The cursor must land at an exact 1-indexed (row, col).
    Cursor { row: u16, col: u16 },
    /// No output has arrived for at least this duration. The timer
    /// starts when `WaitState` is created and resets on every chunk.
    Idle(Duration),
    /// Any non-empty output chunk has arrived since the wait began.
    Change,
    /// The underlying process has exited.
    Exit,
}

/// Either a literal substring or a precompiled regex.
#[derive(Debug, Clone)]
pub enum TextMatch {
    Substring(String),
    Regex(Regex),
}

impl TextMatch {
    pub fn substring<S: Into<String>>(needle: S) -> Self {
        Self::Substring(needle.into())
    }

    pub fn regex(pattern: &str) -> Result<Self, regex::Error> {
        Ok(Self::Regex(Regex::new(pattern)?))
    }

    fn is_match(&self, screen: &str) -> bool {
        match self {
            TextMatch::Substring(needle) => screen.contains(needle.as_str()),
            TextMatch::Regex(re) => re.is_match(screen),
        }
    }
}

/// An AND-composed set of wait conditions.
///
/// Build it with the `text` / `text_regex` / `idle` / `change` / `exit`
/// / `cursor` chaining methods, then drive it with [`WaitSet::state`].
#[derive(Debug, Clone, Default)]
pub struct WaitSet {
    conditions: Vec<WaitCondition>,
}

#[allow(dead_code)]
impl WaitSet {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn from_conditions<I: IntoIterator<Item = WaitCondition>>(conds: I) -> Self {
        Self {
            conditions: conds.into_iter().collect(),
        }
    }

    pub fn with(mut self, cond: WaitCondition) -> Self {
        self.conditions.push(cond);
        self
    }

    /// Require the screen to contain `needle` as a substring.
    pub fn text<S: Into<String>>(self, needle: S) -> Self {
        self.with(WaitCondition::Text(TextMatch::substring(needle)))
    }

    /// Require the screen to match the given regex.
    pub fn text_regex(self, pattern: &str) -> Result<Self, regex::Error> {
        Ok(self.with(WaitCondition::Text(TextMatch::regex(pattern)?)))
    }

    /// Require no output for at least `dur`. Resets on each chunk.
    pub fn idle(self, dur: Duration) -> Self {
        self.with(WaitCondition::Idle(dur))
    }

    /// Require at least one non-empty output chunk since the wait began.
    pub fn change(self) -> Self {
        self.with(WaitCondition::Change)
    }

    /// Require the process to have exited.
    pub fn exit(self) -> Self {
        self.with(WaitCondition::Exit)
    }

    /// Require the cursor to land at an exact 1-indexed position.
    pub fn cursor(self, row: u16, col: u16) -> Self {
        self.with(WaitCondition::Cursor { row, col })
    }

    pub fn conditions(&self) -> &[WaitCondition] {
        &self.conditions
    }

    pub fn is_empty(&self) -> bool {
        self.conditions.is_empty()
    }

    pub fn len(&self) -> usize {
        self.conditions.len()
    }

    /// Start a streaming evaluator.
    pub fn state(&self) -> WaitState<'_> {
        WaitState::new(self)
    }

    /// Evaluate against a pre-built snapshot. Useful for callers that
    /// already hold screen state and timing.
    pub fn evaluate(&self, snap: &WaitSnapshot<'_>) -> Option<Trigger> {
        if self.conditions.is_empty() {
            return None;
        }
        for cond in &self.conditions {
            if !condition_met(cond, snap) {
                return None;
            }
        }
        Some(preferred_trigger(&self.conditions))
    }
}

/// Snapshot of the world used by [`WaitSet::evaluate`].
pub struct WaitSnapshot<'a> {
    /// Screen text used by `Text` conditions.
    pub screen: &'a str,
    /// How long since the last output chunk arrived. Used by `Idle`.
    pub idle_for: Duration,
    /// Whether any output chunk has been observed.
    pub change_seen: bool,
    /// Whether the process has exited.
    pub exited: bool,
    /// Current 1-indexed cursor position from the PTY grid, if known.
    pub cursor: Option<(u16, u16)>,
}

impl<'a> WaitSnapshot<'a> {
    /// Build a text-only snapshot for callers that do not have a VT grid.
    ///
    /// Idle/Change are treated as satisfied so only `Text` conditions
    /// participate. `Cursor` conditions remain unsatisfied because no
    /// cursor position is available.
    pub fn text_only(screen: &'a str) -> Self {
        Self {
            screen,
            idle_for: Duration::MAX,
            change_seen: true,
            exited: false,
            cursor: None,
        }
    }

    /// Attach a 1-indexed cursor position, such as
    /// `PtySession::cursor_position()`.
    pub fn with_cursor(mut self, row: u16, col: u16) -> Self {
        self.cursor = Some((row, col));
        self
    }
}

fn condition_met(cond: &WaitCondition, snap: &WaitSnapshot<'_>) -> bool {
    match cond {
        WaitCondition::Text(m) => m.is_match(snap.screen),
        WaitCondition::Cursor { row, col } => snap.cursor == Some((*row, *col)),
        WaitCondition::Idle(d) => snap.idle_for >= *d,
        WaitCondition::Change => snap.change_seen,
        WaitCondition::Exit => snap.exited,
    }
}

/// Streaming evaluator over a `WaitSet`.
///
/// Feed it ANSI-stripped chunks via [`feed`](Self::feed) (or raw chunks
/// via [`feed_raw`](Self::feed_raw)); the state tracks the accumulated
/// screen, the last-chunk timestamp, whether any change was seen, and
/// the exit flag. Use [`check`](Self::check) to ask whether *every*
/// condition is currently satisfied.
#[allow(dead_code)]
pub struct WaitState<'a> {
    set: &'a WaitSet,
    screen: String,
    last_chunk_at: Instant,
    change_seen: bool,
    exited: bool,
    cursor: Option<(u16, u16)>,
}

#[allow(dead_code)]
impl<'a> WaitState<'a> {
    fn new(set: &'a WaitSet) -> Self {
        Self {
            set,
            screen: String::new(),
            last_chunk_at: Instant::now(),
            change_seen: false,
            exited: false,
            cursor: None,
        }
    }

    /// Append an already-ANSI-stripped chunk.
    pub fn feed(&mut self, chunk: &str) {
        if chunk.is_empty() {
            return;
        }
        self.screen.push_str(chunk);
        self.change_seen = true;
        self.last_chunk_at = Instant::now();
    }

    /// Append a raw chunk; ANSI escapes are stripped before storage.
    pub fn feed_raw(&mut self, chunk: &str) {
        if chunk.is_empty() {
            return;
        }
        self.feed(&crate::helpers::strip_ansi(chunk));
    }

    pub fn mark_exited(&mut self) {
        self.exited = true;
    }

    /// Update the current 1-indexed cursor position, typically from
    /// `PtySession::cursor_position()`.
    pub fn set_cursor_position(&mut self, row: u16, col: u16) {
        self.cursor = Some((row, col));
    }

    /// Clear cursor state when the caller no longer has a trustworthy
    /// PTY-grid snapshot.
    pub fn clear_cursor_position(&mut self) {
        self.cursor = None;
    }

    pub fn screen(&self) -> &str {
        &self.screen
    }

    pub fn change_seen(&self) -> bool {
        self.change_seen
    }

    pub fn exited(&self) -> bool {
        self.exited
    }

    pub fn cursor_position(&self) -> Option<(u16, u16)> {
        self.cursor
    }

    fn snapshot(&self) -> WaitSnapshot<'_> {
        WaitSnapshot {
            screen: &self.screen,
            idle_for: self.last_chunk_at.elapsed(),
            change_seen: self.change_seen,
            exited: self.exited,
            cursor: self.cursor,
        }
    }

    /// Returns `Some(trigger)` when every condition in the underlying
    /// `WaitSet` is satisfied, else `None`. An empty `WaitSet` always
    /// returns `None`.
    pub fn check(&self) -> Option<Trigger> {
        self.set.evaluate(&self.snapshot())
    }

    pub fn is_ready(&self) -> bool {
        self.check().is_some()
    }
}

/// Human-readable label for which condition fired.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Trigger {
    Text,
    Cursor,
    Idle,
    Change,
    Exit,
}

fn preferred_trigger(conds: &[WaitCondition]) -> Trigger {
    // Priority: Exit > Text > Cursor > Idle > Change.
    for c in conds {
        if matches!(c, WaitCondition::Exit) {
            return Trigger::Exit;
        }
    }
    for c in conds {
        if matches!(c, WaitCondition::Text(_)) {
            return Trigger::Text;
        }
    }
    for c in conds {
        if matches!(c, WaitCondition::Cursor { .. }) {
            return Trigger::Cursor;
        }
    }
    for c in conds {
        if matches!(c, WaitCondition::Idle(_)) {
            return Trigger::Idle;
        }
    }
    Trigger::Change
}

/// Pre-built text-only `WaitSet`s expressing each CLI's "screen looks
/// ready" rule.
#[allow(dead_code)]
pub mod for_cli {
    use std::time::Duration;

    use super::{WaitSet, IDLE_SETTLE};

    /// Claude Code: welcome banner has rendered AND the bare prompt
    /// (`❯` or `>`) has landed on its own line. The bare-prompt check
    /// is what stops onboarding menus (theme picker, bypass
    /// permissions) from being mistaken for the input prompt — those
    /// draw `❯` followed by menu text, not a bare `❯`.
    pub fn claude() -> WaitSet {
        WaitSet::new()
            .text_regex(r"Welcome (back|to )")
            .expect("static claude regex")
            .text_regex(r"(?m)^\s*(❯|>)\s*$")
            .expect("static claude regex")
    }

    /// Gemini CLI: the compose prompt is visible. Gemini emits a large
    /// startup/auth banner before it can accept input; this rule keys
    /// off the literal compose-prompt string. The "still waiting for
    /// auth" exclusion is a negative check that can't be expressed in
    /// the AND-composed primitive — callers handle it inline.
    pub fn gemini() -> WaitSet {
        WaitSet::new().text("Type your message or @path/to/file")
    }

    /// Codex CLI: any of the common prompt substrings (`codex> `,
    /// `> `, `$ `, `>>> `, `›`, `❯`) appears in the screen.
    pub fn codex() -> WaitSet {
        WaitSet::new()
            .text_regex(r"(codex> |> |\$ |>>> |›|❯)")
            .expect("static codex regex")
    }

    /// Generic fallback for unknown CLIs: any of the common prompt
    /// substrings (`> `, `$ `, `>>> `, `›`, `❯`) appears in the screen.
    pub fn generic() -> WaitSet {
        WaitSet::new()
            .text_regex(r"(> |\$ |>>> |›|❯)")
            .expect("static generic regex")
    }

    /// Pick the right text-only `WaitSet` from a CLI name or path.
    pub fn detect(cli: &str) -> WaitSet {
        let lower = cli.to_lowercase();
        if lower.contains("claude") {
            claude()
        } else if lower.contains("gemini") {
            gemini()
        } else if lower.contains("codex") {
            codex()
        } else {
            generic()
        }
    }

    /// Convenience: a `WaitSet` that waits for the process to exit.
    pub fn exited() -> WaitSet {
        WaitSet::new().exit()
    }

    /// Convenience: a `WaitSet` that waits for any output, then a quiet
    /// settle window. Useful as a "burst detector" after an injection.
    pub fn burst_then_idle(idle: Duration) -> WaitSet {
        WaitSet::new().change().idle(idle)
    }

    /// Convenience: chain a streaming settle window onto any text-only
    /// per-CLI `WaitSet`. Equivalent to `set.idle(IDLE_SETTLE)`.
    pub fn with_settle(set: WaitSet) -> WaitSet {
        set.idle(IDLE_SETTLE)
    }
}

/// Default settle window paired with text checks in [`for_cli`]. Sized
/// to the worst-case repaint latency we've seen across the supported
/// CLIs.
pub const IDLE_SETTLE: Duration = Duration::from_millis(200);

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;

    #[test]
    fn text_substring_match() {
        let set = WaitSet::new().text("ready");
        let mut s = set.state();
        assert!(s.check().is_none());
        s.feed("not yet...");
        assert!(s.check().is_none());
        s.feed("ready now");
        assert_eq!(s.check(), Some(Trigger::Text));
    }

    #[test]
    fn text_regex_match() {
        let set = WaitSet::new().text_regex(r"^\$\s*$").unwrap();
        let mut s = set.state();
        s.feed("blah\n$ \n");
        // multi-line: regex without `(?m)` only matches whole input
        assert!(s.check().is_none());

        let set = WaitSet::new().text_regex(r"(?m)^\$\s*$").unwrap();
        let mut s = set.state();
        s.feed("blah\n$ \n");
        assert_eq!(s.check(), Some(Trigger::Text));
    }

    #[test]
    fn regex_compile_error() {
        let err = WaitSet::new().text_regex("[unclosed").unwrap_err();
        let _ = err; // just confirm it surfaces
    }

    #[test]
    fn idle_requires_elapsed_quiet() {
        let set = WaitSet::new().idle(Duration::from_millis(40));
        let mut s = set.state();
        s.feed("hello");
        assert!(s.check().is_none(), "idle timer just reset");
        thread::sleep(Duration::from_millis(60));
        assert_eq!(s.check(), Some(Trigger::Idle));
    }

    #[test]
    fn idle_resets_on_chunk() {
        let set = WaitSet::new().idle(Duration::from_millis(40));
        let mut s = set.state();
        thread::sleep(Duration::from_millis(50));
        // No chunks yet — Idle is measured from construction, so this
        // does satisfy the condition on its own.
        assert_eq!(s.check(), Some(Trigger::Idle));

        s.feed("noise");
        // Idle timer reset on chunk.
        assert!(s.check().is_none());
        thread::sleep(Duration::from_millis(50));
        assert_eq!(s.check(), Some(Trigger::Idle));
    }

    #[test]
    fn change_flips_on_first_chunk() {
        let set = WaitSet::new().change();
        let mut s = set.state();
        assert!(s.check().is_none());
        s.feed("anything");
        assert_eq!(s.check(), Some(Trigger::Change));
    }

    #[test]
    fn exit_only_satisfied_after_mark() {
        let set = WaitSet::new().exit();
        let mut s = set.state();
        assert!(s.check().is_none());
        s.mark_exited();
        assert_eq!(s.check(), Some(Trigger::Exit));
    }

    #[test]
    fn cursor_matches_snapshot_position() {
        let set = WaitSet::new().cursor(1, 1);
        let mut s = set.state();
        assert!(s.check().is_none(), "no cursor snapshot yet");

        s.set_cursor_position(2, 1);
        assert!(s.check().is_none(), "wrong cursor row");

        s.set_cursor_position(1, 1);
        assert_eq!(s.check(), Some(Trigger::Cursor));

        s.clear_cursor_position();
        assert!(s.check().is_none(), "cursor was cleared");
    }

    #[test]
    fn and_composition_requires_all() {
        let set = WaitSet::new()
            .text("Welcome back")
            .idle(Duration::from_millis(30));
        let mut s = set.state();

        s.feed("Welcome back Will\n");
        // Idle just reset by feed.
        assert!(s.check().is_none(), "text matched but idle not elapsed");

        thread::sleep(Duration::from_millis(50));
        assert_eq!(
            s.check(),
            Some(Trigger::Text),
            "both satisfied; Text wins by priority"
        );
    }

    #[test]
    fn empty_set_never_ready() {
        let set = WaitSet::new();
        let s = set.state();
        assert!(s.check().is_none());
    }

    #[test]
    fn trigger_priority_exit_beats_text() {
        let set = WaitSet::new().text("hi").exit();
        let mut s = set.state();
        s.feed("hi");
        s.mark_exited();
        assert_eq!(s.check(), Some(Trigger::Exit));
    }

    #[test]
    fn feed_raw_strips_ansi() {
        let set = WaitSet::new().text("ready");
        let mut s = set.state();
        s.feed_raw("\x1b[32mready\x1b[0m\n");
        assert_eq!(s.check(), Some(Trigger::Text));
    }

    #[test]
    fn for_cli_claude_matches_welcome_plus_prompt() {
        let set = for_cli::claude();
        let mut s = set.state();
        s.feed("Welcome back Khaliq!\n❯\n");
        assert_eq!(s.check(), Some(Trigger::Text));
    }

    #[test]
    fn for_cli_claude_rejects_onboarding_menu() {
        // Theme picker draws `❯ 1. Dark mode` — not a bare prompt line.
        let set = for_cli::claude();
        let mut s = set.state();
        s.feed("Welcome to Claude\n❯ 1. Dark mode\n  2. Light mode\n");
        assert!(s.check().is_none());
    }

    #[test]
    fn for_cli_gemini_matches_compose_prompt() {
        let set = for_cli::gemini();
        let mut s = set.state();
        s.feed("banner...\nType your message or @path/to/file\n");
        assert_eq!(s.check(), Some(Trigger::Text));
    }

    #[test]
    fn for_cli_detect_dispatches_by_name() {
        assert_eq!(for_cli::detect("claude").len(), for_cli::claude().len());
        assert_eq!(for_cli::detect("gemini").len(), for_cli::gemini().len());
        assert_eq!(for_cli::detect("codex").len(), for_cli::codex().len());
        assert_eq!(
            for_cli::detect("/usr/bin/aider").len(),
            for_cli::generic().len()
        );
    }

    #[test]
    fn for_cli_with_settle_chains_idle() {
        let set = for_cli::with_settle(for_cli::generic());
        // Settle adds exactly one Idle condition.
        assert_eq!(set.len(), for_cli::generic().len() + 1);
        assert!(matches!(
            set.conditions().last(),
            Some(WaitCondition::Idle(_))
        ));
    }

    #[test]
    fn snapshot_evaluator_matches_streaming() {
        let set = WaitSet::new().text("ok").change();
        let satisfied = set.evaluate(&WaitSnapshot {
            screen: "all ok",
            idle_for: Duration::ZERO,
            change_seen: true,
            exited: false,
            cursor: None,
        });
        assert_eq!(satisfied, Some(Trigger::Text));

        let not_yet = set.evaluate(&WaitSnapshot {
            screen: "all ok",
            idle_for: Duration::ZERO,
            change_seen: false,
            exited: false,
            cursor: None,
        });
        assert_eq!(not_yet, None);
    }

    #[test]
    fn snapshot_cursor_position_satisfies_cursor_condition() {
        let set = WaitSet::new().text("ready").cursor(3, 5);
        let snapshot = WaitSnapshot::text_only("ready").with_cursor(3, 5);

        assert_eq!(set.evaluate(&snapshot), Some(Trigger::Text));
    }

    #[test]
    fn text_only_snapshot_does_not_satisfy_cursor() {
        let set = WaitSet::new().cursor(3, 5);

        assert_eq!(set.evaluate(&WaitSnapshot::text_only("")), None);
    }
}
