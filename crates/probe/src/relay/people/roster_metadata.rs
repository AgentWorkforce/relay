//! Presentation metadata and History identity from a roster registration.

use crate::relay::store::SessionKind;
use serde_json::Value;

fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub(super) fn describe(metadata: &Value, persona: &Value) -> String {
    if let Some(objective) = metadata["objective"]
        .as_str()
        .filter(|o| !o.trim().is_empty())
    {
        return one_line(objective);
    }
    if let Some(title) = metadata["session_title"]
        .as_str()
        .filter(|title| !title.trim().is_empty())
    {
        return one_line(title);
    }
    let parts: Vec<String> = ["role", "project"]
        .iter()
        .filter_map(|key| metadata[*key].as_str().filter(|v| !v.is_empty()))
        .map(one_line)
        .collect();
    if !parts.is_empty() {
        return parts.join(" · ");
    }
    persona.as_str().map(one_line).unwrap_or_default()
}

/// Gateway agent IDs are not History session IDs, including legacy desktop
/// registrations created before explicit agent scope was published.
pub(super) fn history_session_id(metadata: &Value) -> Option<String> {
    metadata["session_id"]
        .as_str()
        .filter(|_| {
            metadata["session_scope"] != "agent"
                && !(metadata["source"] == "relay-desktop"
                    && matches!(
                        metadata["session_kind"].as_str(),
                        Some("openclaw" | "hermes")
                    ))
        })
        .map(str::trim)
        .filter(|id| !id.is_empty() && id.len() <= 512)
        .map(str::to_string)
}

/// Session kinds registered by a hosted provider rather than a desktop.
pub(super) const REMOTE_SESSION_KINDS: [&str; 3] = ["capy", "cursor-cloud", "replicas"];

/// The harness a roster entry runs on. A desktop registration records its
/// `session_kind`, as does Agent Relay Cloud for a Capy thread; a fleet broker records
/// the worker's `cli`; other registrars are read from the conventional
/// `<harness>-` name prefix.
pub(super) fn provider_of(name: &str, metadata: &Value) -> Option<String> {
    const KNOWN: [&str; 9] = [
        "codex",
        "claude",
        "grok",
        "opencode",
        "cursor",
        "cursor-cloud",
        "muse",
        "capy",
        "replicas",
    ];
    let kind = metadata["session_kind"].as_str();
    let from_kind = kind
        .and_then(|kind| serde_json::from_value::<SessionKind>(Value::String(kind.into())).ok())
        .map(SessionKind::source)
        .or_else(|| {
            kind.and_then(|kind| {
                REMOTE_SESSION_KINDS
                    .into_iter()
                    .find(|known| *known == kind)
            })
        });
    let from_cli = || {
        let cli = metadata["cli"].as_str()?.trim().to_ascii_lowercase();
        // A command, a path or `cursor-agent`: its executable names the harness.
        let executable = cli.split_whitespace().next()?.rsplit('/').next()?;
        let harness = match executable.strip_suffix("-agent").unwrap_or(executable) {
            // The fleet list's own spellings of Claude Code.
            "claude-code" | "claude_code" | "claudecode" => "claude",
            harness => harness,
        };
        KNOWN.into_iter().find(|known| *known == harness)
    };
    from_kind
        .or_else(from_cli)
        .or_else(|| {
            let prefix = name
                .split('-')
                .next()
                .unwrap_or_default()
                .to_ascii_lowercase();
            KNOWN.into_iter().find(|known| *known == prefix)
        })
        .map(str::to_string)
}
