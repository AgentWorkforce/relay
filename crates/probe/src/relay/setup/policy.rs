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
        let installed = self
            .core
            .plugins
            .account
            .as_ref()
            .and_then(|account| account.uploader().install())
            .and_then(|install| install.sharing_mode)
            .map(|mode| mode.as_str().to_string());
        prompt_allowed(installed, || self.uploader.sharing_mode())
    }
}

/// Whether the SessionStart hook may ask an unregistered chat to join: only
/// when the install shares the sessions the person selects. The attached
/// install, updated synchronously when sharing changes, decides first, then
/// the last `uploader.status` answer. An unknown policy must not make an
/// automatic-sharing session ask to join, so it answers no.
fn prompt_allowed(installed: Option<String>, cached: impl FnOnce() -> Option<String>) -> bool {
    installed.or_else(cached).as_deref() == Some("selected")
}

#[cfg(test)]
mod tests {
    use super::prompt_allowed;

    #[test]
    fn only_selected_sharing_asks_a_chat_to_join() {
        let some = |mode: &str| Some(mode.to_string());
        // The attached install outranks a stale cached answer.
        assert!(prompt_allowed(some("selected"), || some("all")));
        assert!(!prompt_allowed(some("all"), || some("selected")));
        assert!(!prompt_allowed(some("new"), || None));
        // With no install, the cached answer decides.
        assert!(prompt_allowed(None, || some("selected")));
        // Nothing known: no prompt.
        assert!(!prompt_allowed(None, || None));
    }
}
