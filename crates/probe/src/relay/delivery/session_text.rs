//! The text a delivery puts into a session.

use super::policy::{injected_text, with_attachments, with_owner_line, Delivery};
#[cfg(test)]
use super::Retry;
use super::{DeliveryOutcome, DeliveryState};
use crate::relay::backoff::WorkspaceScope;
use crate::relay::daemon::Core;
use crate::relay::spawn::drive::OwnerReply;
use crate::relay::store::Registration;
use crate::relay::workspace::Secret;
use std::sync::{MutexGuard, PoisonError};
#[cfg(test)]
use std::time::{Duration, Instant};

/// Native transport does not itself convey the human owner's authority.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum InputSource {
    Peer,
    Owner,
    Requester,
    /// A teammate's direct message, started as a user turn by the
    /// session's own Claude plugin under the owner's binding
    /// (`teammate_native_input`).
    Teammate,
}

impl InputSource {
    /// Whether the session's Claude plugin submits the text as a user turn.
    fn mobile_turn(self) -> bool {
        matches!(self, InputSource::Owner | InputSource::Teammate)
    }
}

fn requester_native_input(enabled: bool, registration: &Registration, delivery: &Delivery) -> bool {
    enabled && crate::relay::spawn::from_requester(registration, delivery)
}

impl Core {
    /// Allows `message_id` as a reply parent before the prompt is handed
    /// over. Injection can return only after the session has already read
    /// the command, and `/send` rejects a parent that is not recorded yet.
    /// Allows a DM's reply before its prompt is handed over, and for a DM
    /// from the agent that spawned the session also queues the automatic
    /// answer now: a socket DM the session sends while injection is still
    /// running must find it to claim it, or the requester gets two answers.
    pub(super) fn authorize_dm_reply(&self, registration: &Registration, delivery: &Delivery) {
        let prefix = self.machine_prefix.clone();
        let _ = self.store.remember(|store| {
            let owner = store.reply_owner(registration).clone();
            if crate::relay::spawn::from_requester(&owner, delivery) {
                store.record_reply_opportunity(delivery, &owner, true, &prefix);
            } else {
                store.record_reply_route(&owner.agent_id, &delivery.message_id);
            }
        });
    }

    pub(super) fn authorize_reply_parent(&self, registration: &Registration, message_id: &str) {
        let _ = self.store.remember(|store| {
            let owner = store.reply_owner(registration).agent_id.clone();
            store.record_reply_route(&owner, message_id);
        });
    }

    /// A prompt that certainly never arrived must not stay replyable.
    pub(super) fn revoke_reply_parent(&self, registration: &Registration, message_id: &str) {
        let _ = self.store.remember(|store| {
            let owner = store.reply_owner(registration).agent_id.clone();
            store.forget_reply_route(&owner, message_id);
            // Nor may an automatic answer queued for it before injection.
            if let Some(replies) = store.replies.as_mut() {
                replies.retain(|r| {
                    r.agent_id != owner || r.message_id != message_id || r.claimed.is_some()
                });
            }
        });
    }

    pub(crate) async fn deliver_session_text(
        &self,
        registration: &Registration,
        delivery: &Delivery,
        text: String,
        source: InputSource,
    ) -> crate::relay::inject::InjectOutcome {
        use crate::relay::inject::{DeliveryRoute, InjectOutcome};
        if let Some(reason) = super::policy::sent_before_clear(registration.cleared, delivery) {
            return InjectOutcome::Refused(reason);
        }
        if let Some(outcome) = self
            .previous_mobile_delivery(registration, delivery, source.mobile_turn())
            .await
        {
            return outcome;
        }
        if source.mobile_turn() && self.mobile_handoff_enabled(registration) {
            return self
                .deliver_mobile_turn(registration, delivery, &text, source == InputSource::Owner)
                .await;
        }
        if source == InputSource::Owner && crate::relay::native_continuation::eligible(registration)
        {
            return self
                .deliver_native_continuation(registration, delivery, text)
                .await;
        }
        if source == InputSource::Peer {
            if let Some(outcome) = self
                .native_continuation_peer_guard(registration, delivery)
                .await
            {
                return outcome;
            }
        }
        let injector = self.plugins.injector.clone();
        let spawner = self.plugins.spawner.clone();
        let registered = registration.clone();
        let routed = delivery.clone();
        tokio::task::spawn_blocking(move || {
            // A teammate's turn that lost its plugin between classification
            // and delivery goes the peer way, as its text already says.
            let native = matches!(source, InputSource::Owner | InputSource::Requester);
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

    /// Whether `delivery` is a teammate's direct message that the session's
    /// Claude plugin starts as a user turn: the setting is on unless turned
    /// off, the sender is identified, the session's plugin has polled
    /// recently (installed files alone prove nothing about a session opened
    /// before them, whose message would otherwise wait out a lease and be
    /// refused instead of reaching the peer inbox), and the session has a
    /// verified owner whose binding carries the turn. The owner's own
    /// messages are classified before this; a channel post or mention is
    /// never one. It never conveys the owner's permission authority.
    async fn teammate_native_turn(&self, registration: &Registration, delivery: &Delivery) -> bool {
        self.store.read(|store| store.teammate_native_input_on())
            && crate::relay::spawn::drive::direct_from(delivery, delivery.sender_id.as_deref())
            && self.mobile_claude_plugins.plugin_seen(&registration.target)
            && self.mobile_handoff_binding(registration).await.is_some()
    }

    /// Requester input is on unless turned off, and never conveys human permission authority.
    fn spawner_native_turn(&self, registration: &Registration, delivery: &Delivery) -> bool {
        requester_native_input(
            self.store
                .read(|store| store.extras.spawn_native_input != Some(false)),
            registration,
            delivery,
        ) && self.plugins.spawner.native_input(&registration.target)
    }

    /// The text for `delivery` (as `saved`, with its attachments saved,
    /// when they were), the reply hint in it, and whether it is a native
    /// turn (`DeliveryRoute::native`). The verified owner's
    /// message is a plain user turn, as they wrote it; everyone else's, the
    /// spawn's requester unless opted in, keeps the attribution, the reply
    /// hint and the host's note. Opted-in requester input retains reply
    /// context, as does a teammate's direct message that the session's
    /// Claude plugin starts as a user turn. The requester's other direct
    /// messages (`spawn::from_requester`) also carry `policy::OWNER_LINE`
    /// under their attribution; everyone else's is a peer's.
    pub(crate) async fn session_text(
        &self,
        registration: &Registration,
        (delivery, saved): (&Delivery, Option<&Delivery>),
        via_webhook: bool,
        via_integration: bool,
    ) -> (String, Option<String>, InputSource) {
        // A spawned agent's requests are relayed from its first delivery on.
        self.watch_spawned(registration);
        let message = saved.unwrap_or(delivery);
        if self.owner_native_turn(registration, delivery).await {
            let text = with_attachments(
                message.text.clone().unwrap_or_default(),
                &message.attachments,
            );
            return (text, None, InputSource::Owner);
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
        let native =
            !via_webhook && !via_integration && self.spawner_native_turn(registration, delivery);
        let teammate = !native
            && !via_webhook
            && !via_integration
            && self.teammate_native_turn(registration, delivery).await;
        let text = injected_text(message, &registration.name, via_webhook, lines.as_deref());
        let text = if native || teammate {
            text.replacen(
                "[via Agent Relay — from ",
                "[Agent Relay native input — from ",
                1,
            )
        } else if !via_webhook
            && !via_integration
            && crate::relay::spawn::from_requester(registration, delivery)
        {
            with_owner_line(&text)
        } else {
            text
        };
        let source = if native {
            InputSource::Requester
        } else if teammate {
            InputSource::Teammate
        } else {
            InputSource::Peer
        };
        (text, hint, source)
    }

    /// The delivery state for a native receipt, still usable after a thread
    /// panicked holding it: dropping a retry early only reads the queue
    /// sooner, and every read settles a delivery at most once.
    fn receipt_state(&self) -> MutexGuard<'_, DeliveryState> {
        self.delivery.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// A session's own queue (the mobile Claude handoff) settled
    /// `delivery_id`: read its agent's queue now rather than after the
    /// waiting retry, so the sender's receipt follows the outcome. A delivery
    /// with no pending retry is left alone.
    pub(crate) fn settle_delivery_soon(&self, delivery_id: &str) {
        let retry = self.receipt_state().retries.remove(delivery_id);
        if let Some(retry) = retry {
            self.request_drain(&retry.agent);
        }
    }

    /// Schedules the retry a `Waiting` outcome leaves behind.
    #[cfg(test)]
    pub(crate) fn hold_delivery_retry(&self, delivery_id: &str, agent: &str, delay: Duration) {
        self.receipt_state().retries.insert(
            delivery_id.into(),
            Retry {
                agent: agent.into(),
                after: Instant::now() + delay,
                failures: 0,
            },
        );
    }

    #[cfg(test)]
    pub(crate) fn delivery_retry_pending(&self, delivery_id: &str) -> bool {
        self.receipt_state().retries.contains_key(delivery_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn spawner_input_requires_opt_in_verified_id_and_a_direct_headless_session() {
        let mut registration: Registration = serde_json::from_value(json!({
            "name":"child", "agentID":"child-id", "target":{"kind":"codex","id":"thread"},
            "title":"child", "baseURL":"http://127.0.0.1", "registeredAt":"now",
            "spawn":{"nodeID":"node", "nodeName":"desktop", "invocationID":"inv", "harness":"codex",
                "requester":{"name":"parent","agentID":"parent-id"}}
        }))
        .unwrap();
        let mut message = Delivery {
            reason: Some("dm".into()),
            sender: Some("parent".into()),
            sender_id: Some("parent-id".into()),
            ..Delivery::default()
        };
        assert!(!requester_native_input(false, &registration, &message));
        assert!(requester_native_input(true, &registration, &message));
        message.sender = Some("renamed-parent".into());
        assert!(requester_native_input(true, &registration, &message));
        message.sender_id = Some("impostor-id".into());
        message.sender = Some("parent".into());
        assert!(!requester_native_input(true, &registration, &message));
        message.sender_id = None;
        assert!(!requester_native_input(true, &registration, &message));
        message.sender_id = Some("parent-id".into());
        message.channel_id = Some("group".into());
        assert!(!requester_native_input(true, &registration, &message));
        message.channel_id = None;
        message.reason = Some("mention".into());
        assert!(!requester_native_input(true, &registration, &message));
        message.reason = Some("dm".into());
        registration.spawn.as_mut().unwrap().taken_over_at = Some("now".into());
        assert!(!requester_native_input(true, &registration, &message));
        registration.spawn.as_mut().unwrap().taken_over_at = None;
        registration.spawn.as_mut().unwrap().requester = None;
        assert!(!requester_native_input(true, &registration, &message));
        registration.spawn = None;
        assert!(!requester_native_input(true, &registration, &message));
    }
}

#[cfg(all(test, unix))]
#[path = "session_text/source_tests.rs"]
mod source_tests;
