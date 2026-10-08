//! Shared, bounded PTY injection wire format for fleet and wrap.
use crate::pty::PtySession;
use std::time::Duration;

pub(crate) const MAX_INJECTION_BODY_BYTES: usize = 16 * 1024;
/// Room kept for the attribution line and MCP reminder the worker wraps around
/// a body. Body-level caps use `MAX_BODY_BYTES` so a body accepted up front
/// still fits `MAX_INJECTION_BODY_BYTES` once formatted.
pub(crate) const ENVELOPE_RESERVE_BYTES: usize = 2 * 1024;
pub(crate) const MAX_BODY_BYTES: usize = MAX_INJECTION_BODY_BYTES - ENVELOPE_RESERVE_BYTES;

/// The spawn error for an initial PTY task that cannot fit its envelope.
pub(crate) fn task_too_large_error(task: &str) -> Option<String> {
    (task.len() > MAX_BODY_BYTES).then(|| {
        format!(
            "spawn_task_too_large: task is {} bytes; the limit is {MAX_BODY_BYTES} bytes so its envelope fits the {MAX_INJECTION_BODY_BYTES}-byte PTY limit. Write the brief to a file on the node and send a short pointer.",
            task.len()
        )
    })
}
// At the default 5 ms/byte, leaves room for readiness, prompt recheck and verification.
pub(crate) const MAX_TYPED_WRITE_TIME: Duration = Duration::from_millis(7680);
pub(crate) const MAX_TYPED_BYTES: usize = MAX_TYPED_WRITE_TIME.as_millis() as usize / 5;
pub(crate) const INJECTION_PROMPT_WAIT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum InjectionWire {
    Paste,
    Typed,
}

pub(crate) fn injection_wire(cli: &str, pty: &PtySession) -> InjectionWire {
    select_wire(
        cli,
        pty.bracketed_paste_enabled(),
        std::env::var("RELAY_INJECT_PASTE").as_deref() == Ok("0"),
    )
}
fn select_wire(cli: &str, capable: bool, disabled: bool) -> InjectionWire {
    if !disabled && (capable || crate::readiness::is_devin_cli(cli)) {
        InjectionWire::Paste
    } else {
        InjectionWire::Typed
    }
}
pub(crate) fn injection_bytes(wire: InjectionWire, text: &str) -> Vec<u8> {
    let text = text.replace("\r\n", "\n").replace(['\r', '\x1b'], "");
    match wire {
        InjectionWire::Paste => format!("\x1b[200~{text}\x1b[201~").into_bytes(),
        InjectionWire::Typed => text.into_bytes(),
    }
}
pub(crate) fn effective_limit(wire: InjectionWire, pace: Duration) -> usize {
    if wire == InjectionWire::Paste || pace.is_zero() {
        MAX_INJECTION_BODY_BYTES
    } else {
        MAX_TYPED_BYTES.min((MAX_TYPED_WRITE_TIME.as_millis() / pace.as_millis().max(1)) as usize)
    }
}
pub(crate) fn can_inject(cli: &str, pty: &PtySession) -> bool {
    let lower = cli.to_lowercase();
    let known = ["claude", "codex", "gemini"]
        .iter()
        .any(|name| lower.contains(name))
        || crate::readiness::is_devin_cli(cli);
    !known
        || crate::readiness::cli_prompt_ready(
            cli,
            crate::readiness::GridReadinessSnapshot {
                screen: &pty.screen_text(),
                cursor: Some(pty.cursor_position()),
            },
        )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn body_cannot_submit_or_close_paste() {
        for ch in (0..=0x10ffff).filter_map(char::from_u32) {
            let body = format!("head{ch}\x1b[201~\r\nend\r");
            for wire in [InjectionWire::Paste, InjectionWire::Typed] {
                let bytes = injection_bytes(wire, &body);
                assert!(!bytes.contains(&b'\r'));
                let expected_escapes = if wire == InjectionWire::Paste { 2 } else { 0 };
                assert_eq!(bytes.iter().filter(|&&b| b == 27).count(), expected_escapes);
            }
        }
    }
    /// A body accepted at `MAX_BODY_BYTES` must still fit the PTY limit once the
    /// worker adds the attribution line and the full MCP reminder (relay#1893
    /// review: the body cap used to ignore the envelope).
    #[test]
    fn a_body_at_the_body_cap_fits_the_pty_limit_with_its_envelope() {
        let long = "n".repeat(128);
        let envelope = crate::broker::injection_format::format_injection_for_worker_with_workspace(
            &long,
            &format!("init_{long}"),
            &"x".repeat(MAX_BODY_BYTES),
            &format!("#{long}"),
            true,
            false,
            Some(&long),
            Some(&format!("rw_{long}")),
            Some(&long),
        );
        assert!(
            envelope.len() <= MAX_INJECTION_BODY_BYTES,
            "{} > {MAX_INJECTION_BODY_BYTES}",
            envelope.len()
        );
    }
    #[test]
    fn capability_and_override() {
        assert_eq!(select_wire("claude", true, false), InjectionWire::Paste);
        assert_eq!(select_wire("claude", true, true), InjectionWire::Typed);
        assert_eq!(select_wire("other", false, false), InjectionWire::Typed);
        assert_eq!(injection_bytes(InjectionWire::Typed, "a\r\nb\rc"), b"a\nbc");
    }
}
