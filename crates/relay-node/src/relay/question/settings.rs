//! The question escalation settings: `question_escalation` (`off` or `on`,
//! off unless set) and `question_escalation_inbox` (the agent questions go
//! to; empty means the owner's person identity). The store keeps them;
//! `settings.set` checks them here. An agent may turn escalation on and off.
//! The inbox decides who can answer as the person, so only the person (and
//! fleet policy) sets it: `question_escalation_inbox` is in `PERSON_SETS`.
//! An agent may clear it.

use crate::relay::store::Store;
use serde_json::{json, Map, Value};

/// The keys `settings.get` and `settings.set` name them by.
pub const KEYS: [&str; 2] = [ESCALATION, INBOX];

pub const ESCALATION: &str = "question_escalation";
pub const INBOX: &str = "question_escalation_inbox";
/// Read-only: where escalation works and where it cannot.
pub const STATUS: &str = "question_escalation_status";

/// The longest inbox name accepted, in characters.
pub const MAX_INBOX: usize = 128;

/// What `question_escalation_status` says.
pub const STATUS_TEXT: &str = "Available for Claude Code sessions (interactive and spawned), \
through Agent Relay's Claude Code hook (claude_session_hook), and spawned Codex sessions. \
Unavailable for interactive Codex, Cursor, Copilot, Grok and OpenCode \
sessions: they have no hook before a question is shown.";

/// Whether questions are escalated.
pub fn on(store: &Store) -> bool {
    store.extras.question_escalation == Some(true)
}

/// The agent questions go to, when one other than the owner is set.
pub fn inbox(store: &Store) -> Option<String> {
    store
        .extras
        .question_escalation_inbox
        .clone()
        .filter(|name| !name.is_empty())
}

/// `settings.get`'s question escalation values.
pub fn values(store: &Store) -> Map<String, Value> {
    let mut values = Map::new();
    values.insert(
        ESCALATION.into(),
        json!(if on(store) { "on" } else { "off" }),
    );
    values.insert(INBOX.into(), json!(inbox(store).unwrap_or_default()));
    values.insert(STATUS.into(), json!(STATUS_TEXT));
    values
}

/// A checked change to the question escalation settings among
/// `settings.set`'s changes.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Change {
    pub(crate) escalation: Option<bool>,
    /// `Some(None)` resets the inbox to the owner.
    pub(crate) inbox: Option<Option<String>>,
}

impl Change {
    /// Reads the question settings among `changes`; an invalid one is
    /// refused with the reason, before anything is changed.
    pub fn read(changes: &Map<String, Value>) -> Result<Change, String> {
        let escalation = match changes.get(ESCALATION) {
            None => None,
            Some(Value::String(value)) if value == "on" => Some(true),
            Some(Value::String(value)) if value == "off" => Some(false),
            Some(_) => return Err(format!("{ESCALATION} must be \"off\" or \"on\".")),
        };
        let inbox = match changes.get(INBOX) {
            None => None,
            Some(Value::String(name)) => Some(checked_inbox(name)?),
            Some(_) => return Err(format!("{INBOX} must be a string.")),
        };
        Ok(Change { escalation, inbox })
    }

    pub fn is_empty(&self) -> bool {
        *self == Change::default()
    }

    pub fn apply(&self, store: &mut Store) {
        if self.escalation.is_some() {
            store.extras.question_escalation = self.escalation;
        }
        if let Some(inbox) = &self.inbox {
            store.extras.question_escalation_inbox = inbox.clone();
        }
    }
}

/// `name` trimmed: `None` for empty (the owner), else 1 to `MAX_INBOX`
/// characters with no control characters.
pub fn checked_inbox(name: &str) -> Result<Option<String>, String> {
    let name = name.trim();
    if name.is_empty() {
        return Ok(None);
    }
    if name.chars().count() > MAX_INBOX {
        return Err(format!("{INBOX} must be at most {MAX_INBOX} characters."));
    }
    if name.chars().any(char::is_control) {
        return Err(format!("{INBOX} must not contain control characters."));
    }
    Ok(Some(name.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(change: Value) -> Result<Change, String> {
        Change::read(change.as_object().unwrap())
    }

    #[test]
    fn off_and_the_owner_by_default() {
        let values = values(&Store::default());
        assert_eq!(values[ESCALATION], "off");
        assert_eq!(values[INBOX], "");
        assert_eq!(values[STATUS], STATUS_TEXT);
        assert!(STATUS_TEXT
            .contains("Unavailable for interactive Codex, Cursor, Copilot, Grok and OpenCode"));
    }

    #[test]
    fn a_change_is_saved_and_read_back() {
        let mut store = Store::default();
        read(json!({ESCALATION: "on", INBOX: "  lead  "}))
            .unwrap()
            .apply(&mut store);
        let store: Store = serde_json::from_value(serde_json::to_value(&store).unwrap()).unwrap();
        let saved = values(&store);
        assert_eq!(saved[ESCALATION], "on");
        assert_eq!(saved[INBOX], "lead");
        for empty in ["", "   "] {
            let mut reset = store.clone();
            read(json!({INBOX: empty})).unwrap().apply(&mut reset);
            assert_eq!(reset.extras.question_escalation_inbox, None);
            assert_eq!(values(&reset)[INBOX], "");
            assert_eq!(values(&reset)[ESCALATION], "on", "untouched");
        }
        let mut off = store.clone();
        read(json!({ESCALATION: "off"})).unwrap().apply(&mut off);
        assert_eq!(values(&off)[ESCALATION], "off");
        assert_eq!(values(&off)[INBOX], "lead", "untouched");
    }

    #[test]
    fn invalid_values_are_refused() {
        for invalid in [
            json!(true),
            json!("ON"),
            json!("yes"),
            json!(null),
            json!(1),
        ] {
            assert!(read(json!({ESCALATION: invalid})).is_err(), "{invalid}");
        }
        assert!(read(json!({INBOX: 3})).is_err());
        assert!(read(json!({INBOX: null})).is_err());
        assert!(read(json!({INBOX: "a\u{7}b"})).is_err());
        assert!(read(json!({INBOX: "line\nbreak"})).is_err());
        assert!(read(json!({INBOX: "x".repeat(MAX_INBOX + 1)})).is_err());
        assert_eq!(
            read(json!({INBOX: "é".repeat(MAX_INBOX)})).unwrap().inbox,
            Some(Some("é".repeat(MAX_INBOX)))
        );
        assert!(read(json!({})).unwrap().is_empty());
    }
}
