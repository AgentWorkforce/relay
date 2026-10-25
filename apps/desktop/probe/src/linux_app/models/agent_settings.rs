//! Settings → Relay's rows for agent-wide settings: whether new agents join
//! #general (`auto_join_general`) and the settings agents changed on the
//! session socket (`agent_changes`). The Mac's `AutoJoinGeneral` and
//! `AgentSettingsChanges` match these word for word.

use super::time::dated_clock;
use crate::relay::contract::agents::AgentSettingsChange;
use chrono::TimeZone;
use std::fmt::Display;

/// `auto_join_general`: off unless turned on, so agents stay out of
/// #general and are reached by direct message.
pub const AUTO_JOIN_GENERAL_TITLE: &str = "New agents join #general";
pub const AUTO_JOIN_GENERAL_DETAIL: &str = "Agents you put on the relay are reached by direct message. Turn this on to have each agent put on the relay from now on join #general and get its posts.";
pub const AUTO_JOIN_GENERAL_JOINED_DETAIL: &str = "Each agent put on the relay from now on joins #general and gets its posts. Agents already on the relay keep the channels they are in.";
pub const AUTO_JOIN_GENERAL_TURN_ON_HELP: &str =
    "Have agents put on the relay from now on join #general";
pub const AUTO_JOIN_GENERAL_TURN_OFF_HELP: &str =
    "Keep agents put on the relay from now on out of #general";

/// The record of settings agents changed.
pub const AGENT_CHANGES_TITLE: &str = "Changed by agents";
pub const AGENT_CHANGES_DETAIL: &str = "Agents on this computer can read and change these settings (GET and PATCH /settings on the session socket). Each change they make is listed here.";

/// One change as Settings lists it: who changed which setting from what to
/// what.
pub fn agent_change_line(change: &AgentSettingsChange) -> String {
    let from = change.from.as_deref().unwrap_or("unset");
    format!(
        "{} changed {} from {from} to {}",
        change.by, change.key, change.to
    )
}

/// When, as the local clock reads it; `None` for a time that does not
/// parse.
pub fn agent_change_time<Tz: TimeZone>(change: &AgentSettingsChange, zone: &Tz) -> Option<String>
where
    Tz::Offset: Display,
{
    let at = chrono::DateTime::parse_from_rfc3339(&change.at).ok()?;
    dated_clock(Some(at.timestamp_millis()), zone)
}

#[cfg(test)]
mod tests {
    use super::super::time::tests::zone;
    use super::*;

    fn change(from: Option<&str>) -> AgentSettingsChange {
        AgentSettingsChange {
            at: "2026-10-16T12:02:00Z".into(),
            by: "api".into(),
            key: "auto_join_general".into(),
            from: from.map(str::to_string),
            to: "true".into(),
        }
    }

    #[test]
    fn a_change_names_the_agent_the_setting_and_both_values() {
        assert_eq!(
            agent_change_line(&change(Some("false"))),
            "api changed auto_join_general from false to true"
        );
        assert_eq!(
            agent_change_line(&change(None)),
            "api changed auto_join_general from unset to true"
        );
    }

    #[test]
    fn a_change_is_dated_in_the_local_zone() {
        assert_eq!(
            agent_change_time(&change(None), &zone()).as_deref(),
            Some("Oct 16 2026, 14:02")
        );
        let mut garbled = change(None);
        garbled.at = "yesterday".into();
        assert_eq!(agent_change_time(&garbled, &zone()), None);
    }
}
