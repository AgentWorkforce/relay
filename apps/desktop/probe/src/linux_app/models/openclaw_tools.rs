//! The Settings row that gives the person's OpenClaw agents Agent Relay's
//! own tools (`openclaw.relay_tools.*`), shown below OpenClaw's row while
//! OpenClaw is on. The Mac's `OpenClawToolsCopy` matches these word for
//! word.

use crate::relay::contract::openclaw::{OpenClawToolsState, OpenClawToolsStatus};
use std::time::Duration;

pub const OPENCLAW_TOOLS_TITLE: &str = "Agent Relay tools";
pub const OPENCLAW_TOOLS_NOT_CONNECTED: &str = "Let your OpenClaw agents list agents on the relay, message them and spawn new ones. Messages from people who aren't trusted senders never get these tools.";
pub const OPENCLAW_TOOLS_WAITING: &str =
    "Approve Agent Relay in your browser to finish connecting.";
pub const OPENCLAW_TOOLS_CONNECTED: &str = "Your OpenClaw agents can use Agent Relay's tools. Messages from people who aren't trusted senders never get them.";
pub const OPENCLAW_TOOLS_CONNECT: &str = "Connect";
pub const OPENCLAW_TOOLS_OPEN_AGAIN: &str = "Open Again";

/// How often the row reads the status again while the browser is open.
pub const OPENCLAW_TOOLS_POLL_EVERY: Duration = Duration::from_secs(2);

/// The row's button.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OpenClawToolsAction {
    /// Primary: adds the server and opens the consent page.
    Connect,
    /// Secondary: opens the waiting login's consent page again.
    OpenAgain,
}

impl OpenClawToolsAction {
    pub fn label(self) -> &'static str {
        match self {
            OpenClawToolsAction::Connect => OPENCLAW_TOOLS_CONNECT,
            OpenClawToolsAction::OpenAgain => OPENCLAW_TOOLS_OPEN_AGAIN,
        }
    }
}

/// What the row shows for a status.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OpenClawToolsRow {
    pub detail: String,
    pub action: Option<OpenClawToolsAction>,
    /// Why the last sign-in failed, under the detail.
    pub error: Option<String>,
}

impl OpenClawToolsRow {
    pub fn new(status: &OpenClawToolsStatus) -> OpenClawToolsRow {
        let row = |detail: &str, action| OpenClawToolsRow {
            detail: detail.to_string(),
            action,
            error: None,
        };
        match &status.state {
            OpenClawToolsState::NotConnected => OpenClawToolsRow {
                error: status.detail.clone(),
                ..row(
                    OPENCLAW_TOOLS_NOT_CONNECTED,
                    Some(OpenClawToolsAction::Connect),
                )
            },
            OpenClawToolsState::Waiting => {
                row(OPENCLAW_TOOLS_WAITING, Some(OpenClawToolsAction::OpenAgain))
            }
            OpenClawToolsState::Connected => row(OPENCLAW_TOOLS_CONNECTED, None),
            OpenClawToolsState::Unavailable => {
                row(status.detail.as_deref().unwrap_or_default(), None)
            }
        }
    }
}

/// What the app holds for the row: the core's last answer, Connect's error,
/// and whether a Connect or a follow-up read is under way.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct OpenClawToolsView {
    pub status: Option<OpenClawToolsStatus>,
    pub error: Option<String>,
    pub connecting: bool,
    /// Connects asked for, so a status read asked before the latest one
    /// is dropped.
    pub connects: u64,
    /// A read is scheduled while the browser is open.
    pub polling: bool,
}

/// What the app holds for OpenClaw's rows: the error under OpenClaw's own
/// row (a failed `settings.set`), and the Agent Relay tools row.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct OpenClawView {
    pub error: Option<String>,
    pub tools: OpenClawToolsView,
}

/// Whether the row reads the status again: only while the browser is open.
pub fn openclaw_tools_polls(status: Option<&OpenClawToolsStatus>) -> bool {
    status.is_some_and(|status| status.state == OpenClawToolsState::Waiting)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status(state: OpenClawToolsState, detail: Option<&str>) -> OpenClawToolsStatus {
        OpenClawToolsStatus {
            state,
            detail: detail.map(str::to_string),
        }
    }

    #[test]
    fn the_wording_matches_the_mac() {
        assert_eq!(OPENCLAW_TOOLS_TITLE, "Agent Relay tools");
        assert_eq!(OPENCLAW_TOOLS_NOT_CONNECTED, "Let your OpenClaw agents list agents on the relay, message them and spawn new ones. Messages from people who aren't trusted senders never get these tools.");
        assert_eq!(
            OPENCLAW_TOOLS_WAITING,
            "Approve Agent Relay in your browser to finish connecting."
        );
        assert_eq!(OPENCLAW_TOOLS_CONNECTED, "Your OpenClaw agents can use Agent Relay's tools. Messages from people who aren't trusted senders never get them.");
        assert_eq!(OpenClawToolsAction::Connect.label(), "Connect");
        assert_eq!(OpenClawToolsAction::OpenAgain.label(), "Open Again");
    }

    #[test]
    fn each_state_has_its_detail_and_button() {
        let row = OpenClawToolsRow::new(&status(OpenClawToolsState::NotConnected, None));
        assert_eq!(row.detail, OPENCLAW_TOOLS_NOT_CONNECTED);
        assert_eq!(row.action, Some(OpenClawToolsAction::Connect));
        assert_eq!(row.error, None);
        let failed = "OpenClaw couldn't finish signing in. Try Connect again.";
        let row = OpenClawToolsRow::new(&status(OpenClawToolsState::NotConnected, Some(failed)));
        assert_eq!(row.error.as_deref(), Some(failed));
        let row = OpenClawToolsRow::new(&status(OpenClawToolsState::Waiting, None));
        assert_eq!(
            (row.detail.as_str(), row.action),
            (OPENCLAW_TOOLS_WAITING, Some(OpenClawToolsAction::OpenAgain))
        );
        let row = OpenClawToolsRow::new(&status(OpenClawToolsState::Connected, None));
        assert_eq!(
            (row.detail.as_str(), row.action),
            (OPENCLAW_TOOLS_CONNECTED, None)
        );
        let missing = "Agent Relay couldn't find OpenClaw's command-line tool on this computer.";
        let row = OpenClawToolsRow::new(&status(OpenClawToolsState::Unavailable, Some(missing)));
        assert_eq!((row.detail.as_str(), row.action), (missing, None));
    }

    #[test]
    fn only_a_waiting_login_is_polled() {
        assert!(openclaw_tools_polls(Some(&status(
            OpenClawToolsState::Waiting,
            None
        ))));
        assert!(!openclaw_tools_polls(Some(&status(
            OpenClawToolsState::Connected,
            None
        ))));
        assert!(!openclaw_tools_polls(None));
    }
}
