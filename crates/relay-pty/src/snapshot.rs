//! Visible-screen snapshot of a `PtySession`'s alacritty VT grid.
//!
//! Two renderers are exposed:
//!
//! * `to_plain` — one row per line, trailing blanks trimmed. Same shape as
//!   `PtySession::screen_text`, but bundled with cursor + dimensions so the
//!   caller can present it without re-querying the live PTY.
//! * `to_ansi` — bytes that reproduce the visible grid when written to a
//!   fresh terminal. Emits cursor-home + clear, then per-cell SGR + char,
//!   then a cursor-position command for the captured cursor location.
//!
//! Both are consumed by:
//!
//! * `GET /api/spawned/{name}/snapshot` — programmatic callers (dashboard,
//!   integration tests, and the `view` / `drive` attach clients).
//! * `agent-relay-broker dump-pty <name>` — interactive debugging.
//!
//! The snapshot is **self-contained**: `capture` walks the grid once, copies
//! out the cells it needs, then drops the term lock. Renderers run against
//! the captured data, so they neither block the PTY reader thread nor race
//! with subsequent grid mutations.

use alacritty_terminal::event::EventListener;
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::{Column, Line, Point};
use alacritty_terminal::term::cell::{Cell, Flags};
use alacritty_terminal::term::{Term, TermMode};
use alacritty_terminal::vte::ansi::{Color, NamedColor, Rgb};

use crate::pty::PtySession;

/// A captured copy of a single grid cell — just what the renderers need.
/// Hyperlinks, undercurl colour, zerowidth characters are intentionally not
/// captured: the v1 renderer only emits the SGR subset we round-trip in tests.
#[derive(Clone, Debug, PartialEq, Eq)]
struct SnapshotCell {
    c: char,
    fg: Color,
    bg: Color,
    flags: Flags,
}

impl Default for SnapshotCell {
    fn default() -> Self {
        Self {
            c: ' ',
            fg: Color::Named(NamedColor::Foreground),
            bg: Color::Named(NamedColor::Background),
            flags: Flags::empty(),
        }
    }
}

impl SnapshotCell {
    fn from_cell(cell: &Cell) -> Self {
        Self {
            c: cell.c,
            fg: cell.fg,
            bg: cell.bg,
            flags: cell.flags,
        }
    }
}

/// Captured visible screen plus dimensions and cursor.
///
/// `cursor` is **1-indexed `(row, col)`**, matching `PtySession::cursor_position`
/// and the rest of the public API.
#[derive(Clone, Debug)]
pub struct Snapshot {
    pub rows: u16,
    pub cols: u16,
    pub cursor: (u16, u16),
    cells: Vec<Vec<SnapshotCell>>,
    /// Terminal mode flags captured at the same locked point as the grid.
    /// `to_ansi` re-emits the relevant ones so an attaching client's terminal
    /// matches the source (alt-screen, cursor visibility, application cursor
    /// keys, bracketed paste, mouse reporting, autowrap, keypad). `to_plain`
    /// ignores them. Cheap `Copy` bitflags — captured by value under the lock.
    modes: TermMode,
}

impl Snapshot {
    /// Capture the visible screen of a live `PtySession`. Holds the term
    /// lock only long enough to clone the cells out — does not block the
    /// reader thread while renderers run.
    pub fn capture(pty: &PtySession) -> Self {
        pty.with_term(Self::from_term)
    }

    /// Capture the visible screen together with the grid's consumed byte
    /// offset, read atomically under the same term lock. The returned
    /// offset is the position in the `worker_stream` byte stream that this
    /// snapshot reflects: a client can drop every buffered `worker_stream`
    /// chunk whose end offset is `<= offset` and apply only what came after.
    pub fn capture_with_offset(pty: &PtySession) -> (Self, u64) {
        pty.with_term_and_offset(|term, offset| (Self::from_term(term), offset))
    }

    /// Capture from a free-standing `Term` (used by tests and by the future
    /// `view`/`drive` clients that drive their own VT instances).
    ///
    /// Generic over `EventListener` so this accepts both the live
    /// `Term<RelayEventListener>` from `PtySession` and the
    /// `Term<VoidListener>` used in offline tests.
    pub fn from_term<L: EventListener>(term: &Term<L>) -> Self {
        let grid = term.grid();
        let rows = grid.screen_lines() as u16;
        let cols = grid.columns() as u16;
        let cursor_point: Point = grid.cursor.point;
        // Clamp negative scrollback offsets to 0 — we only render the
        // visible viewport.
        let cursor_row = (cursor_point.line.0.max(0) as u16).saturating_add(1);
        let cursor_col = (cursor_point.column.0 as u16).saturating_add(1);

        let mut cells = Vec::with_capacity(rows as usize);
        for row_index in 0..(rows as usize) {
            let line = Line(row_index as i32);
            let mut row = Vec::with_capacity(cols as usize);
            for col_index in 0..(cols as usize) {
                row.push(SnapshotCell::from_cell(&grid[line][Column(col_index)]));
            }
            cells.push(row);
        }

        Self {
            rows,
            cols,
            cursor: (cursor_row, cursor_col),
            cells,
            // Copy the mode flags out under the same lock as the cells so the
            // captured modes match the captured grid exactly.
            modes: *term.mode(),
        }
    }

    /// Plain text — one row per line, trailing blanks trimmed per row.
    /// Matches `PtySession::screen_text`'s shape so existing call sites that
    /// substring-match on the rendered screen stay drop-in compatible.
    pub fn to_plain(&self) -> String {
        let mut out =
            String::with_capacity((self.rows as usize) * ((self.cols as usize).saturating_add(1)));
        for row in &self.cells {
            for cell in row {
                out.push(cell.c);
            }
            while out.ends_with(' ') {
                out.pop();
            }
            out.push('\n');
        }
        out
    }

    /// ANSI bytes that redraw the captured grid on a fresh terminal.
    ///
    /// Layout:
    ///   1. Alt-screen select (before painting — see below).
    ///   2. SGR reset + scroll-region reset + cursor-home + erase display.
    ///   3. Per-row cells left-to-right with per-cell SGR (fg / bg / bold /
    ///      reverse / underline).
    ///   4. Terminal-mode re-emission (cursor visibility, application cursor
    ///      keys, origin, autowrap, mouse reporting, bracketed paste, keypad),
    ///      each in both directions.
    ///   5. A CUP to place the real cursor at the captured `(row, col)`.
    ///
    /// SGR diffing is intentional: we only emit a new SGR sequence when a
    /// cell's attributes differ from the previous cell. This keeps the
    /// output reasonably compact without sacrificing correctness, and it
    /// guarantees a `\x1b[0m` reset before any transition back to default.
    ///
    /// Mode re-emission is unconditional and bidirectional: the snapshot is
    /// painted onto an *unknown* client terminal state, so we emit the explicit
    /// OFF form for modes that are disabled as well as the ON form for enabled
    /// ones. That heals a terminal a previous (possibly crashed) session left
    /// in the wrong mode — e.g. mouse reporting or bracketed paste stuck on.
    pub fn to_ansi(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(
            // Alt-screen + resets + (per-cell SGR worst case) + mode block + CUP.
            16 + (self.rows as usize) * (self.cols as usize) * 6 + 160,
        );

        // Alt-screen must be selected BEFORE painting: entering or leaving the
        // alternate buffer clears/replaces it, which would wipe cells painted
        // first. The captured grid *is* the source's visible screen, so when
        // the source is in its alternate buffer we put the client there too —
        // the attacher paints onto the alt buffer and, on detach (`?1049l`),
        // the client's main-screen scrollback is restored intact. When the
        // source is on the main screen we emit the leave form to heal a client
        // left in a prior crashed session's alt buffer. We use 1049 (not bare
        // 47) because it also saves/restores the cursor and clears the alt
        // buffer, giving clean enter/leave semantics. The source's pre-alt
        // main-screen contents are not part of the visible snapshot, so we do
        // not attempt to reconstruct them.
        if self.modes.contains(TermMode::ALT_SCREEN) {
            out.extend_from_slice(b"\x1b[?1049h");
        } else {
            out.extend_from_slice(b"\x1b[?1049l");
        }

        // Reset SGR, then reset the scroll region to full screen, then home +
        // erase display so the previous screen doesn't bleed through (e.g. for
        // terminals that don't repaint every cell). DECSTBM (`\x1b[r`) homes
        // the cursor, so it must precede the final CUP; resetting it here also
        // heals a stale scroll region from a crashed session and guarantees
        // painting happens against a full-screen coordinate system. The
        // emulator's public API does not expose the source's actual scroll
        // region, so we conservatively reset to full and let the live stream
        // re-establish any region the app needs.
        out.extend_from_slice(b"\x1b[0m\x1b[r\x1b[H\x1b[2J");

        let mut current = SgrState::default();

        for (row_idx, row) in self.cells.iter().enumerate() {
            // Position the cursor at column 1 of this row before drawing.
            // 1-indexed CUP — alacritty's parser accepts it. We do this even
            // for row 0 because the leading `\x1b[2J` does not move the
            // cursor on every terminal implementation.
            write_cup(&mut out, (row_idx as u16).saturating_add(1), 1);

            for cell in row {
                // Wide-character spacers (the second cell of a CJK / emoji
                // glyph) carry a placeholder space alongside the
                // `WIDE_CHAR_SPACER` flag. Alacritty itself skips them
                // when emitting a line (see `Term::line_content` for the
                // reference implementation). Emitting that space as a real
                // character on replay would push every cell after the wide
                // glyph one column to the right, so we have to drop it.
                if cell.flags.contains(Flags::WIDE_CHAR_SPACER) {
                    continue;
                }
                let want = SgrState::from_cell(cell);
                if want != current {
                    write_sgr_transition(&mut out, &current, &want);
                    current = want;
                }
                // The cell character. We deliberately do not expand control
                // characters — alacritty stores them as the printed glyph
                // (often `' '`), and the parser never advances the cursor
                // for a control char that survives to the grid.
                let mut buf = [0u8; 4];
                let encoded = cell.c.encode_utf8(&mut buf);
                out.extend_from_slice(encoded.as_bytes());
            }
        }

        // Reset attributes so the rendered screen ends in a clean SGR state.
        if current != SgrState::default() {
            out.extend_from_slice(b"\x1b[0m");
        }

        // Re-emit terminal modes so the client matches the source. Alt-screen
        // is already handled at the top (it must precede painting); everything
        // below is position-independent and safe to emit after the cells but
        // before the final CUP. Each mode is emitted in both directions.
        self.write_modes(&mut out);

        // Place the cursor at the captured position last (after DECSTBM reset
        // and mode changes, both of which can move the cursor).
        let (cursor_row, cursor_col) = self.cursor;
        write_cup(&mut out, cursor_row.max(1), cursor_col.max(1));

        out
    }

    /// Append the DEC private mode set/reset sequences (plus keypad) for the
    /// modes this renderer round-trips. Alt-screen is intentionally excluded —
    /// it is emitted at the top of `to_ansi`, before painting.
    fn write_modes(&self, out: &mut Vec<u8>) {
        // Cursor visibility (DECTCEM). A TUI that hid its cursor must not leave
        // attachers with a stray visible cursor, and vice versa.
        write_dec_mode(out, 25, self.modes.contains(TermMode::SHOW_CURSOR));
        // Application cursor keys (DECCKM) — arrows send SS3 vs CSI; a mismatch
        // makes arrow keys misbehave in the driven app.
        write_dec_mode(out, 1, self.modes.contains(TermMode::APP_CURSOR));
        // Origin mode (DECOM). Emitted after the scroll-region reset so its
        // effect on the final CUP is well-defined.
        write_dec_mode(out, 6, self.modes.contains(TermMode::ORIGIN));
        // Autowrap (DECAWM).
        write_dec_mode(out, 7, self.modes.contains(TermMode::LINE_WRAP));
        // Mouse reporting: X10/normal click, button-event (drag), any-event
        // (motion), focus in/out, UTF-8 and SGR extended coordinate encodings,
        // and alternate scroll. Emitting the OFF form heals a terminal left
        // with mouse reporting stuck on by a crashed session.
        write_dec_mode(out, 1000, self.modes.contains(TermMode::MOUSE_REPORT_CLICK));
        write_dec_mode(out, 1002, self.modes.contains(TermMode::MOUSE_DRAG));
        write_dec_mode(out, 1003, self.modes.contains(TermMode::MOUSE_MOTION));
        write_dec_mode(out, 1004, self.modes.contains(TermMode::FOCUS_IN_OUT));
        write_dec_mode(out, 1005, self.modes.contains(TermMode::UTF8_MOUSE));
        write_dec_mode(out, 1006, self.modes.contains(TermMode::SGR_MOUSE));
        write_dec_mode(out, 1007, self.modes.contains(TermMode::ALTERNATE_SCROLL));
        // Bracketed paste (`?2004`) — paste-aware apps mishandle pastes when
        // this doesn't match the source.
        write_dec_mode(out, 2004, self.modes.contains(TermMode::BRACKETED_PASTE));
        // Keypad application mode is not a DEC private mode: ESC = enables
        // (DECKPAM), ESC > restores the numeric keypad (DECKPNM).
        if self.modes.contains(TermMode::APP_KEYPAD) {
            out.extend_from_slice(b"\x1b=");
        } else {
            out.extend_from_slice(b"\x1b>");
        }
    }
}

// ---------------------------------------------------------------------------
// SGR encoding helpers
// ---------------------------------------------------------------------------

/// Subset of cell attributes we round-trip. Anything not represented here
/// (italic, strikeout, dim, hyperlinks, undercurl colour, ...) is dropped
/// in v1 — see the module-level docs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct SgrState {
    fg: Color,
    bg: Color,
    bold: bool,
    reverse: bool,
    underline: bool,
}

impl Default for SgrState {
    fn default() -> Self {
        Self {
            fg: Color::Named(NamedColor::Foreground),
            bg: Color::Named(NamedColor::Background),
            bold: false,
            reverse: false,
            underline: false,
        }
    }
}

impl SgrState {
    fn from_cell(cell: &SnapshotCell) -> Self {
        Self {
            fg: cell.fg,
            bg: cell.bg,
            bold: cell.flags.contains(Flags::BOLD)
                || cell.flags.contains(Flags::BOLD_ITALIC)
                || cell.flags.contains(Flags::DIM_BOLD),
            reverse: cell.flags.contains(Flags::INVERSE),
            // Treat any of the underline variants as a plain SGR 4 underline.
            // The fancier styles (double / undercurl / dotted / dashed) need
            // SGR 4:n or SGR 21 and aren't worth the extra surface for v1.
            underline: cell.flags.intersects(Flags::ALL_UNDERLINES),
        }
    }
}

/// Append the SGR escape that transitions from `from` to `to`.
///
/// We emit a full reset + the new state. That's a few extra bytes per
/// transition but it's bulletproof: there's no class of stale attribute
/// (e.g. a previously-set background) that can leak through because we
/// forgot to clear it explicitly. Compactness can be improved later.
fn write_sgr_transition(out: &mut Vec<u8>, _from: &SgrState, to: &SgrState) {
    // Always emit reset first so transitions are unambiguous. The fast path
    // of "no attributes" still becomes `\x1b[0m` which is correct.
    if to == &SgrState::default() {
        out.extend_from_slice(b"\x1b[0m");
        return;
    }

    out.extend_from_slice(b"\x1b[0");

    if to.bold {
        out.extend_from_slice(b";1");
    }
    if to.underline {
        out.extend_from_slice(b";4");
    }
    if to.reverse {
        out.extend_from_slice(b";7");
    }
    write_color(out, to.fg, ColorRole::Foreground);
    write_color(out, to.bg, ColorRole::Background);

    out.push(b'm');
}

enum ColorRole {
    Foreground,
    Background,
}

fn write_color(out: &mut Vec<u8>, color: Color, role: ColorRole) {
    match color {
        Color::Named(named) => {
            if let Some(code) = named_color_sgr(named, &role) {
                out.push(b';');
                out.extend_from_slice(code.to_string().as_bytes());
            }
            // Unmapped named colours (e.g. Cursor) fall back to default —
            // the leading reset already cleared the prior value.
        }
        Color::Indexed(index) => {
            // SGR 38;5;<n> / 48;5;<n> — 256-colour palette.
            let prefix: &[u8] = match role {
                ColorRole::Foreground => b";38;5;",
                ColorRole::Background => b";48;5;",
            };
            out.extend_from_slice(prefix);
            out.extend_from_slice(index.to_string().as_bytes());
        }
        Color::Spec(Rgb { r, g, b }) => {
            // SGR 38;2;<r>;<g>;<b> — truecolor.
            let prefix: &[u8] = match role {
                ColorRole::Foreground => b";38;2;",
                ColorRole::Background => b";48;2;",
            };
            out.extend_from_slice(prefix);
            out.extend_from_slice(r.to_string().as_bytes());
            out.push(b';');
            out.extend_from_slice(g.to_string().as_bytes());
            out.push(b';');
            out.extend_from_slice(b.to_string().as_bytes());
        }
    }
}

/// Map an alacritty `NamedColor` to its SGR code, or `None` to fall back to
/// the terminal's default (the leading `\x1b[0` reset in the SGR transition
/// has already cleared the prior value, so emitting nothing is equivalent
/// to emitting `;39` / `;49` but avoids the wasted bytes).
fn named_color_sgr(named: NamedColor, role: &ColorRole) -> Option<u16> {
    // SGR foreground bases: 30..37 (normal), 90..97 (bright).
    // SGR background bases: 40..47 (normal), 100..107 (bright).
    let (normal_base, bright_base) = match role {
        ColorRole::Foreground => (30u16, 90u16),
        ColorRole::Background => (40u16, 100u16),
    };

    Some(match named {
        NamedColor::Black => normal_base,
        NamedColor::Red => normal_base + 1,
        NamedColor::Green => normal_base + 2,
        NamedColor::Yellow => normal_base + 3,
        NamedColor::Blue => normal_base + 4,
        NamedColor::Magenta => normal_base + 5,
        NamedColor::Cyan => normal_base + 6,
        NamedColor::White => normal_base + 7,
        NamedColor::BrightBlack => bright_base,
        NamedColor::BrightRed => bright_base + 1,
        NamedColor::BrightGreen => bright_base + 2,
        NamedColor::BrightYellow => bright_base + 3,
        NamedColor::BrightBlue => bright_base + 4,
        NamedColor::BrightMagenta => bright_base + 5,
        NamedColor::BrightCyan => bright_base + 6,
        NamedColor::BrightWhite => bright_base + 7,
        // Dim variants map back to the base colour — we don't emit SGR 2
        // (dim) here because alacritty already folds DIM into a separate
        // flag and we don't carry that through v1.
        NamedColor::DimBlack => normal_base,
        NamedColor::DimRed => normal_base + 1,
        NamedColor::DimGreen => normal_base + 2,
        NamedColor::DimYellow => normal_base + 3,
        NamedColor::DimBlue => normal_base + 4,
        NamedColor::DimMagenta => normal_base + 5,
        NamedColor::DimCyan => normal_base + 6,
        NamedColor::DimWhite => normal_base + 7,
        // Semantic defaults — Foreground / Background / Cursor and the
        // bright/dim foreground synonyms — have no concrete SGR colour we
        // want to pin to. Skip emission so the leading reset stands.
        NamedColor::Foreground
        | NamedColor::Background
        | NamedColor::Cursor
        | NamedColor::BrightForeground
        | NamedColor::DimForeground => return None,
    })
}

/// Append a DEC private mode set (`ESC[?<n>h`) or reset (`ESC[?<n>l`).
fn write_dec_mode(out: &mut Vec<u8>, code: u16, enabled: bool) {
    out.extend_from_slice(b"\x1b[?");
    out.extend_from_slice(code.to_string().as_bytes());
    out.push(if enabled { b'h' } else { b'l' });
}

/// Append an `ESC[<row>;<col>H` cursor-position command (1-indexed).
fn write_cup(out: &mut Vec<u8>, row: u16, col: u16) {
    out.extend_from_slice(b"\x1b[");
    out.extend_from_slice(row.to_string().as_bytes());
    out.push(b';');
    out.extend_from_slice(col.to_string().as_bytes());
    out.push(b'H');
}

#[cfg(test)]
mod tests {
    use super::*;
    use alacritty_terminal::event::VoidListener;
    use alacritty_terminal::grid::Dimensions;
    use alacritty_terminal::term::{Config, Term};
    use alacritty_terminal::vte::ansi::Processor;

    /// Re-implementation of `PtySession::tests::parse_into` so the snapshot
    /// tests don't depend on a child process.
    fn parse_into(rows: u16, cols: u16, chunks: &[&[u8]]) -> Term<VoidListener> {
        #[derive(Clone, Copy)]
        struct Size {
            cols: usize,
            rows: usize,
        }
        impl Dimensions for Size {
            fn total_lines(&self) -> usize {
                self.rows
            }
            fn screen_lines(&self) -> usize {
                self.rows
            }
            fn columns(&self) -> usize {
                self.cols
            }
        }
        let size = Size {
            cols: cols as usize,
            rows: rows as usize,
        };
        let mut term = Term::new(Config::default(), &size, VoidListener);
        let mut processor: Processor = Processor::new();
        for chunk in chunks {
            processor.advance(&mut term, chunk);
        }
        term
    }

    #[test]
    fn plain_render_matches_screen_text_shape() {
        let term = parse_into(4, 20, &[b"hello world"]);
        let snap = Snapshot::from_term(&term);
        let plain = snap.to_plain();
        assert!(
            plain.starts_with("hello world\n"),
            "expected hello world on row 0, got {plain:?}"
        );
        // Trailing blank rows still emit a newline.
        let row_count = plain.matches('\n').count();
        assert_eq!(row_count, snap.rows as usize);
    }

    #[test]
    fn cursor_position_is_one_indexed_and_matches_grid() {
        // CUP `ESC[3;5H` then "hello": cursor lands at row 3 col 5+5=10.
        let term = parse_into(10, 40, &[b"\x1b[3;5Hhello"]);
        let snap = Snapshot::from_term(&term);
        assert_eq!(snap.cursor, (3, 10));
        // Plain should show "hello" starting at row 3, col 5.
        let plain = snap.to_plain();
        let lines: Vec<&str> = plain.split('\n').collect();
        assert_eq!(lines[2], "    hello", "row 3 should be {:?}", lines[2]);
    }

    #[test]
    fn ansi_emits_clear_and_home_prefix() {
        let term = parse_into(2, 5, &[b"hi"]);
        let snap = Snapshot::from_term(&term);
        let bytes = snap.to_ansi();
        // A non-alt-screen source leaves the alt buffer first (healing a client
        // stuck in a prior session's alt screen), then resets SGR + scroll
        // region and clears/homes.
        assert!(
            bytes.starts_with(b"\x1b[?1049l\x1b[0m\x1b[r\x1b[H\x1b[2J"),
            "got prefix {:?}",
            &bytes[..24.min(bytes.len())]
        );
    }

    /// Locate the byte offset of the first occurrence of `needle` in `hay`.
    fn find_seq(hay: &[u8], needle: &[u8]) -> Option<usize> {
        hay.windows(needle.len()).position(|w| w == needle)
    }

    #[test]
    fn ansi_reemits_hidden_cursor_mode() {
        // A TUI that hid its cursor (`?25l`) must be re-emitted so attachers
        // don't see a stray visible cursor.
        let term = parse_into(4, 20, &[b"\x1b[?25lhi"]);
        let snap = Snapshot::from_term(&term);
        let bytes = snap.to_ansi();
        assert!(
            find_seq(&bytes, b"\x1b[?25l").is_some(),
            "expected ?25l in {:?}",
            String::from_utf8_lossy(&bytes)
        );
    }

    #[test]
    fn ansi_reemits_enabled_modes_in_on_form() {
        // Enable application cursor keys, bracketed paste, SGR mouse click
        // reporting, and disable autowrap.
        let term = parse_into(
            4,
            20,
            &[b"\x1b[?1h\x1b[?2004h\x1b[?1000h\x1b[?1006h\x1b[?7l"],
        );
        let snap = Snapshot::from_term(&term);
        let bytes = snap.to_ansi();
        for needle in [
            &b"\x1b[?1h"[..],    // application cursor keys on
            &b"\x1b[?2004h"[..], // bracketed paste on
            &b"\x1b[?1000h"[..], // mouse click reporting on
            &b"\x1b[?1006h"[..], // SGR mouse on
            &b"\x1b[?7l"[..],    // autowrap off
        ] {
            assert!(
                find_seq(&bytes, needle).is_some(),
                "expected {:?} in {:?}",
                String::from_utf8_lossy(needle),
                String::from_utf8_lossy(&bytes)
            );
        }
    }

    #[test]
    fn ansi_reemits_disabled_modes_in_explicit_off_form() {
        // A default (freshly-parsed) grid has cursor visible, autowrap on, and
        // everything else off. The renderer must emit the explicit OFF form for
        // the disabled modes so an attach after a crashed session heals a
        // terminal left with mouse reporting / bracketed paste / app-cursor
        // keys stuck on.
        let term = parse_into(4, 20, &[b"idle"]);
        let snap = Snapshot::from_term(&term);
        let bytes = snap.to_ansi();
        for needle in [
            &b"\x1b[?25h"[..],   // cursor visible (default on)
            &b"\x1b[?1l"[..],    // application cursor keys off
            &b"\x1b[?2004l"[..], // bracketed paste off
            &b"\x1b[?1000l"[..], // mouse click reporting off
            &b"\x1b[?1002l"[..], // mouse drag off
            &b"\x1b[?1003l"[..], // mouse motion off
            &b"\x1b[?1006l"[..], // SGR mouse off
            &b"\x1b[?7h"[..],    // autowrap on (default)
            &b"\x1b>"[..],       // keypad normal
        ] {
            assert!(
                find_seq(&bytes, needle).is_some(),
                "expected {:?} in {:?}",
                String::from_utf8_lossy(needle),
                String::from_utf8_lossy(&bytes)
            );
        }
    }

    #[test]
    fn ansi_emits_alt_screen_enter_before_clear_for_alt_source() {
        // Switch the source into the alternate buffer, then draw. The client
        // must enter the alt buffer BEFORE the erase-display, or entering it
        // afterward would wipe the painted cells.
        let term = parse_into(4, 20, &[b"\x1b[?1049hTUI"]);
        let snap = Snapshot::from_term(&term);
        let bytes = snap.to_ansi();
        let enter = find_seq(&bytes, b"\x1b[?1049h").expect("alt-screen enter present");
        let clear = find_seq(&bytes, b"\x1b[2J").expect("erase-display present");
        assert!(
            enter < clear,
            "alt-screen enter ({enter}) must precede clear ({clear})"
        );
    }

    #[test]
    fn ansi_resets_scroll_region_before_final_cursor() {
        // DECSTBM (`\x1b[r`) homes the cursor, so it must come before the final
        // CUP that places the captured cursor.
        let term = parse_into(6, 20, &[b"\x1b[3;5Hx"]);
        let snap = Snapshot::from_term(&term);
        let bytes = snap.to_ansi();
        let stbm = find_seq(&bytes, b"\x1b[r").expect("scroll-region reset present");
        // Final CUP for the captured cursor (row 3, col 6 after the 'x').
        let cup = find_seq(&bytes, b"\x1b[3;6H").expect("final CUP present");
        assert!(
            stbm < cup,
            "scroll-region reset ({stbm}) must precede final CUP ({cup})"
        );
    }

    #[test]
    fn ansi_round_trips_terminal_modes_through_a_fresh_term() {
        // Modes captured on the source must survive a replay into a fresh Term.
        let term_a = parse_into(
            4,
            20,
            &[b"\x1b[?1049h\x1b[?25l\x1b[?1h\x1b[?2004h\x1b[?1006h\x1b[?1000h"],
        );
        let snap_a = Snapshot::from_term(&term_a);
        let ansi = snap_a.to_ansi();
        let term_b = parse_into(4, 20, &[&ansi]);
        let mode_b = *term_b.mode();
        for flag in [
            TermMode::ALT_SCREEN,
            TermMode::APP_CURSOR,
            TermMode::BRACKETED_PASTE,
            TermMode::SGR_MOUSE,
            TermMode::MOUSE_REPORT_CLICK,
        ] {
            assert!(mode_b.contains(flag), "replayed term missing {flag:?}");
        }
        assert!(
            !mode_b.contains(TermMode::SHOW_CURSOR),
            "cursor should be hidden after replay"
        );
    }

    #[test]
    fn plain_render_ignores_terminal_modes() {
        // `to_plain` is text-only: mode sequences must never leak into it.
        let term = parse_into(2, 10, &[b"\x1b[?25l\x1b[?2004hhi"]);
        let snap = Snapshot::from_term(&term);
        let plain = snap.to_plain();
        assert!(plain.starts_with("hi\n"), "got {plain:?}");
        assert!(
            !plain.contains('\x1b'),
            "plain must not contain escapes: {plain:?}"
        );
    }

    #[test]
    fn ansi_emits_green_sgr_for_green_text() {
        // Same shape as parser_strips_csi_color_sequences_from_visible_text
        // in crates/broker/src/pty.rs — green wrapper around "OK".
        let term = parse_into(4, 20, &[b"\x1b[32mOK\x1b[0m"]);
        let snap = Snapshot::from_term(&term);
        let bytes = snap.to_ansi();
        // We can't easily anchor on byte offset because we emit a leading
        // CUP for row 1, so just assert the green-foreground SGR appears
        // at least once. Default-background (`;49`) may follow when the
        // cell carries an explicit background — that's fine.
        let rendered = String::from_utf8_lossy(&bytes).into_owned();
        assert!(
            rendered.contains("\x1b[0;32m") || rendered.contains("\x1b[0;32;"),
            "expected green-foreground SGR (ESC[0;32...) in output: {rendered:?}"
        );
    }

    #[test]
    fn ansi_round_trips_through_a_fresh_term() {
        // Build a grid with mixed text + cursor placement + colour.
        let term_a = parse_into(
            6,
            30,
            &[
                b"\x1b[2J\x1b[H",
                b"line one\r\n",
                b"\x1b[31mred line two\x1b[0m\r\n",
                b"\x1b[5;3H", // CUP to row 5 col 3
                b"tail",
            ],
        );
        let snap_a = Snapshot::from_term(&term_a);
        let ansi = snap_a.to_ansi();

        // Replay the bytes into a fresh Term of the same dimensions.
        let term_b = parse_into(6, 30, &[&ansi]);
        let snap_b = Snapshot::from_term(&term_b);

        // Same dimensions, same plain text, same cursor.
        assert_eq!(snap_a.rows, snap_b.rows);
        assert_eq!(snap_a.cols, snap_b.cols);
        assert_eq!(
            snap_a.to_plain(),
            snap_b.to_plain(),
            "plain text round-trip mismatch"
        );
        assert_eq!(snap_a.cursor, snap_b.cursor, "cursor round-trip mismatch");
    }

    #[test]
    fn empty_grid_renders_blank_rows() {
        let term = parse_into(3, 5, &[]);
        let snap = Snapshot::from_term(&term);
        assert_eq!(snap.to_plain(), "\n\n\n");
        // ANSI render should still be parseable into an identical empty grid.
        let term2 = parse_into(3, 5, &[&snap.to_ansi()]);
        let snap2 = Snapshot::from_term(&term2);
        assert_eq!(snap2.to_plain(), "\n\n\n");
        assert_eq!(snap2.cursor, snap.cursor);
    }

    #[test]
    fn sgr_state_default_means_no_emission_path() {
        // Sanity check the default-state fast path used inside the renderer:
        // a cell with all defaults should round-trip to default SgrState.
        let cell = SnapshotCell::default();
        assert_eq!(SgrState::from_cell(&cell), SgrState::default());
    }

    #[test]
    fn ansi_skips_wide_char_spacer_so_layout_round_trips() {
        // A double-width CJK glyph followed by ASCII. Without skipping the
        // WIDE_CHAR_SPACER cell, the replayed grid is pushed one column to
        // the right.
        let term_a = parse_into(2, 10, &[b"\xe6\x96\x87X"]); // "文X"
        let snap_a = Snapshot::from_term(&term_a);
        let ansi = snap_a.to_ansi();

        let term_b = parse_into(2, 10, &[&ansi]);
        let snap_b = Snapshot::from_term(&term_b);

        assert_eq!(
            snap_a.to_plain(),
            snap_b.to_plain(),
            "wide char + ASCII round-trip mismatch (spacer cell was emitted as a real space?)"
        );
    }

    #[test]
    fn named_color_sgr_returns_none_for_semantic_defaults() {
        // Defaults must skip emission so the leading `\x1b[0` reset stands —
        // otherwise we'd waste bytes on redundant `;39` / `;49`.
        assert_eq!(
            named_color_sgr(NamedColor::Foreground, &ColorRole::Foreground),
            None
        );
        assert_eq!(
            named_color_sgr(NamedColor::Background, &ColorRole::Background),
            None
        );
        assert_eq!(
            named_color_sgr(NamedColor::Cursor, &ColorRole::Foreground),
            None
        );
        // Concrete colours still resolve.
        assert_eq!(
            named_color_sgr(NamedColor::Green, &ColorRole::Foreground),
            Some(32)
        );
        assert_eq!(
            named_color_sgr(NamedColor::Red, &ColorRole::Background),
            Some(41)
        );
    }

    #[tokio::test]
    async fn capture_from_live_pty_session_reflects_echoed_text() {
        use crate::pty::PtySession;
        use tokio::time::{timeout, Duration};

        let (pty, mut rx) =
            PtySession::spawn("echo", &["snap-line".into()], 24, 80).expect("spawn echo");
        // Drain the channel until we've seen the echoed text on the grid.
        let mut collected = Vec::new();
        while let Ok(Some(chunk)) = timeout(Duration::from_secs(2), rx.recv()).await {
            collected.extend_from_slice(&chunk);
            if String::from_utf8_lossy(&collected).contains("snap-line") {
                break;
            }
        }
        // Give the reader thread a tick to advance the parser.
        tokio::time::sleep(Duration::from_millis(50)).await;
        let snap = Snapshot::capture(&pty);
        assert_eq!(snap.rows, 24);
        assert_eq!(snap.cols, 80);
        assert!(
            snap.to_plain().contains("snap-line"),
            "captured screen should contain echoed text: {:?}",
            snap.to_plain()
        );
        let _ = pty.shutdown();
    }
}
