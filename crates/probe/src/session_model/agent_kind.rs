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
        SessionKind::CursorCli => "Cursor CLI",
        SessionKind::OpenClaw => "OpenClaw",
        SessionKind::Hermes => "Hermes",
        SessionKind::Pi => "Pi",
    }
}

/// A history source or harness (`codex`, `claude-code`, `xai`, …) as the
/// app names it; one it does not know is capitalized.
pub fn source_name(source: &str) -> String {
    match source.to_lowercase().as_str() {
        "codex" => "Codex",
        "claude" => "Claude",
        "claude-code" | "claude_code" | "claudecode" => "Claude Code",
        "grok" | "xai" => "Grok",
        "grok-bot" => "Grok Bot",
        "cursor" => "Cursor",
        "cursor-cloud" | "cursor_cloud" => "Cursor Cloud",
        "opencode" | "open-code" | "open_code" => "OpenCode",
        "openai" | "open-ai" | "open_ai" => "OpenAI",
        "muse" | "muse-open" => "Muse",
        "devin" => "Devin",
        "openclaw" => "OpenClaw",
        "hermes" => "Hermes",
        _ => return super::capitalized(source),
    }
    .to_string()
}

/// A Claude Code on the web session's host, as the core names it.
pub const CLAUDE_WEB_HOST: &str = "claude-web";

/// Where a Claude cloud session runs: on the web, else in the Claude app.
pub fn claude_cloud_place(host: Option<&str>) -> &'static str {
    if host == Some(CLAUDE_WEB_HOST) {
        "Claude Code on the web"
    } else {
        "Claude app"
    }
}

/// A session kind with the app hosting it, as the Kind detail names it.
pub fn hosted_kind_label(kind: SessionKind, host: Option<&str>) -> String {
    let provider = kind_label(kind);
    match host {
        Some(CLAUDE_WEB_HOST) => claude_cloud_place(host).to_string(),
        Some("paseo") => format!("{provider} in Paseo"),
        Some("conductor") => format!("{provider} in Conductor"),
        _ => provider.to_string(),
    }
}
