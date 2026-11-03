//! Devin session ids accepted at file and IPC boundaries.
pub fn is_session_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    (2..=128).contains(&bytes.len())
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
        && bytes[0] != b'-'
        && bytes[bytes.len() - 1] != b'-'
}
