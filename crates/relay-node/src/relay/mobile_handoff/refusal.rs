//! Only known provider reasons cross the bridge. Raw hook errors may contain
//! prompt text or local paths and must never become a sender-visible notice.
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Refusal {
    Stopped,
    HostEnded,
    TurnLimit,
    BudgetLimit,
}

impl Refusal {
    pub(crate) fn notice(self) -> &'static str {
        match self {
            Self::Stopped => "Claude was stopped. Send a message in Claude on your computer to resume it, then send this message again. This message was not submitted.",
            Self::HostEnded => "Claude's host closed its input. Reopen the session in its app, then send this message again. This message was not submitted.",
            Self::TurnLimit => "Claude reached its host's turn limit. Start a new run in its app, then send this message again. This message was not submitted.",
            Self::BudgetLimit => "Claude reached its host's spending limit. Check the limit in its app before sending again. This message was not submitted.",
        }
    }
}
