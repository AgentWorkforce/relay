//! The session history setting's wording (`history_retention_days`), shared
//! with the Mac (`HistoryRetentionCopy`): how long this computer keeps
//! local session history, and the warning a short choice gets.

use crate::relay::history_retention::{CHOICES, DEFAULT_DAYS, FOREVER};

pub const HISTORY_RETENTION_SECTION: &str = "Session history";
pub const HISTORY_RETENTION_TITLE: &str = "Keep session history";
pub const HISTORY_RETENTION_DETAIL: &str = "How long this computer keeps the sessions Agent Relay finds. Older sessions are removed from this computer; copies already uploaded to your workspace are not affected.";

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

/// `7 days`, `30 days`: a choice as a span of time.
fn history_retention_span(days: u32) -> String {
    match days {
        1 => "1 day".to_string(),
        days => format!("{days} days"),
    }
}

/// The warning a choice gets when a session that has not uploaded by then
/// can be removed before it does: a choice shorter than the default, or
/// any limit while uploads are held (signed out or paused).
pub fn history_retention_warning(days: u32, uploads_held: bool) -> Option<String> {
    let span = history_retention_span(days);
    match days {
        FOREVER => None,
        _ if uploads_held => Some(format!(
            "While you’re signed out or uploads are paused, sessions that haven’t uploaded within {span} can be removed from this computer before they upload."
        )),
        days if days < DEFAULT_DAYS => Some(format!(
            "Sessions that haven’t uploaded within {span} can be removed from this computer before they upload, for example while you’re signed out or uploads are paused."
        )),
        _ => None,
    }
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
    fn a_short_choice_warns_and_any_limit_warns_while_uploads_are_held() {
        assert_eq!(
            history_retention_warning(7, false).as_deref(),
            Some("Sessions that haven’t uploaded within 7 days can be removed from this computer before they upload, for example while you’re signed out or uploads are paused.")
        );
        for days in [30, 90, FOREVER] {
            assert_eq!(history_retention_warning(days, false), None, "{days}");
        }
        assert_eq!(
            history_retention_warning(30, true).as_deref(),
            Some("While you’re signed out or uploads are paused, sessions that haven’t uploaded within 30 days can be removed from this computer before they upload.")
        );
        assert!(history_retention_warning(7, true).is_some());
        assert!(history_retention_warning(90, true).is_some());
        assert_eq!(history_retention_warning(FOREVER, true), None);
    }
}
