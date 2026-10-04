//! Shared, bounded PTY injection wire format for fleet and wrap.
use crate::pty::PtySession;
use std::time::Duration;

pub(crate) const MAX_INJECTION_BODY_BYTES: usize = 16 * 1024;
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
    #[test]
    fn capability_and_override() {
        assert_eq!(select_wire("claude", true, false), InjectionWire::Paste);
        assert_eq!(select_wire("claude", true, true), InjectionWire::Typed);
        assert_eq!(select_wire("other", false, false), InjectionWire::Typed);
        assert_eq!(injection_bytes(InjectionWire::Typed, "a\r\nb\rc"), b"a\nbc");
    }
}
