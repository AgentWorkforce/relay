//! Join-prompt and managed-setting decisions for the setup routes.
use super::Setup;
use crate::relay::outbound::OutboundError;

pub(super) fn managed_policy() -> OutboundError {
    OutboundError::new(
        409,
        "managed_policy",
        "Managed Claude settings do not allow direct delivery.",
    )
}

impl Setup {
    /// Whether the SessionStart hook may ask a chat that is not on the relay
    /// to join: the session policy says, and without an answer it does not.
    pub(super) fn prompt_to_join_allowed(&self) -> bool {
        self.core
            .plugins
            .session_policy
            .as_ref()
            .and_then(|policy| policy.may_ask_to_join())
            .unwrap_or(false)
    }
}
