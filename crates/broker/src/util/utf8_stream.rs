//! Stateful streaming UTF-8 decoder.
//!
//! PTY reads can land in the middle of a multi-byte UTF-8 codepoint, so a
//! naïve `String::from_utf8_lossy` on each chunk replaces partial sequences
//! with `U+FFFD` even though the next chunk would complete the codepoint.
//! `Utf8StreamDecoder` keeps any trailing incomplete byte sequence buffered
//! across `decode` calls and only substitutes `U+FFFD` for byte sequences
//! that are definitively invalid.

/// Streaming UTF-8 decoder that preserves codepoints split across byte
/// chunks.
#[derive(Debug, Default)]
pub(crate) struct Utf8StreamDecoder {
    pending: Vec<u8>,
}

impl Utf8StreamDecoder {
    pub(crate) fn new() -> Self {
        Self {
            pending: Vec::new(),
        }
    }

    /// Decode an incoming byte chunk, returning all complete UTF-8 text
    /// available. Any trailing bytes that form an incomplete codepoint are
    /// retained for the next call.
    pub(crate) fn decode(&mut self, bytes: &[u8]) -> String {
        if bytes.is_empty() && self.pending.is_empty() {
            return String::new();
        }
        self.pending.extend_from_slice(bytes);
        let mut output = String::with_capacity(self.pending.len());
        let mut cursor = 0;

        while cursor < self.pending.len() {
            match std::str::from_utf8(&self.pending[cursor..]) {
                Ok(s) => {
                    output.push_str(s);
                    cursor = self.pending.len();
                    break;
                }
                Err(e) => {
                    let valid_up_to = e.valid_up_to();
                    if valid_up_to > 0 {
                        // SAFETY: from_utf8 reported these bytes as valid.
                        let valid =
                            std::str::from_utf8(&self.pending[cursor..cursor + valid_up_to])
                                .expect("valid_up_to slice must be valid UTF-8");
                        output.push_str(valid);
                        cursor += valid_up_to;
                    }

                    match e.error_len() {
                        Some(invalid_len) => {
                            output.push('\u{FFFD}');
                            cursor += invalid_len;
                        }
                        None => {
                            // Incomplete sequence at the end of the buffer —
                            // hold it for the next chunk.
                            break;
                        }
                    }
                }
            }
        }

        self.pending.drain(..cursor);
        output
    }

    /// Drain any remaining buffered bytes, emitting `U+FFFD` for each
    /// incomplete sequence. Call once no more bytes will arrive.
    pub(crate) fn flush(&mut self) -> String {
        if self.pending.is_empty() {
            return String::new();
        }
        let bytes = std::mem::take(&mut self.pending);
        let mut output = String::with_capacity(bytes.len());
        let mut cursor = 0;
        while cursor < bytes.len() {
            match std::str::from_utf8(&bytes[cursor..]) {
                Ok(s) => {
                    output.push_str(s);
                    break;
                }
                Err(e) => {
                    let valid_up_to = e.valid_up_to();
                    if valid_up_to > 0 {
                        let valid = std::str::from_utf8(&bytes[cursor..cursor + valid_up_to])
                            .expect("valid_up_to slice must be valid UTF-8");
                        output.push_str(valid);
                        cursor += valid_up_to;
                    }
                    output.push('\u{FFFD}');
                    match e.error_len() {
                        Some(invalid_len) => cursor += invalid_len,
                        // Incomplete trailing sequence: consume the rest.
                        None => break,
                    }
                }
            }
        }
        output
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_ascii_passthrough() {
        let mut dec = Utf8StreamDecoder::new();
        assert_eq!(dec.decode(b"hello"), "hello");
        assert_eq!(dec.decode(b" world"), " world");
    }

    #[test]
    fn box_drawing_split_across_two_chunks() {
        // U+2500 BOX DRAWINGS LIGHT HORIZONTAL = E2 94 80
        let mut dec = Utf8StreamDecoder::new();
        let first = dec.decode(&[0xE2]);
        let second = dec.decode(&[0x94, 0x80]);
        assert_eq!(first, "");
        assert_eq!(second, "\u{2500}");
        assert!(!format!("{first}{second}").contains('\u{FFFD}'));
    }

    #[test]
    fn box_drawing_split_at_every_byte_boundary() {
        // U+2588 FULL BLOCK = E2 96 88
        let original = "\u{2588}";
        let bytes = original.as_bytes();
        for split in 1..bytes.len() {
            let mut dec = Utf8StreamDecoder::new();
            let mut combined = dec.decode(&bytes[..split]);
            combined.push_str(&dec.decode(&bytes[split..]));
            assert_eq!(
                combined, original,
                "split at {split} should preserve the original codepoint"
            );
            assert!(
                !combined.contains('\u{FFFD}'),
                "split at {split} produced replacement char: {combined:?}"
            );
        }
    }

    #[test]
    fn cjk_glyph_split_across_chunks() {
        // U+4E2D 中 = E4 B8 AD
        let original = "\u{4E2D}";
        let bytes = original.as_bytes();
        for split in 1..bytes.len() {
            let mut dec = Utf8StreamDecoder::new();
            let mut combined = dec.decode(&bytes[..split]);
            combined.push_str(&dec.decode(&bytes[split..]));
            assert_eq!(combined, original);
            assert!(!combined.contains('\u{FFFD}'));
        }
    }

    #[test]
    fn four_byte_emoji_split_at_every_boundary() {
        // U+1F600 😀 = F0 9F 98 80
        let original = "\u{1F600}";
        let bytes = original.as_bytes();
        for split in 1..bytes.len() {
            let mut dec = Utf8StreamDecoder::new();
            let mut combined = dec.decode(&bytes[..split]);
            combined.push_str(&dec.decode(&bytes[split..]));
            assert_eq!(combined, original, "split at {split}");
            assert!(!combined.contains('\u{FFFD}'));
        }
    }

    #[test]
    fn byte_by_byte_streaming() {
        let original = "héllo 世界 😀 ─";
        let bytes = original.as_bytes();
        let mut dec = Utf8StreamDecoder::new();
        let mut out = String::new();
        for b in bytes {
            out.push_str(&dec.decode(&[*b]));
        }
        out.push_str(&dec.flush());
        assert_eq!(out, original);
        assert!(!out.contains('\u{FFFD}'));
    }

    #[test]
    fn invalid_byte_in_middle_is_replaced() {
        let mut dec = Utf8StreamDecoder::new();
        // 'A' (0x41) + invalid lone 0xFF + 'B' (0x42)
        let out = dec.decode(&[0x41, 0xFF, 0x42]);
        assert_eq!(out, "A\u{FFFD}B");
    }

    #[test]
    fn invalid_continuation_after_valid_lead_is_replaced() {
        let mut dec = Utf8StreamDecoder::new();
        // E2 (start of 3-byte) + 0x41 ('A' — not a continuation byte)
        let out = dec.decode(&[0xE2, 0x41]);
        // E2 is invalid (can't start that codepoint), 'A' is valid.
        assert!(out.contains('\u{FFFD}'));
        assert!(out.ends_with('A'));
    }

    #[test]
    fn flush_emits_replacement_for_truncated_tail() {
        let mut dec = Utf8StreamDecoder::new();
        // E2 alone is incomplete — held in buffer, no output yet.
        assert_eq!(dec.decode(&[0xE2]), "");
        // Flush should emit one replacement character since stream ended mid-codepoint.
        assert_eq!(dec.flush(), "\u{FFFD}");
        // Subsequent flush is empty.
        assert_eq!(dec.flush(), "");
    }

    #[test]
    fn empty_input_is_handled() {
        let mut dec = Utf8StreamDecoder::new();
        assert_eq!(dec.decode(&[]), "");
        assert_eq!(dec.flush(), "");
    }

    #[test]
    fn multiple_incomplete_chunks_combine() {
        // Send E2 94 80 (U+2500) byte-by-byte.
        let mut dec = Utf8StreamDecoder::new();
        assert_eq!(dec.decode(&[0xE2]), "");
        assert_eq!(dec.decode(&[0x94]), "");
        assert_eq!(dec.decode(&[0x80]), "\u{2500}");
    }

    #[test]
    fn matches_from_utf8_lossy_for_complete_input() {
        let inputs: &[&[u8]] = &[
            b"plain ascii",
            "héllo".as_bytes(),
            "中文 box ─ end".as_bytes(),
            "emoji 😀 done".as_bytes(),
        ];
        for input in inputs {
            let mut dec = Utf8StreamDecoder::new();
            let mut out = dec.decode(input);
            out.push_str(&dec.flush());
            assert_eq!(out, String::from_utf8_lossy(input));
        }
    }
}
