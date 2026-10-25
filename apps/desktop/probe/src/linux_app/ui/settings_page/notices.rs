//! Workspace and integration failures shown under Settings → Relay.
use super::*;
use crate::relay::state::AgentsStatus;

pub(super) fn workspace_notices(
    agents: AgentsStatus,
    connect_error: Option<String>,
) -> Vec<gtk::Widget> {
    [
        (connect_error, Tone::Error),
        (agents.store_error, Tone::Error),
        (agents.integration_error, Tone::Warn),
        (agents.delivery_error, Tone::Warn),
    ]
    .into_iter()
    .filter_map(|(message, tone)| message.map(|message| notice(&message, tone)))
    .collect()
}
