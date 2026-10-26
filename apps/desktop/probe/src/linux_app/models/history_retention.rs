//! The session history setting's wording (`history_retention_days`), shared
//! with the Mac (`HistoryRetentionCopy`): the disabled preview shown until
//! relayhistory can enforce a retention choice.

use crate::relay::history_retention::{CHOICES, DEFAULT_DAYS, FOREVER};

pub const HISTORY_RETENTION_SECTION: &str = "Session history";
pub const HISTORY_RETENTION_TITLE: &str = "Keep session history (coming soon)";
pub const HISTORY_RETENTION_DETAIL: &str = "Automatic history removal is not available yet. Agent Relay keeps local session history until you remove it yourself.";

/// The choices Settings offers, in order, with their labels.
pub fn history_retention_choices() -> Vec<(u32, String)> {
    CHOICES
        .into_iter()
        .map(|days| (days, history_retention_label(days)))
        .collect()
}

/// `7 days`, `30 days (default)`, `Forever`.
pub fn history_retention_label(days: u32) -> String {
    match days {
        FOREVER => "Forever".to_string(),
        DEFAULT_DAYS => format!("{days} days (default)"),
        1 => "1 day".to_string(),
        days => format!("{days} days"),
    }
}

/// No deletion warning is shown until relayhistory enforces this setting.
pub fn history_retention_warning(_days: u32, _uploads_held: bool) -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn choices_read_as_the_mac_reads_them() {
        let labels: Vec<String> = history_retention_choices()
            .into_iter()
            .map(|(_, label)| label)
            .collect();
        assert_eq!(
            labels,
            ["7 days", "30 days (default)", "90 days", "Forever"]
        );
    }

    #[test]
    fn no_choice_promises_deletion_before_relayhistory_enforces_it() {
        for days in [7, 30, 90, FOREVER] {
            assert_eq!(history_retention_warning(days, false), None, "{days}");
            assert_eq!(history_retention_warning(days, true), None, "{days}");
        }
    }
}
