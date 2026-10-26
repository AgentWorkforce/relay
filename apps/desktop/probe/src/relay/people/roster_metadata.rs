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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn native_title_is_a_description_fallback_without_overriding_the_objective() {
        assert_eq!(
            describe(
                &json!({"session_title": "Fix login", "objective": "Review only"}),
                &Value::Null,
            ),
            "Review only"
        );
        assert_eq!(
            describe(&json!({"session_title": "Fix login"}), &Value::Null),
            "Fix login"
        );
    }

    #[test]
    fn gateway_agent_identifiers_are_not_linked_to_history() {
        for metadata in [
            json!({"source": "relay-desktop", "session_kind": "openclaw", "session_id": "main"}),
            json!({"source": "relay-desktop", "session_kind": "hermes", "session_id": "default"}),
            json!({"session_scope": "agent", "session_id": "main"}),
        ] {
            assert_eq!(history_session_id(&metadata), None);
        }
        assert_eq!(
            history_session_id(
                &json!({"session_kind": "openclaw", "session_id": "real-history-id"})
            )
            .as_deref(),
            Some("real-history-id")
        );
    }
}
