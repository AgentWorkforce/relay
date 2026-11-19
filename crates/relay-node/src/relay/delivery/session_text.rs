//! The text a delivery puts into a session.

use super::policy::{injected_text, with_attachments, with_leader_line, with_owner_line, Delivery};
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

/// Why a delivery admitted before the organization's hold began waits.
pub(crate) const HELD_SINCE: &str =
    "Your organization started holding messages from senders who are not its admins; this one waits for your approval.";

/// Native transport does not itself convey the human owner's authority.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum InputSource {
    Peer,
    Owner,
    Requester,
    /// A teammate's direct message, started as a user turn by the
    /// session's own Claude plugin under the owner's binding
    /// (`teammate_native_input`), or a workspace leader's taken that way by
    /// a session the person started.
    Teammate,
    /// A workspace leader's direct message (`relay::leaders`) to a spawned
    /// agent, native input through the spawn's harness while
    /// `spawn_native_input` is on. Never an approval.
    Leader,
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

    /// The hand-over gate: `Waiting` when an organization hold that began
    /// after this delivery was admitted now holds it, so it stays queued and
    /// the next pass holds it for the person's approval like any held
    /// message. Called at each real hand-over point, with no await between
    /// it and the hand-over: the ordinary route's and native continuation's
    /// blocking closures, right before the route is called, and right before
    /// the mobile journal takes the turn.
    pub(crate) fn hand_over_held(
        &self,
        registration: &Registration,
        delivery: &Delivery,
    ) -> Option<crate::relay::inject::InjectOutcome> {
        self.organization_now_holds(registration, delivery)
            .then(|| crate::relay::inject::InjectOutcome::Waiting(HELD_SINCE.into()))
    }

    /// Whether an organization hold that began after this delivery was
    /// admitted now holds it.
    fn organization_now_holds(&self, registration: &Registration, delivery: &Delivery) -> bool {
        self.claude_delivery.organization_holds()
            && matches!(
                self.claude_delivery.decide(registration, delivery),
                crate::relay::claude_delivery_policy::Decision::Hold
                    | crate::relay::claude_delivery_policy::Decision::ReadQueue
            )
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
        if self.organization_now_holds(registration, delivery) {
            return InjectOutcome::Waiting(HELD_SINCE.into());
        }
        if let Some(outcome) = self
            .previous_mobile_delivery(registration, delivery, source.mobile_turn())
            .await
        {
            // Its pointer is already queued; keeping the text again on each
            // retry keeps `read` working however long the turn waits.
            if source == InputSource::Teammate && matches!(outcome, InjectOutcome::Waiting(_)) {
                let _ = self.native_turn_text(registration, delivery, text).await;
            }
            return outcome;
        }
        if source.mobile_turn() && self.mobile_handoff_enabled(registration) {
            // A teammate's turn shows the same pointer a peer message does;
            // the person's own message is theirs, and shows whole.
            let text = if source == InputSource::Owner {
                text
            } else {
                self.native_turn_text(registration, delivery, text).await
            };
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
        if matches!(source, InputSource::Peer | InputSource::Leader) {
            if let Some(outcome) = self
                .native_continuation_peer_guard(registration, delivery)
                .await
            {
                return outcome;
            }
        }
        let injector = self.plugins.injector.clone();
        let spawner = self.plugins.spawner.clone();
        let Some(registered) = self
            .store
            .read(|store| crate::relay::copilot::delivery_registration(store, registration))
        else {
            return InjectOutcome::InDoubt(
                "The Copilot registration changed before delivery.".into(),
            );
        };
        let Some(core) = self.arc() else {
            return InjectOutcome::Waiting("Agent Relay is stopping.".into());
        };
        let routed = delivery.clone();
        let held = registration.clone();
        // A leader's turn that lost its plugin goes the peer way, so its
        // text drops the leader framing that only a native turn carries.
        let text = match source {
            InputSource::Teammate => super::policy::without_leader_line(&text),
            _ => text,
        };
        tokio::task::spawn_blocking(move || {
            // The hand-over gate, on the thread that hands it over: a hold
            // that began while this waited for a blocking thread holds it.
            if let Some(waiting) = core.hand_over_held(&held, &routed) {
                return waiting;
            }
            // A teammate's turn that lost its plugin between classification
            // and delivery goes the peer way, as its text already says.
            let native = matches!(
                source,
                InputSource::Owner | InputSource::Requester | InputSource::Leader
            );
            let route = DeliveryRoute::of(&routed).native(native);
            spawner.deliver_registered(&*injector, &registered, &route, &text)
        })
        .await
        .unwrap_or_else(|_| InjectOutcome::InDoubt("the injection stopped unexpectedly".into()))
    }

    /// The pointer a native turn shows for relayed `text`, with the text
    /// kept for `read` (`Injector::native_pointer`), else `text`.
    async fn native_turn_text(
        &self,
        registration: &Registration,
        delivery: &Delivery,
        text: String,
    ) -> String {
        let injector = self.plugins.injector.clone();
        let (target, id) = (registration.target.clone(), delivery.message_id.clone());
        let whole = text.clone();
        tokio::task::spawn_blocking(move || injector.native_pointer(&target, &id, &whole))
            .await
            .ok()
            .flatten()
            .unwrap_or(text)
    }

    /// Whether `delivery` was an answer to an escalated question, the
    /// owner's reply to a pending Codex or Claude
    /// request, or a message to a spawned Claude that has ended, settled
    /// (acknowledged and recorded) or left for the next pass when its record
    /// could not be saved.
    pub(super) async fn took_owner_reply(
        &self,
        registration: &Registration,
        delivery: &Delivery,
        (workspace, base, token): (&WorkspaceScope, &str, &Secret),
    ) -> bool {
        // An answer to an escalated question first: its sender may also be
        // the owner, whose `answer` is not an approval reply.
        let mut reply = self
            .question_reply(registration, delivery, (base, token))
            .await;
        if matches!(reply, OwnerReply::NotOne) {
            reply = self.owner_reply(registration, delivery).await;
        }
        if matches!(reply, OwnerReply::NotOne) {
            reply = self.ended_claude(registration, delivery).await;
        }
        let detail = match reply {
            OwnerReply::NotOne => return false,
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
            && self.claude_turn_route(registration).await
    }

    /// Whether the session's Claude plugin can start a relayed message as a
    /// user turn: it has polled recently and the session has a verified
    /// owner whose binding carries the turn (`teammate_native_turn`).
    async fn claude_turn_route(&self, registration: &Registration) -> bool {
        self.mobile_claude_plugins.plugin_seen(&registration.target)
            && self.mobile_handoff_binding(registration).await.is_some()
    }

    /// The workspace leader that sent `delivery`, when it is a direct
    /// message to the session from a leader's agent id (`relay::leaders`).
    /// A channel or group message is not one.
    async fn leader_sent(
        &self,
        registration: &Registration,
        delivery: &Delivery,
    ) -> Option<crate::relay::contract::agents::WorkspaceLeader> {
        let sender_id = delivery.sender_id.as_deref()?;
        if !crate::relay::spawn::drive::direct_from(delivery, Some(sender_id)) {
            return None;
        }
        self.workspace_leader(registration, sender_id).await
    }

    /// How a workspace leader's direct message reaches the session, when
    /// it does as a leader's: a spawned agent (not taken over) takes it as
    /// native input through its harness while `spawn_native_input` is on; a
    /// session the person started takes it as a Claude user turn while
    /// `teammate_native_input` is on and its plugin can start one. `None`
    /// otherwise: it is then a peer's message, like anyone else's.
    async fn leader_route(&self, registration: &Registration) -> Option<InputSource> {
        let spawned = registration
            .spawn
            .as_ref()
            .is_some_and(|spawn| spawn.taken_over_at.is_none());
        if spawned {
            let on = self
                .store
                .read(|store| store.extras.spawn_native_input != Some(false));
            return (on && self.plugins.spawner.native_input(&registration.target))
                .then_some(InputSource::Leader);
        }
        let on = self.store.read(|store| store.teammate_native_input_on());
        (on && self.claude_turn_route(registration).await).then_some(InputSource::Teammate)
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
    /// message is a plain user turn, as they wrote it, in Codex and Claude;
    /// to any other agent spawned here whose harness takes native input
    /// (Grok, Devin, OpenCode) it is native input that keeps the reply
    /// context. Everyone else's, the spawn's requester unless opted in,
    /// keeps the attribution, the reply hint and the host's note. Opted-in
    /// requester input retains reply context, as does a teammate's direct
    /// message that the session's
    /// Claude plugin starts as a user turn. The requester's other direct
    /// messages (`spawn::from_requester`) also carry `policy::OWNER_LINE`
    /// under their attribution. A workspace leader's direct message
    /// (`relay::leaders`, `leader_route`) to a spawned agent with
    /// `spawn_native_input` on, or to a person's Claude session with
    /// `teammate_native_input` on, is native input carrying
    /// `policy::leader_line` under its attribution; the spawn's own
    /// requester keeps its requester framing even when it is a leader.
    /// Everyone else's is a peer's.
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
        let relayed = !via_webhook && !via_integration;
        let native = relayed
            && (self.spawner_native_turn(registration, delivery)
                || self.owner_to_spawned(registration, delivery).await);
        // The spawn's own requester is never framed or routed as a leader,
        // whether or not the list names it.
        let from_requester = relayed && crate::relay::spawn::from_requester(registration, delivery);
        let leader = match relayed && !native && !from_requester {
            true => self.leader_sent(registration, delivery).await,
            false => None,
        };
        let leader = match leader {
            Some(leader) => self
                .leader_route(registration)
                .await
                .map(|source| (leader, source)),
            None => None,
        };
        let teammate = relayed
            && !native
            && leader.is_none()
            && self.teammate_native_turn(registration, delivery).await;
        let text = injected_text(message, &registration.name, via_webhook, lines.as_deref());
        let text = if native || teammate {
            text.replacen(super::policy::PEER_HEADER, super::policy::NATIVE_HEADER, 1)
        } else if let Some((leader, _)) = &leader {
            let text = text.replacen(super::policy::PEER_HEADER, super::policy::NATIVE_HEADER, 1);
            with_leader_line(&text, &leader.name)
        } else if from_requester {
            with_owner_line(&text)
        } else {
            text
        };
        let source = if native {
            InputSource::Requester
        } else if teammate {
            InputSource::Teammate
        } else if let Some((_, source)) = leader {
            source
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

    #[test]
    fn a_dm_from_the_requester_or_its_launcher_is_the_requesters_by_id_alone() {
        // Cloud invoked the spawn through a launcher for a person's chat.
        let mut registration: Registration = serde_json::from_value(json!({
            "name":"child", "agentID":"child-id", "target":{"kind":"codex","id":"thread"},
            "title":"child", "baseURL":"http://127.0.0.1", "registeredAt":"now",
            "spawn":{"nodeID":"node", "nodeName":"desktop", "invocationID":"inv", "harness":"codex",
                "requester":{"name":"person-chat","agentID":"chat-id"},
                "launcher":{"name":"launcher","agentID":"launcher-id"}}
        }))
        .unwrap();
        let dm = |name: &str, id: &str| Delivery {
            reason: Some("dm".into()),
            sender: Some(name.into()),
            sender_id: Some(id.into()),
            ..Delivery::default()
        };
        for message in [dm("person-chat", "chat-id"), dm("launcher", "launcher-id")] {
            assert!(requester_native_input(true, &registration, &message));
            assert!(crate::relay::spawn::from_requester(&registration, &message));
        }
        // Names are never matched, either way round.
        for message in [
            dm("person-chat", "launcher-name-id"),
            dm("launcher", "impostor-id"),
            dm("chat-id", "person-chat"),
            dm("launcher-id", "launcher"),
        ] {
            assert!(!requester_native_input(true, &registration, &message));
        }
        // A launcher with an empty id matches nothing, not an absent sender id.
        let spawn = registration.spawn.as_mut().unwrap();
        spawn.launcher.as_mut().unwrap().agent_id.clear();
        spawn.requester = None;
        assert!(!requester_native_input(
            true,
            &registration,
            &dm("launcher", "")
        ));
        let mut no_sender = dm("launcher", "");
        no_sender.sender_id = None;
        assert!(!requester_native_input(true, &registration, &no_sender));
        // Taken over, neither is.
        let spawn = registration.spawn.as_mut().unwrap();
        spawn.launcher.as_mut().unwrap().agent_id = "launcher-id".into();
        spawn.taken_over_at = Some("now".into());
        assert!(!requester_native_input(
            true,
            &registration,
            &dm("launcher", "launcher-id")
        ));
    }
}

#[cfg(all(test, unix))]
#[path = "session_text/source_tests.rs"]
mod source_tests;
