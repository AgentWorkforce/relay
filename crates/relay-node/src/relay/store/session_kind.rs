//! The kinds of local session an agent can stand for, and the stable
//! provider identifiers shared by metadata, adapters and history.
use super::Target;
use serde::{Deserialize, Serialize};

/// Which kind of local session an agent stands for, and so which route a
/// message takes into it.
#[derive(
    Clone,
    Copy,
    Debug,
    PartialEq,
    Eq,
    Hash,
    PartialOrd,
    Ord,
    Serialize,
    Deserialize,
    schemars::JsonSchema,
)]
pub enum SessionKind {
    /// An existing Pi session connected through the bundled extension.
    #[serde(rename = "pi")]
    Pi,
    /// An existing Oh My Pi (`omp`) session connected through the same
    /// bundled extension as Pi, installed in omp's own agent directory.
    #[serde(rename = "omp")]
    Omp,
    /// A Codex thread, in the desktop app or a terminal `codex`.
    #[serde(rename = "codex")]
    Codex,
    /// A Claude Code session in a terminal: its cross-session inbox.
    #[serde(rename = "claude-terminal")]
    ClaudeTerminal,
    /// A Claude desktop app / claude.ai/code session.
    #[serde(rename = "claude-cloud")]
    ClaudeCloud,
    /// A probe-managed Grok ACP session with a verified leader binding.
    #[serde(rename = "grok")]
    Grok,
    /// An already-open Grok ACP session registered with immutable proof of
    /// its leader. A separate kind from `Grok`, so a registration names one
    /// route for good and can never be delivered through the other.
    #[serde(rename = "grok-open")]
    GrokOpen,
    /// A probe-managed authenticated OpenCode server session.
    #[serde(rename = "opencode")]
    OpenCode,
    /// A Muse session a person opened in a terminal, delivered to through a
    /// probe-owned courier Muse session in the same workspace and trust (no
    /// keystrokes into the person's session; Muse's own peer messaging
    /// carries the turn). Discovered from Muse's runtime session registry.
    #[serde(rename = "muse-open")]
    MuseOpen,
    /// An OpenCode session a person opened in a plain `opencode` TUI,
    /// reached through Agent Relay's OpenCode plugin: a per-process Unix
    /// socket that answers only delivery's requests for the sessions that
    /// process holds. Discovered from the plugin's per-pid records.
    #[serde(rename = "opencode-open")]
    OpenCodeOpen,
    /// A Devin CLI session a person runs in a terminal: its `devin acp`
    /// agent process holds `<devin>/cli/session_locks/<session>.lock` open,
    /// which is the kernel proof used for discovery and caller
    /// identification. Delivery writes the session's inbox file, which its
    /// lifecycle hooks drain into the conversation.
    #[serde(rename = "devin")]
    Devin,
    /// A Cursor CLI (`cursor-agent`) session a person runs in a terminal:
    /// the process holds its conversation's `store.db` open, which is the
    /// kernel proof used for discovery and caller identification. Delivery
    /// stages a message in Agent Relay's inbox, which Agent Relay's hooks in
    /// `~/.cursor/hooks.json` hand to the session at its next tool call or
    /// when its turn ends (`relay::cursor_cli`). Not a Cursor Cloud agent.
    #[serde(rename = "cursor-cli")]
    CursorCli,
    /// A native Copilot harness session in VS Code, reached by verified hooks.
    #[serde(rename = "copilot")]
    Copilot,
    /// An OpenClaw agent on the person's local OpenClaw Gateway, reached as
    /// a loopback operator client. Each relay sender gets a session of its
    /// own on that agent, never the person's main chat (`relay::openclaw`).
    #[serde(rename = "openclaw")]
    OpenClaw,
    /// A Hermes Agent home whose gateway serves its API on loopback. Each
    /// relay sender gets a Hermes session of its own (`relay::hermes`).
    #[serde(rename = "hermes")]
    Hermes,
}

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
            SessionKind::Copilot => "copilot",
            SessionKind::OpenClaw => "openclaw",
            SessionKind::Hermes => "hermes",
            SessionKind::Pi => "pi",
            SessionKind::Omp => "omp",
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
    /// agent or profile, and Pi and omp are not matched yet, so they have none.
    /// A host-specific discovered session uses `LocalSession::upload_key`
    /// instead.
    pub fn upload_key(&self) -> Option<String> {
        match self.kind {
            SessionKind::ClaudeCloud | SessionKind::OpenClaw | SessionKind::Hermes => None,
            // Cursor CLI transcripts are not collected yet.
            SessionKind::Pi | SessionKind::Omp | SessionKind::CursorCli => None,
            kind => Some(format!("{}:{}", kind.source(), self.id)),
        }
    }
}
