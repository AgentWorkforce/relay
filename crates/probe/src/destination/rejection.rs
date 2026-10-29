//! The receiver's rejection body, read only for a 409, and the one log line
//! a rejection writes.
use std::io::Read;

pub(super) const MAX_ERROR_BODY: u64 = 524_288;
pub(super) fn parse_error_body(bytes: &[u8]) -> Option<serde_json::Value> {
    (bytes.len() as u64 <= MAX_ERROR_BODY).then_some(())?;
    serde_json::from_slice(bytes).ok()
}
pub(super) fn error_body_bytes(response: ureq::Response) -> Option<Vec<u8>> {
    let mut bytes = Vec::new();
    response
        .into_reader()
        .take(MAX_ERROR_BODY + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    Some(bytes)
}
pub(super) fn safe_error_code(value: &serde_json::Value) -> Option<String> {
    let code = value
        .get("code")
        .and_then(serde_json::Value::as_str)
        .or_else(|| {
            value
                .get("error")
                .and_then(|error| error.get("code"))
                .and_then(serde_json::Value::as_str)
        })?;
    (code.len() <= 64
        && !code.is_empty()
        && code
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_.:".contains(&byte)))
    .then(|| code.to_owned())
}
/// The characters of an unrecognized conflict body kept in the log, enough to
/// tell an edge or deploy page from a receiver answer without logging a
/// whole response.
pub(super) const UNKNOWN_CONFLICT_EXCERPT: usize = 160;
/// A run of token characters this long could be a credential a proxy echoed
/// back, so the log never keeps one.
const SECRET_RUN: usize = 20;
fn redacted(text: &str) -> String {
    fn flush(out: &mut String, run: &mut String) {
        out.push_str(if run.len() >= SECRET_RUN { "[redacted]" } else { run });
        run.clear();
    }
    let (mut out, mut run) = (String::new(), String::new());
    for c in text.chars() {
        if c.is_ascii_alphanumeric() || "-._~+/=".contains(c) {
            run.push(c);
        } else {
            flush(&mut out, &mut run);
            out.push(c);
        }
    }
    flush(&mut out, &mut run);
    out
}
fn body_excerpt(bytes: &[u8]) -> String {
    let text = redacted(&String::from_utf8_lossy(bytes));
    let mut chars = text.chars();
    let mut excerpt: String = chars.by_ref().take(UNKNOWN_CONFLICT_EXCERPT).collect();
    if chars.next().is_some() {
        excerpt.push('…');
    }
    format!("{excerpt:?}")
}
pub(super) fn rejection_log(status: u16, code: Option<&str>, body: Option<&[u8]>) -> String {
    match (status, code, body) {
        // Only the typed conflict is understood; any other 409 keeps its body.
        (409, Some(code), Some(body)) if code != "delivery_conflict" => format!(
            "receiver rejected upload status={status} code={code} body={}",
            body_excerpt(body)
        ),
        (_, Some(code), _) => format!("receiver rejected upload status={status} code={code}"),
        (409, None, Some(body)) => format!(
            "receiver rejected upload status={status} code=unknown body={}",
            body_excerpt(body)
        ),
        (409, None, None) => format!("receiver rejected upload status={status} code=unknown"),
        _ => format!("receiver rejected upload status={status}"),
    }
}
