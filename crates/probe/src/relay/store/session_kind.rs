//! Stable provider identifiers shared by metadata, adapters and history.
use super::{SessionKind, Target};

impl SessionKind {
    pub fn as_str(self) -> &'static str {
        match self {
            SessionKind::Codex => "codex",
            SessionKind::ClaudeTerminal => "claude-terminal",
            SessionKind::ClaudeCloud => "claude-cloud",
            SessionKind::Grok => "grok",
            SessionKind::GrokOpen => "grok-open",
            SessionKind::OpenCode => "opencode",
            SessionKind::MuseOpen => "muse-open",
            SessionKind::OpenCodeOpen => "opencode-open",
            SessionKind::Devin => "devin",
            SessionKind::CursorCli => "cursor-cli",
            SessionKind::OpenClaw => "openclaw",
            SessionKind::Hermes => "hermes",
            SessionKind::Pi => "pi",
        }
    }

    /// The harness behind the kind, as icons and history name it.
    pub fn source(self) -> &'static str {
        match self {
            SessionKind::ClaudeTerminal | SessionKind::ClaudeCloud => "claude",
            SessionKind::GrokOpen => "grok",
            SessionKind::OpenCodeOpen => "opencode",
            SessionKind::MuseOpen => "muse",
            SessionKind::CursorCli => "cursor",
            _ => self.as_str(),
        }
    }
}

impl Target {
    /// The `SOURCE:ID` key the uploader lists this session under: each route
    /// names a session by its harness's own id. A Claude app session's
    /// transcript lives in Anthropic's cloud, OpenClaw and Hermes target an
    /// agent or profile, and Pi is not matched yet, so they have none.
    pub fn upload_key(&self) -> Option<String> {
        match self.kind {
            SessionKind::ClaudeCloud | SessionKind::OpenClaw | SessionKind::Hermes => None,
            // Cursor CLI transcripts are not collected yet.
            SessionKind::Pi | SessionKind::CursorCli => None,
            kind => Some(format!("{}:{}", kind.source(), self.id)),
        }
    }
}
