//! Decode a KERN_PROCARGS2 buffer without reading past the requested argv.
//! The kernel read and all process/authority checks remain in process.rs.

pub(super) fn decode(buffer: &[u8], environment: bool) -> (Vec<String>, Vec<String>) {
    let decoded = decode_with(buffer, environment, |bytes| {
        String::from_utf8_lossy(bytes).into_owned()
    });
    // Test-only observation at the actual ProcessTable boundary. No values
    // or counters are retained in the production decoder.
    #[cfg(test)]
    #[cfg(target_os = "macos")]
    MATERIALIZED.with(|count| count.set(count.get() + decoded.0.len() + decoded.1.len()));
    decoded
}

#[cfg(test)]
#[cfg(target_os = "macos")]
std::thread_local! {
    static MATERIALIZED: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
#[cfg(target_os = "macos")]
pub(super) fn materialized() -> usize {
    MATERIALIZED.with(std::cell::Cell::get)
}

#[cfg(test)]
#[cfg(target_os = "macos")]
pub(super) fn reset_materialized() {
    MATERIALIZED.with(|count| count.set(0));
}

fn decode_with(
    buffer: &[u8],
    environment: bool,
    mut text: impl FnMut(&[u8]) -> String,
) -> (Vec<String>, Vec<String>) {
    let Some(header) = buffer.get(..4) else {
        return (Vec::new(), Vec::new());
    };
    let argc = i32::from_ne_bytes([header[0], header[1], header[2], header[3]]);
    if argc <= 0 {
        return (Vec::new(), Vec::new());
    }
    let mut cursor = 4;
    while cursor < buffer.len() && buffer[cursor] != 0 {
        cursor += 1;
    }
    let mut strings = Vec::new();
    while cursor < buffer.len() {
        while cursor < buffer.len() && buffer[cursor] == 0 {
            cursor += 1;
        }
        let start = cursor;
        while cursor < buffer.len() && buffer[cursor] != 0 {
            cursor += 1;
        }
        if cursor > start {
            strings.push(text(&buffer[start..cursor]));
            // Match the old decoder's nonempty-string selection, including
            // empty argv entries, malformed buffers and lossy UTF8 handling.
            if !environment && strings.len() == argc as usize {
                break;
            }
        }
    }
    let count = (argc as usize).min(strings.len());
    let environment = strings.split_off(count);
    (strings, environment)
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(super) fn fixture(argc: i32, strings: &[&[u8]]) -> Vec<u8> {
        let mut buffer = argc.to_ne_bytes().to_vec();
        buffer.extend_from_slice(b"/fixture/executable\0\0\0");
        for string in strings {
            buffer.extend_from_slice(string);
            buffer.push(0);
        }
        buffer
    }

    /// Frozen old selection algorithm. Kept independent of the candidate.
    fn legacy(buffer: &[u8]) -> (Vec<String>, Vec<String>) {
        if buffer.len() < 4 {
            return (vec![], vec![]);
        }
        let argc = i32::from_ne_bytes([buffer[0], buffer[1], buffer[2], buffer[3]]);
        if argc <= 0 {
            return (vec![], vec![]);
        }
        let mut cursor = 4;
        while cursor < buffer.len() && buffer[cursor] != 0 {
            cursor += 1;
        }
        let mut strings = Vec::new();
        while cursor < buffer.len() {
            while cursor < buffer.len() && buffer[cursor] == 0 {
                cursor += 1;
            }
            let start = cursor;
            while cursor < buffer.len() && buffer[cursor] != 0 {
                cursor += 1;
            }
            if cursor > start {
                strings.push(String::from_utf8_lossy(&buffer[start..cursor]).into_owned());
            }
        }
        let count = (argc as usize).min(strings.len());
        let environment = strings.split_off(count);
        (strings, environment)
    }

    #[test]
    fn argv_and_full_environment_preserve_legacy_selection_for_all_buffer_boundaries() {
        let cases = [
            fixture(
                4,
                &[
                    b"node",
                    b"/fixture/claude",
                    b"--resume",
                    b"thread",
                    b"KEY=value",
                    b"EMPTY=",
                    b"MORE=a=b",
                ],
            ),
            fixture(3, &[b"claude", b"", b"argument", b"KEY=value", b"TAIL=x"]),
            fixture(99, &[b"codex", b"app-server", b"KEY=value"]),
            fixture(0, &[b"node", b"KEY=value"]),
            fixture(-1, &[b"node", b"KEY=value"]),
            fixture(2, &[b"node", b"\xff\xfe", b"KEY=\xff"]),
            fixture(2, &[b"node"]),
            [2i32.to_ne_bytes().as_slice(), b"unterminated-executable"].concat(),
        ];
        for buffer in cases {
            for end in 0..=buffer.len() {
                let buffer = &buffer[..end];
                let old = legacy(buffer);
                assert_eq!(decode(buffer, true), old, "full decode boundary{end}");
                let arguments = decode(buffer, false);
                assert_eq!(arguments.0, old.0, "argv boundary{end}");
                assert!(
                    arguments.1.is_empty(),
                    "argv-only never returns environment strings"
                );
            }
        }
    }

    #[test]
    fn argv_only_does_not_materialize_a_large_environment() {
        let mut buffer = fixture(4, &[b"node", b"/fixture/claude", b"--resume", b"thread"]);
        let argv_end = buffer.len();
        for i in 0..2048 {
            buffer.extend_from_slice(format!("FIXTURE_{i}={}\0", "x".repeat(128)).as_bytes());
        }
        let mut new_bytes = 0;
        let mut new_strings = 0;
        let arguments = decode_with(&buffer, false, |bytes| {
            new_bytes += bytes.len();
            new_strings += 1;
            String::from_utf8_lossy(bytes).into_owned()
        });
        let mut old_bytes = 0;
        let mut old_strings = 0;
        let full = decode_with(&buffer, true, |bytes| {
            old_bytes += bytes.len();
            old_strings += 1;
            String::from_utf8_lossy(bytes).into_owned()
        });
        assert_eq!(arguments.0, full.0);
        assert_eq!(new_strings, 4);
        assert!(new_bytes < argv_end);
        assert_eq!(old_strings, 2052);
        assert!(old_bytes > new_bytes + 2048 * 128);
        assert_eq!(full.1.len(), 2048);
        assert!(arguments.1.is_empty());
    }
}
