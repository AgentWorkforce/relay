//! Sharing and managed-setting policy decisions for the setup routes.
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
    pub(super) fn prompt_to_join_allowed(&self) -> bool {
        // The attached install is updated synchronously when sharing changes.
        // Unknown policy must not make an automatic-sharing session ask to join.
        self.core
            .plugins
            .account
            .as_ref()
            .and_then(|account| account.uploader().install())
            .and_then(|install| install.sharing_mode)
            .map(|mode| mode.as_str().to_string())
            .or_else(|| self.uploader.sharing_mode())
            .as_deref()
            == Some("selected")
    }
}
