//! Native owner input for provider adapters with explicit runtime support.
//! Capability is independent of remote approvals: existing provider policy
//! and approval ownership remain unchanged. Never upgrade peer attribution.

use crate::relay::cloud_session::CloudAccount;
use crate::relay::daemon::Core;
use crate::relay::delivery::policy::Delivery;
use crate::relay::inject::{DeliveryRoute, InjectOutcome};
use crate::relay::spawn::drive::direct_from;
use crate::relay::store::{Registration, SessionKind};

mod capabilities;
pub(crate) use capabilities::Capabilities;

pub(crate) fn supported() -> bool {
    cfg!(unix)
}

pub(crate) fn eligible(registration: &Registration) -> bool {
    registration.target.kind == SessionKind::OpenCode
        || (matches!(
            registration.target.kind,
            SessionKind::Pi | SessionKind::OpenCodeOpen | SessionKind::Codex
        ) && registration
            .spawn
            .as_ref()
            .is_none_or(|spawn| spawn.taken_over_at.is_some()))
}

impl Core {
    pub(crate) fn native_continuation_account(&self) -> Option<CloudAccount> {
        self.plugins
            .cloud
            .account()
            .filter(|account| account.user_id.as_ref().is_some_and(|id| !id.is_empty()))
    }

    pub(crate) fn native_account_current(&self, expected: &CloudAccount) -> bool {
        self.native_continuation_account().as_ref() == Some(expected)
    }

    // Only called on a blocking thread: the provider directory can read
    // kernel/process evidence. A managed route belongs to its original owner.
    fn native_managed_binding_current(&self, registration: &Registration) -> bool {
        if registration.target.kind != SessionKind::OpenCode {
            return true;
        }
        let Some(workspace_id) = self.verified_workspace_id() else {
            return false;
        };
        let Some(owner) = self.agent_owner() else {
            return false;
        };
        self.plugins
            .sessions
            .managed_authority(&registration.target)
            .as_ref()
            == Some(&crate::relay::managed_sessions::ManagedAuthority {
                workspace_id,
                owner_id: owner.user_id,
                owner_uid: crate::relay::peer::current_uid(),
            })
    }
    pub(crate) fn require_native_continuation_claim(&self) -> Result<(), String> {
        if !supported() {
            return Err("Native mobile continuation is not available on this platform yet.".into());
        }
        self.require_mobile_claude_owner_claim()
    }

    pub(crate) fn native_continuation_registration(
        &self,
        registration: &Registration,
    ) -> Option<Registration> {
        if self.require_native_continuation_claim().is_err()
            || !eligible(registration)
            || !self
                .store
                .read(|store| store.mobile_native_continuation_on())
        {
            return None;
        }
        let workspace = self.workspace()?;
        let canonical = self.mobile_handoff_registration(registration)?;
        (eligible(&canonical)
            && workspace.base_url == canonical.base_url
            && canonical.workspace_key.as_ref() == Some(&workspace.key))
        .then_some(canonical)
    }

    pub(crate) async fn native_continuation_capable(&self, registration: &Registration) -> bool {
        let Some(account) = self.native_continuation_account() else {
            return false;
        };
        let Some(registration) = self.native_continuation_registration(registration) else {
            return false;
        };
        let injector = self.plugins.injector.clone();
        let Some(core) = self.arc() else {
            return false;
        };
        let expected = registration.clone();
        let capable = tokio::task::spawn_blocking(move || {
            core.native_managed_binding_current(&registration)
                && injector.native_continuation(&registration)
        })
        .await
        .unwrap_or(false);
        capable
            && self.native_account_current(&account)
            && self.native_continuation_registration(&expected).as_ref() == Some(&expected)
    }

    async fn native_continuation_route(
        &self,
        registration: &Registration,
        delivery: &Delivery,
    ) -> bool {
        let Some(canonical) = self.native_continuation_registration(registration) else {
            return false;
        };
        let injector = self.plugins.injector.clone();
        let delivery = delivery.clone();
        let reserved = tokio::task::spawn_blocking(move || {
            injector.native_continuation_reserved(&canonical, &DeliveryRoute::of(&delivery))
        })
        .await
        .unwrap_or(false);
        reserved || self.native_continuation_capable(registration).await
    }

    pub(crate) async fn native_continuation_owner_turn(
        &self,
        registration: &Registration,
        delivery: &Delivery,
    ) -> bool {
        let Some(account) = self.native_continuation_account() else {
            return false;
        };
        if !direct_from(delivery, delivery.sender_id.as_deref())
            || !self.native_continuation_route(registration, delivery).await
        {
            return false;
        }
        let Some(canonical) = self.native_continuation_registration(registration) else {
            return false;
        };
        let Some((_, owner)) = self.verified_owner(&canonical).await else {
            return false;
        };
        direct_from(delivery, Some(&owner))
            && self.native_account_current(&account)
            && self.native_continuation_registration(registration).as_ref() == Some(&canonical)
    }

    pub(crate) async fn deliver_native_continuation(
        &self,
        registration: &Registration,
        delivery: &Delivery,
        text: String,
    ) -> InjectOutcome {
        let Some(account) = self.native_continuation_account() else {
            return InjectOutcome::Refused("Sign in to continue this session from mobile.".into());
        };
        let Some(canonical) = self.native_continuation_registration(registration) else {
            return InjectOutcome::Refused(
                "Native mobile continuation was disabled or its session changed.".into(),
            );
        };
        let Some((_, owner)) = self.verified_owner(&canonical).await else {
            return InjectOutcome::Waiting("Waiting to verify the signed-in machine owner.".into());
        };
        if !direct_from(delivery, Some(&owner))
            || !self.native_account_current(&account)
            || self.native_continuation_registration(registration).as_ref() != Some(&canonical)
        {
            return InjectOutcome::Refused(
                "The native message no longer belongs to the verified owner and session.".into(),
            );
        }
        let injector = self.plugins.injector.clone();
        let delivery = delivery.clone();
        let Some(core) = self.arc() else {
            return InjectOutcome::Refused("Native continuation is stopping.".into());
        };
        let engagement = (
            account.clone(),
            canonical.clone(),
            owner,
            delivery.message_id.clone(),
        );
        let outcome = tokio::task::spawn_blocking(move || {
            if !core.native_account_current(&account)
                || core.native_continuation_registration(&canonical).as_ref() != Some(&canonical)
                || !core.native_managed_binding_current(&canonical)
            {
                return InjectOutcome::Refused(
                    "Native continuation authority changed before submission.".into(),
                );
            }
            // Adapter revalidates its pinned runtime and durable receipt. It
            // must never fall back to a different route or peer submission.
            injector.inject_native(
                &canonical,
                &DeliveryRoute::of(&delivery).native(true),
                &text,
                &|| {
                    core.native_managed_binding_current(&canonical)
                        && core.native_account_current(&account)
                        && core.native_continuation_registration(&canonical).as_ref()
                            == Some(&canonical)
                },
            )
        })
        .await
        .unwrap_or_else(|_| {
            InjectOutcome::InDoubt(
                "Native delivery stopped unexpectedly; it will not be replayed.".into(),
            )
        });
        if outcome == InjectOutcome::Delivered {
            self.engage_codex_mobile(engagement.0, engagement.1, engagement.2, engagement.3);
        }
        outcome
    }

    /// A transient owner lookup must not silently downgrade an opted-in
    /// owner's message to peer text. A proven different sender stays a peer.
    pub(crate) async fn native_continuation_peer_guard(
        &self,
        registration: &Registration,
        delivery: &Delivery,
    ) -> Option<InjectOutcome> {
        if !direct_from(delivery, delivery.sender_id.as_deref())
            || !self.native_continuation_route(registration, delivery).await
        {
            return None;
        }
        let canonical = self.native_continuation_registration(registration)?;
        match self.verified_owner(&canonical).await {
            None => Some(InjectOutcome::Waiting(
                "Waiting to verify the signed-in machine owner.".into(),
            )),
            Some((_, owner)) if direct_from(delivery, Some(&owner)) => {
                Some(InjectOutcome::Waiting(
                    "Native session verification changed; waiting to retry the original message."
                        .into(),
                ))
            }
            Some(_) => None,
        }
    }

    pub(crate) fn native_continuation_setting_changed(&self) {
        self.withdraw_codex_mobile();
        self.delivery
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .native_continuation_capabilities
            .invalidate();
        let registrations = self.store.read(|store| store.registrations.clone());
        for registration in registrations.iter().filter(|r| eligible(r)) {
            self.mobile_handoff_changed(registration);
        }
    }
}

#[cfg(test)]
mod tests;
