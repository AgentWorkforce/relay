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
//!   integration tests, the future `view`/`drive` clients in #864).
//! * `agent-relay-broker dump-pty <name>` — interactive debugging.
//!
//! The snapshot is **self-contained**: `capture` walks the grid once, copies
//! out the cells it needs, then drops the term lock. Renderers run against
//! the captured data, so they neither block the PTY reader thread nor race
//! with subsequent grid mutations.

use alacritty_terminal::event::VoidListener;
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::{Column, Line, Point};
use alacritty_terminal::term::cell::{Cell, Flags};
use alacritty_terminal::term::Term;
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
}

impl Snapshot {
    /// Capture the visible screen of a live `PtySession`. Holds the term
    /// lock only long enough to clone the cells out — does not block the
    /// reader thread while renderers run.
    pub fn capture(pty: &PtySession) -> Self {
        pty.with_term(Self::from_term)
    }

    /// Capture from a free-standing `Term` (used by tests and by the future
    /// `view`/`drive` clients that drive their own VT instances).
    pub fn from_term(term: &Term<VoidListener>) -> Self {
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
    /// Layout: cursor-home + erase display, then for each row emit cells
    /// left-to-right with per-cell SGR (foreground / background / bold /
    /// reverse / underline). After the grid we emit a CUP to place the
    /// real cursor at the captured `(row, col)`.
    ///
    /// SGR diffing is intentional: we only emit a new SGR sequence when a
    /// cell's attributes differ from the previous cell. This keeps the
    /// output reasonably compact without sacrificing correctness, and it
    /// guarantees a `\x1b[0m` reset before any transition back to default.
    pub fn to_ansi(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(
            // Cursor-home + clear + (per-cell SGR worst case) + CUP at end.
            8 + (self.rows as usize) * (self.cols as usize) * 6 + 16,
        );

        // Reset SGR, then home + erase display so the previous screen
        // doesn't bleed through (e.g. for terminals that don't repaint
        // every cell).
        out.extend_from_slice(b"\x1b[0m\x1b[H\x1b[2J");

        let mut current = SgrState::default();

        for (row_idx, row) in self.cells.iter().enumerate() {
            // Position the cursor at column 1 of this row before drawing.
            // 1-indexed CUP — alacritty's parser accepts it. We do this even
            // for row 0 because the leading `\x1b[2J` does not move the
            // cursor on every terminal implementation.
            write_cup(&mut out, (row_idx as u16).saturating_add(1), 1);

            for cell in row {
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

        // Reset attributes and place the cursor at the captured position so
        // the rendered screen ends in a clean state.
        if current != SgrState::default() {
            out.extend_from_slice(b"\x1b[0m");
        }
        let (cursor_row, cursor_col) = self.cursor;
        write_cup(&mut out, cursor_row.max(1), cursor_col.max(1));

        out
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
/// the terminal's default (handled by the surrounding reset).
fn named_color_sgr(named: NamedColor, role: &ColorRole) -> Option<u16> {
    // SGR foreground bases: 30..37 (normal), 90..97 (bright).
    // SGR background bases: 40..47 (normal), 100..107 (bright).
    let (normal_base, bright_base, default_code) = match role {
        ColorRole::Foreground => (30u16, 90u16, 39u16),
        ColorRole::Background => (40u16, 100u16, 49u16),
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
        // Foreground / Background default codes (39 / 49). Cursor and the
        // bright/dim foreground synonyms have no clean SGR; treat as default.
        NamedColor::Foreground
        | NamedColor::Background
        | NamedColor::Cursor
        | NamedColor::BrightForeground
        | NamedColor::DimForeground => default_code,
    })
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
        // Reset + home + erase display must be the first 12 bytes.
        assert!(bytes.starts_with(b"\x1b[0m\x1b[H\x1b[2J"));
    }

    #[test]
    fn ansi_emits_green_sgr_for_green_text() {
        // Same shape as parser_strips_csi_color_sequences_from_visible_text
        // in src/pty.rs — green wrapper around "OK".
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
