//! The text a delivery puts into a session.

use super::policy::{injected_text, with_attachments, Delivery};
use super::DeliveryOutcome;
use crate::relay::backoff::WorkspaceScope;
use crate::relay::daemon::Core;
use crate::relay::spawn::drive::OwnerReply;
use crate::relay::store::Registration;
use crate::relay::workspace::Secret;

impl Core {
    pub(super) async fn deliver_session_text(
        &self,
        registration: &Registration,
        delivery: &Delivery,
        text: String,
        native: bool,
    ) -> crate::relay::inject::InjectOutcome {
        use crate::relay::inject::{DeliveryRoute, InjectOutcome};
        if let Some(outcome) = self
            .previous_mobile_delivery(registration, delivery, native)
            .await
        {
            return outcome;
        }
        if native && self.mobile_handoff_enabled(registration) {
            return self
                .deliver_mobile_owner(registration, delivery, &text)
                .await;
        }
        let injector = self.plugins.injector.clone();
        let spawner = self.plugins.spawner.clone();
        let registered = registration.clone();
        let routed = delivery.clone();
        tokio::task::spawn_blocking(move || {
            let route = DeliveryRoute::of(&routed).native(native);
            spawner.deliver_registered(&*injector, &registered, &route, &text)
        })
        .await
        .unwrap_or_else(|_| InjectOutcome::InDoubt("the injection stopped unexpectedly".into()))
    }

    /// Whether `delivery` was the owner's reply to a pending Codex or Claude
    /// request, or a message to a spawned Claude that has ended, settled
    /// (acknowledged and recorded) or left for the next pass when its record
    /// could not be saved.
    pub(super) async fn took_owner_reply(
        &self,
        registration: &Registration,
        delivery: &Delivery,
        (workspace, base, token): (&WorkspaceScope, &str, &Secret),
    ) -> bool {
        let detail = match self.owner_reply(registration, delivery).await {
            OwnerReply::NotOne => match self.ended_claude(registration, delivery).await {
                OwnerReply::NotOne => return false,
                OwnerReply::Unsaved => return true,
                OwnerReply::Settled(detail) => detail,
            },
            OwnerReply::Unsaved => return true,
            OwnerReply::Settled(detail) => detail,
        };
        let _ = self
            .relaycast_ack(workspace, base, token, &delivery.id)
            .await;
        self.record(
            registration,
            delivery,
            DeliveryOutcome::Skipped,
            Some(detail),
        );
        true
    }

    /// The text for `delivery` (as `saved`, with its attachments saved,
    /// when they were), the reply hint in it, and whether it is a native
    /// turn (`DeliveryRoute::native`). The verified owner's
    /// message is a plain user turn, as they wrote it; everyone else's, the
    /// spawn's requester included, keeps peer framing, the reply hint and
    /// the host's note.
    pub(super) async fn session_text(
        &self,
        registration: &Registration,
        (delivery, saved): (&Delivery, Option<&Delivery>),
        via_webhook: bool,
        via_integration: bool,
    ) -> (String, Option<String>, bool) {
        // A spawned agent's requests are relayed from its first delivery on.
        self.watch_spawned(registration);
        let message = saved.unwrap_or(delivery);
        if self.owner_native_turn(registration, delivery).await {
            let text = with_attachments(
                message.text.clone().unwrap_or_default(),
                &message.attachments,
            );
            return (text, None, true);
        }
        let hint = if via_webhook || via_integration {
            None
        } else {
            self.dm_reply_lines(registration, delivery).await
        };
        // The app the session runs in may not show relayed messages to the
        // person; its note follows the reply hint, outside the sender's text.
        let (target, injector) = (registration.target.clone(), self.plugins.injector.clone());
        let note = tokio::task::spawn_blocking(move || injector.host_note(&target))
            .await
            .ok()
            .flatten();
        // Only the reply hint means the session answers by itself; the note
        // is not one, so it leaves the automatic answer on.
        let lines = match (hint.as_deref(), note) {
            (Some(hint), Some(note)) => Some(format!("{hint}\n{note}")),
            (hint, note) => hint.map(str::to_string).or(note),
        };
        let text = injected_text(message, &registration.name, via_webhook, lines.as_deref());
        (text, hint, false)
    }
}
