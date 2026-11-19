//! Grok's encoding of a working directory as one path component of its
//! session store, and its inverse.

/// Grok's encoding of a working directory as one path component: every byte
/// outside `A-Za-z0-9-_.!~*'()` becomes `%XX`.
pub(super) fn encode_component(text: &str) -> String {
    let mut encoded = String::with_capacity(text.len() * 3);
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

/// The text `encode_component` turned into `name`; `None` when a `%` is not
/// followed by two hex digits or the bytes are not UTF-8. It does not check
/// that `name` is the one encoding Grok would write: callers that need that
/// encode the result again and compare.
pub(crate) fn decode_component(name: &str) -> Option<String> {
    let mut decoded = Vec::with_capacity(name.len());
    let mut bytes = name.bytes();
    while let Some(byte) = bytes.next() {
        if byte == b'%' {
            let high = hex_digit(bytes.next()?)?;
            let low = hex_digit(bytes.next()?)?;
            decoded.push(high << 4 | low);
        } else {
            decoded.push(byte);
        }
    }
    String::from_utf8(decoded).ok()
}

fn hex_digit(byte: u8) -> Option<u8> {
    char::from(byte)
        .to_digit(16)
        .and_then(|digit| u8::try_from(digit).ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decoding_inverts_groks_encoding() {
        for text in [
            "/home/me/Projects/x y",
            "/w/caf\u{e9} 100%",
            "C:\\work\\a b",
            "",
        ] {
            assert_eq!(
                decode_component(&encode_component(text)).as_deref(),
                Some(text)
            );
        }
        assert_eq!(decode_component("%2fwork").as_deref(), Some("/work"));
    }

    #[test]
    fn a_name_that_is_not_an_encoding_does_not_decode() {
        for name in ["%", "%2", "a%", "%G0", "%2G", "%+1", "%C3", "%FF%FE"] {
            assert_eq!(decode_component(name), None, "{name}");
        }
    }
}
