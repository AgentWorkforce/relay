use crate::relay::store::SessionKind;

/// A session kind as rows and details name it.
pub fn kind_label(kind: SessionKind) -> &'static str {
    match kind {
        SessionKind::Codex => "Codex",
        SessionKind::ClaudeTerminal => "Claude Code",
        SessionKind::ClaudeCloud => "Claude app",
        SessionKind::Grok | SessionKind::GrokOpen => "Grok",
        SessionKind::OpenCode | SessionKind::OpenCodeOpen => "OpenCode",
        SessionKind::MuseOpen => "Muse",
        SessionKind::Devin => "Devin",
        SessionKind::OpenClaw => "OpenClaw",
        SessionKind::Hermes => "Hermes",
        SessionKind::Pi => "Pi",
    }
}
