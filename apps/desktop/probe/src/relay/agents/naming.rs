//! Default relay names derived locally from the session title.

use super::NAME_MAX;
use crate::relay::sessions::DiscoveredSession;

/// A readable default: harness, project, and at most two meaningful title
/// words. Registration allocates a number only when this name is taken;
/// persisted registrations keep their name when the session title changes.
pub fn suggested_name(session: &DiscoveredSession) -> String {
    suggested_name_numbered(session, 1)
}

pub(super) fn suggested_name_numbered(session: &DiscoveredSession, number: usize) -> String {
    let prefix = session.target.kind.source();
    let project = slugify(&session.project().unwrap_or_default());
    let title = slugify(&session.title);
    // Discovery sometimes has only the directory, id or a placeholder.
    // None of those is a task summary.
    let placeholder = title == project
        || title == slugify(&session.target.id)
        // Provider-only fallback titles supplied by LocalSessions::caller.
        || title == format!("{prefix}-session")
        || matches!(
            (prefix, title.as_str()),
            ("claude", "claude-code-session")
                | ("openclaw", "openclaw-agent")
                | ("hermes", "hermes")
        )
        || matches!(
            title.as_str(),
            "untitled"
                | "untitled-thread"
                | "untitled-session"
                | "new-session"
                | "new-chat"
                | "new-thread"
        );
    let mut words = Vec::new();
    if !placeholder {
        for word in title.split('-').filter(|word| !word.is_empty()) {
            if matches!(
                word,
                "a" | "an"
                    | "the"
                    | "and"
                    | "or"
                    | "to"
                    | "of"
                    | "for"
                    | "in"
                    | "on"
                    | "with"
                    | "from"
                    | "this"
                    | "that"
                    | "can"
                    | "could"
                    | "would"
                    | "you"
                    | "please"
                    | "i"
                    | "we"
                    | "me"
                    | "my"
                    | "our"
                    | "need"
                    | "want"
                    | "help"
            ) || words.contains(&word)
            {
                continue;
            }
            words.push(word);
            if words.len() == 2 {
                break;
            }
        }
    }
    let summary = if words.is_empty() {
        "session".to_string()
    } else {
        // Reserve room for the project even when the title has long tokens.
        words
            .iter()
            .map(|word| &word[..word.len().min(12)])
            .collect::<Vec<_>>()
            .join("-")
    };
    let suffix = if number == 1 {
        summary
    } else {
        format!("{summary}-{number}")
    };
    let project = if project.is_empty() {
        "session"
    } else {
        &project
    };
    let room = NAME_MAX - prefix.len() - suffix.len() - 2;
    let project = project[..project.len().min(room)].trim_end_matches('-');
    format!("{prefix}-{project}-{suffix}")
}

fn slugify(text: &str) -> String {
    let mut result = String::new();
    let mut pending_dash = false;
    for c in text.to_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            if pending_dash && !result.is_empty() {
                result.push('-');
            }
            pending_dash = false;
            result.push(c);
        } else {
            pending_dash = true;
        }
    }
    result
}
