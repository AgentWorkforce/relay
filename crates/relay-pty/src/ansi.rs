/// Find the nearest character boundary at or before the given byte index.
pub fn floor_char_boundary(s: &str, index: usize) -> usize {
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
///
/// Cursor-forward (`ESC[<n>C`) sequences are replaced with spaces so that
/// CLIs which render injected text using cursor movement (e.g. Claude Code
/// v2.1.49+) still produce readable output for echo detection.
pub fn strip_ansi(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            match chars.peek() {
                Some('[') => {
                    chars.next();
                    // Collect parameter bytes (digits, ';', '?')
                    let mut param_buf = String::new();
                    while let Some(&nc) = chars.peek() {
                        chars.next();
                        if nc.is_ascii_alphabetic() || nc == '@' || nc == '`' {
                            // Cursor-forward: replace with spaces
                            if nc == 'C' {
                                let count = param_buf.parse::<usize>().unwrap_or(1);
                                for _ in 0..count {
                                    result.push(' ');
                                }
                            }
                            break;
                        }
                        param_buf.push(nc);
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

/// State of the streaming ANSI scanner (mirrors the TypeScript
/// `AnsiBoundaryScanner` in `packages/cli/src/cli/lib/attach.ts`). Only the
/// ASCII control bytes that delimit escape sequences drive the machine;
/// multi-byte UTF-8 payload is printable in the ground state and never appears
/// inside a CSI/OSC/DCS body, so scanning by `char` is safe.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AnsiState {
    /// Not inside a sequence.
    Ground,
    /// Saw `ESC`; awaiting the sequence introducer.
    Esc,
    /// Inside a CSI (`ESC [`) sequence, collecting params until a final byte.
    Csi,
    /// Inside an OSC (`ESC ]`) string, terminated by `BEL` or `ST` (`ESC \`).
    Osc,
    /// Saw `ESC` inside an OSC — possible `ST`.
    OscEsc,
    /// Inside a DCS/SOS/PM/APC string (`ESC P`/`X`/`^`/`_`), terminated by `ST`.
    Str,
    /// Saw `ESC` inside a string — possible `ST`.
    StrEsc,
}

/// Guard against unbounded buffering: a stray `ESC` that never terminates (or a
/// pathologically long OSC/DCS) is flushed once its raw tail exceeds this many
/// bytes so the stripper can't hold back the stream indefinitely.
const ANSI_TAIL_MAX: usize = 4096;

/// Stateful, streaming ANSI stripper that preserves escape sequences split
/// across chunk boundaries.
///
/// The stateless [`strip_ansi`] scans each chunk independently, so a sequence
/// straddling two PTY reads (e.g. `\x1b[3;5H` arriving as `\x1b[3;` + `5H`, or a
/// ghost-text marker `\x1b[7m` split as `\x1b[7` + `m`) leaves fragments like
/// `3;5H` in the "clean" text feeding readiness/echo/continuity detection, or
/// causes a split marker to be missed entirely. `AnsiStripper` mirrors
/// [`Utf8StreamDecoder`](crate::utf8_stream::Utf8StreamDecoder): it holds back
/// the trailing incomplete escape sequence between [`feed`](Self::feed) calls
/// and prepends it to the next chunk, so downstream detection always sees whole
/// sequences.
///
/// Use one instance per worker stream. One-shot callers with a complete buffer
/// should keep using [`strip_ansi`].
#[derive(Debug, Default)]
pub struct AnsiStripper {
    /// Raw bytes of an incomplete trailing escape sequence, carried to the
    /// next `feed`/`feed_raw` call.
    pending: String,
}

impl AnsiStripper {
    pub fn new() -> Self {
        Self {
            pending: String::new(),
        }
    }

    /// Feed a chunk and return the ANSI-stripped text for the portion that
    /// forms complete sequences. Any trailing incomplete escape sequence is
    /// buffered for the next call.
    #[must_use]
    pub fn feed(&mut self, chunk: &str) -> String {
        let complete = self.split(chunk);
        strip_ansi(&complete)
    }

    /// Like [`feed`](Self::feed) but returns the *raw* complete-prefix (escape
    /// sequences intact). Use this for detectors that scan for raw markers —
    /// e.g. auto-suggestion ghost-text (`\x1b[7m`) — so a marker split across
    /// chunks is stitched back together before matching. Callers that also
    /// want clean text can pass the result to [`strip_ansi`].
    #[must_use]
    pub fn feed_raw(&mut self, chunk: &str) -> String {
        self.split(chunk)
    }

    /// Drain any buffered incomplete tail (raw). Call once no more chunks will
    /// arrive; the returned text may contain a dangling escape fragment.
    #[must_use]
    pub fn flush(&mut self) -> String {
        std::mem::take(&mut self.pending)
    }

    /// Prepend the pending tail to `chunk`, scan for the last safe boundary,
    /// and split into (returned complete prefix, retained incomplete tail).
    fn split(&mut self, chunk: &str) -> String {
        if self.pending.is_empty() {
            // Fast path: nothing held back.
            let (complete_len, complete) = Self::scan(chunk);
            self.pending = chunk[complete_len..].to_string();
            return complete.to_string();
        }
        let mut combined = std::mem::take(&mut self.pending);
        combined.push_str(chunk);
        let (complete_len, complete) = Self::scan(&combined);
        let result = complete.to_string();
        self.pending = combined[complete_len..].to_string();
        result
    }

    /// Scan `s` and return `(byte_len, &s[..byte_len])` for the longest prefix
    /// that ends at a sequence boundary (ground state). The remainder is an
    /// incomplete trailing escape sequence.
    fn scan(s: &str) -> (usize, &str) {
        let mut state = AnsiState::Ground;
        // Byte index where the current in-progress sequence started; only
        // meaningful when `state != Ground`.
        let mut seq_start = 0usize;
        for (idx, c) in s.char_indices() {
            let code = c as u32;
            match state {
                AnsiState::Ground => {
                    if code == 0x1b {
                        state = AnsiState::Esc;
                        seq_start = idx;
                    }
                }
                AnsiState::Esc => match code {
                    0x5b => state = AnsiState::Csi,                      // ESC [
                    0x5d => state = AnsiState::Osc,                      // ESC ]
                    0x50 | 0x58 | 0x5e | 0x5f => state = AnsiState::Str, // DCS/SOS/PM/APC
                    _ => state = AnsiState::Ground, // 2-byte escape (ESC 7, ESC c, …)
                },
                AnsiState::Csi => {
                    if code == 0x1b {
                        state = AnsiState::Esc; // stray ESC restarts
                        seq_start = idx;
                    } else if (0x40..=0x7e).contains(&code) {
                        state = AnsiState::Ground; // final byte ends the CSI
                    }
                }
                AnsiState::Osc => {
                    if code == 0x07 {
                        state = AnsiState::Ground; // BEL terminator
                    } else if code == 0x1b {
                        state = AnsiState::OscEsc; // possible ST
                    }
                }
                AnsiState::OscEsc => {
                    state = if code == 0x5c {
                        AnsiState::Ground
                    } else {
                        AnsiState::Osc
                    };
                }
                AnsiState::Str => {
                    if code == 0x1b {
                        state = AnsiState::StrEsc;
                    }
                }
                AnsiState::StrEsc => {
                    state = if code == 0x5c {
                        AnsiState::Ground
                    } else {
                        AnsiState::Str
                    };
                }
            }
        }
        if state == AnsiState::Ground {
            (s.len(), s)
        } else if s.len() - seq_start > ANSI_TAIL_MAX {
            // Runaway/unterminated sequence — flush it rather than buffer
            // forever. Downstream sees the raw fragment, matching the
            // stateless stripper's behaviour on such input.
            (s.len(), s)
        } else {
            (seq_start, &s[..seq_start])
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_ansi_removes_csi_sequences() {
        assert_eq!(strip_ansi("\x1b[32mgreen\x1b[0m"), "green");
        assert_eq!(strip_ansi("\x1b[1;31mred bold\x1b[0m"), "red bold");
    }

    #[test]
    fn strip_ansi_removes_osc_sequences() {
        assert_eq!(strip_ansi("\x1b]0;title\x07text"), "text");
        assert_eq!(strip_ansi("\x1b]0;title\x1b\\text"), "text");
    }

    #[test]
    fn strip_ansi_preserves_plain_text() {
        let plain = "Hello, world! 123\nNew line";
        assert_eq!(strip_ansi(plain), plain);
    }

    #[test]
    fn strip_ansi_handles_charset_sequences() {
        assert_eq!(strip_ansi("\x1b(Btext"), "text");
    }

    // ---- AnsiStripper (stateful streaming) ----

    #[test]
    fn stripper_matches_strip_ansi_for_whole_chunk() {
        let mut s = AnsiStripper::new();
        assert_eq!(s.feed("\x1b[32mgreen\x1b[0m"), "green");
    }

    #[test]
    fn stripper_handles_split_csi_across_feeds() {
        // "\x1b[3;5H" (cursor position) split as "\x1b[3;" + "5H".
        let mut s = AnsiStripper::new();
        let a = s.feed("before\x1b[3;");
        let b = s.feed("5Hafter");
        // The fragment "3;5H" must never leak into the clean text.
        let combined = format!("{a}{b}");
        assert!(
            !combined.contains("3;5H"),
            "split CSI leaked fragment: {combined:?}"
        );
        assert_eq!(combined, "beforeafter");
    }

    #[test]
    fn stripper_split_at_every_boundary_of_csi() {
        let input = "x\x1b[1;31my\x1b[0mz";
        let expected = strip_ansi(input);
        let bytes = input.len();
        for split in 1..bytes {
            if !input.is_char_boundary(split) {
                continue;
            }
            let mut s = AnsiStripper::new();
            let mut out = s.feed(&input[..split]);
            out.push_str(&s.feed(&input[split..]));
            out.push_str(&strip_ansi(&s.flush()));
            assert_eq!(out, expected, "split at {split} corrupted output");
        }
    }

    #[test]
    fn stripper_detects_split_reverse_video_marker() {
        // The auto-suggestion guard keys on the raw "\x1b[7m" marker. Split it
        // as "\x1b[7" + "m" and confirm the stitched raw stream contains the
        // whole marker so detection can trip.
        let mut s = AnsiStripper::new();
        let a = s.feed_raw("> \x1b[7");
        let b = s.feed_raw("m \x1b[27m\x1b[2m ghost");
        let raw = format!("{a}{b}");
        assert!(
            raw.contains("\x1b[7m"),
            "stitched raw stream missing reverse-video marker: {raw:?}"
        );
        assert!(raw.contains("\x1b[27m\x1b[2m"));
    }

    #[test]
    fn stripper_holds_incomplete_trailing_escape() {
        let mut s = AnsiStripper::new();
        // A lone ESC at the end is incomplete: nothing emitted yet.
        assert_eq!(s.feed("done\x1b"), "done");
        // Completing the CSI on the next feed strips it cleanly.
        assert_eq!(s.feed("[0m!"), "!");
    }

    #[test]
    fn stripper_split_osc_across_feeds() {
        let mut s = AnsiStripper::new();
        let a = s.feed("\x1b]0;my ti");
        let b = s.feed("tle\x07text");
        assert_eq!(format!("{a}{b}"), "text");
    }

    #[test]
    fn stripper_flushes_runaway_unterminated_escape() {
        let mut s = AnsiStripper::new();
        // An ESC that never terminates must not be buffered forever: once the
        // in-progress tail exceeds the cap it is released instead of held.
        let big = format!("\x1b[{}", "0".repeat(ANSI_TAIL_MAX + 10));
        let _ = s.feed(&big);
        assert!(
            s.flush().len() <= ANSI_TAIL_MAX,
            "runaway escape must not be buffered past the cap"
        );
        // The stream stays usable: subsequent normal text still comes through.
        let mut s2 = AnsiStripper::new();
        let _ = s2.feed(&big);
        assert_eq!(s2.feed("plain"), "plain");
    }

    #[test]
    fn stripper_byte_by_byte_streaming_matches_oneshot() {
        let input = "hi \x1b[1mbold\x1b[0m \x1b]0;t\x07 end";
        let expected = strip_ansi(input);
        let mut s = AnsiStripper::new();
        let mut out = String::new();
        let mut buf = [0u8; 4];
        for c in input.chars() {
            out.push_str(&s.feed(c.encode_utf8(&mut buf)));
        }
        out.push_str(&strip_ansi(&s.flush()));
        assert_eq!(out, expected);
    }
}
