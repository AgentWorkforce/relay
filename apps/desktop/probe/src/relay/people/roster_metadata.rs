//! Presentation metadata and History identity from a roster registration.

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
