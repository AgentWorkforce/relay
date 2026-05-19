/// Find the nearest character boundary at or before the given byte index.
pub(crate) fn floor_char_boundary(s: &str, index: usize) -> usize {
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
pub(crate) fn strip_ansi(text: &str) -> String {
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
}
