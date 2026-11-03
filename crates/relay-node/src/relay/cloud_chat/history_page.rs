//! One page of a session's uploaded history, as Cloud's history route
//! sends it.

use super::HistoryEvent;
use crate::relay::contract::plan::HistoryRetention;
use serde::Deserialize;
use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEventsPage {
    pub events: Vec<HistoryEvent>,
    pub next_cursor: Option<String>,
    /// `{"days","cutoff"}` when the plan's retention truncated the history;
    /// absent otherwise and on older servers.
    #[serde(default)]
    pub retention: Option<Value>,
}

impl HistoryEventsPage {
    /// The retention notice the page carries, when it is well formed.
    pub fn retention(&self) -> Option<HistoryRetention> {
        self.retention.as_ref().and_then(HistoryRetention::parse)
    }
}
