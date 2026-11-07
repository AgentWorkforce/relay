//! The loop guard on each route: deliveries, the session socket's sends
//! and automatic final answers.

use super::{refused_delivery, refused_send, stopped_line, Admission, LoopGuard, Place, FILE_NAME};
use crate::relay::backoff::WorkspaceScope;
use crate::relay::daemon::Core;
use crate::relay::delivery::policy::Delivery;
use crate::relay::delivery::DeliveryOutcome;
use crate::relay::links::Endpoint;
use crate::relay::sdk_gaps;
use crate::relay::state::{now_ms, Level};
use crate::relay::store::{Registration, Reply};
use crate::relay::workspace::Secret;
use std::sync::Arc;

/// What the guard says about a delivery.
enum Guarded {
    Go,
    /// Refused, with the reason its sender and the activity log see.
    Refused(String),
    /// Its count could not be saved; it waits for a later pass.
    Unsaved(String),
}

/// Why a message may not be sent.
pub(crate) enum LoopRefusal {
    /// The pair is at the cap; what the agent is told.
    Capped(String),
    /// Its place in the count could not be saved.
    Unsaved(String),
    /// Relaycast could not be asked who the recipient is.
    Lookup(relaycast::RelayError),
    /// Who the recipient is cannot be verified here; what the agent is
    /// told.
    Unverified(String),
}

/// What the agent is told when it names a recipient this computer cannot
/// verify.
fn unverified(peer: &str) -> String {
    format!(
        "Agent Relay cannot verify which agent {peer} is without this workspace's key, so the loop guard cannot count this message and nothing was sent. Connect the workspace again in Agent Relay, or reply to a message from {peer}."
    )
}

/// How a message names its peer to the person reading it.
fn label(endpoint: &Endpoint) -> String {
    match endpoint {
        Endpoint::Name(name) => format!("@{name}"),
        Endpoint::Address(address) => address.clone(),
    }
}

impl Core {
    /// Runs `change` on the loop guard, loading its journal on first use.
    pub(crate) fn with_loop_guard<T>(&self, change: impl FnOnce(&mut LoopGuard) -> T) -> T {
        let mut state = self.delivery.lock().unwrap_or_else(|p| p.into_inner());
        let guard = state
            .loop_guard
            .get_or_insert_with(|| LoopGuard::load(self.config.app_data_dir.join(FILE_NAME)));
        change(guard)
    }

    /// The key a recipient's resolved id is kept under: its workspace,
    /// as Relaycast's scope for these credentials names it, and the
    /// endpoint.
    fn resolved_key(
        &self,
        registration: &Registration,
        token: &Secret,
        endpoint: &Endpoint,
    ) -> String {
        let scope = self.relaycast_registration_scope(registration, token);
        format!("{} {}", scope.key(), endpoint.key())
    }

    /// Whether Relaycast's sender `sender_id` is the person signed in on
    /// this computer: their relay identity, by its immutable id.
    async fn sent_by_owner(&self, base_url: &str, sender_id: &str) -> bool {
        self.person_identity(false)
            .await
            .is_ok_and(|owner| owner.base_url == base_url && owner.agent_id == sender_id)
    }

    /// Says once a window that a pair was stopped.
    fn report_stop(&self, agent: &Registration, peer_id: &str, peer: &str) {
        if self.with_loop_guard(|guard| guard.report_stop(&agent.agent_id, peer_id, now_ms())) {
            self.hub
                .activity(Level::Warning, stopped_line(&agent.name, peer));
        }
    }

    /// Settles `delivery` before consent when the loop guard refuses it or
    /// cannot save its count, then when it was the owner's reply to a
    /// pending request: whether either took it.
    pub(in crate::relay::delivery) async fn took_before_consent(
        self: &Arc<Core>,
        registration: &Registration,
        delivery: &Delivery,
        (workspace, base, token): (&WorkspaceScope, &str, &Secret),
    ) -> bool {
        self.loop_guard_took(registration, delivery, token).await
            || self
                .took_owner_reply(registration, delivery, (workspace, base, token))
                .await
    }

    async fn loop_guard_took(
        self: &Arc<Core>,
        registration: &Registration,
        delivery: &Delivery,
        token: &Secret,
    ) -> bool {
        let reason = match self.guard_delivery(registration, delivery, token).await {
            Guarded::Go => return false,
            Guarded::Refused(reason) => reason,
            Guarded::Unsaved(error) => {
                self.drain_later(registration, 5.2);
                self.record(
                    registration,
                    delivery,
                    DeliveryOutcome::Failed,
                    Some(format!(
                        "Could not save the loop guard's count; tried again shortly — {error}"
                    )),
                );
                return true;
            }
        };
        // Remembered like any refusal: Relaycast is told once it is on
        // disk, and a redelivery is refused again.
        let remembered = self.store.remember(|store| {
            store.queue_refusal_with_reason(&delivery.id, &registration.agent_id, Some(&reason));
        });
        if remembered.is_ok() {
            self.settle_refused_delivery(registration, token, &delivery.id)
                .await;
        }
        self.record(
            registration,
            delivery,
            DeliveryOutcome::Failed,
            Some(format!("Refused; not retried — {reason}")),
        );
        true
    }

    /// Counts a delivery from another agent toward its pair, or starts the
    /// pair again when the signed-in person sent it. Only direct messages,
    /// @mentions and thread replies count; provider events, webhook posts
    /// and channel posts do not.
    async fn guard_delivery(
        &self,
        registration: &Registration,
        delivery: &Delivery,
        token: &Secret,
    ) -> Guarded {
        let conversational = matches!(
            delivery.reason.as_deref(),
            Some("dm" | "mention" | "thread-reply")
        );
        let from_a_provider = [
            registration.webhook.as_ref().map(|w| w.channel_id.as_str()),
            registration.integration_channel_id.as_deref(),
        ]
        .into_iter()
        .flatten()
        .any(|channel| delivery.channel_id.as_deref() == Some(channel));
        let Some(sender) = delivery
            .sender_id
            .as_deref()
            .filter(|id| conversational && !from_a_provider && *id != registration.agent_id)
        else {
            return Guarded::Go;
        };
        let now = now_ms();
        if self.sent_by_owner(&registration.base_url, sender).await {
            // Failing to save only leaves the count where it was.
            let _ = self.with_loop_guard(|guard| {
                guard.person_messaged(&registration.agent_id, &delivery.message_id, now)
            });
            return Guarded::Go;
        }
        // Relaycast names the sender, so a send to that name or address
        // later is the same pair.
        let names = [
            delivery.sender.clone().map(Endpoint::Name),
            delivery.sender_address.clone().map(Endpoint::Address),
        ];
        let keys: Vec<String> = names
            .iter()
            .flatten()
            .map(|endpoint| self.resolved_key(registration, token, endpoint))
            .collect();
        let admitted = self.with_loop_guard(|guard| {
            for key in keys {
                guard.resolve(key, sender.into());
            }
            guard.admit(&registration.agent_id, sender, &delivery.message_id, now)
        });
        match admitted {
            Ok(Admission::Admitted) => Guarded::Go,
            Ok(Admission::Refused) => {
                let peer = delivery
                    .sender
                    .as_deref()
                    .map(|name| format!("@{name}"))
                    .unwrap_or_else(|| "Another agent".into());
                self.report_stop(registration, sender, &peer);
                Guarded::Refused(refused_delivery(&peer, &registration.name))
            }
            Err(error) => Guarded::Unsaved(error),
        }
    }

    /// The pair a session's message belongs to: the Relaycast id of the
    /// agent it goes to (for a reply, its parent's sender), and how to name
    /// it. `None` for a channel post, a message to the signed-in person,
    /// and a recipient Relaycast does not know (the send then fails there).
    pub(crate) async fn loop_peer(
        &self,
        (registration, token): (&Registration, &Secret),
        endpoint: Option<&Endpoint>,
        reply_to: Option<&str>,
    ) -> Result<Option<(String, String)>, LoopRefusal> {
        if let Some(parent) = reply_to {
            return Ok(self.reply_pair(&registration.agent_id, parent));
        }
        let Some(endpoint) = endpoint else {
            return Ok(None);
        };
        let base = &registration.base_url;
        let key = self.resolved_key(registration, token, endpoint);
        let id = match self.with_loop_guard(|guard| guard.resolved(&key)) {
            Some(id) => Some(id),
            None => {
                // Without the workspace's key no id can be verified: the
                // endpoint keying the pair would let a name and an address
                // count apart, so nothing is sent.
                let workspace_key = self
                    .key_for(registration)
                    .ok_or_else(|| LoopRefusal::Unverified(unverified(&label(endpoint))))?;
                let found = resolve(base, &workspace_key, endpoint)
                    .await
                    .map_err(LoopRefusal::Lookup)?;
                if let Some(id) = &found {
                    self.with_loop_guard(|guard| guard.resolve(key, id.clone()));
                }
                found
            }
        };
        let Some(id) = id.filter(|id| *id != registration.agent_id) else {
            return Ok(None);
        };
        if self.sent_by_owner(base, &id).await {
            return Ok(None);
        }
        Ok(Some((id, label(endpoint))))
    }

    /// Reserves `agent`'s next message to `peer_id` (named `peer`) in their
    /// pair's count, before it is sent.
    pub(crate) fn loop_reserve(
        &self,
        agent: &Registration,
        (peer_id, peer): (&str, &str),
    ) -> Result<Place, LoopRefusal> {
        match self.with_loop_guard(|guard| guard.reserve(&agent.agent_id, peer_id, now_ms())) {
            Ok(Some(place)) => Ok(place),
            Ok(None) => {
                self.report_stop(agent, peer_id, peer);
                Err(LoopRefusal::Capped(refused_send(&agent.name, peer)))
            }
            Err(error) => Err(LoopRefusal::Unsaved(error)),
        }
    }

    /// The message reserved as `place` was sent as `message_id`. A place
    /// whose send failed, or whose id is unknown, keeps counting: the count
    /// errs high, never low.
    pub(crate) fn loop_sent(&self, place: Option<&Place>, message_id: Option<&str>) {
        if let (Some(place), Some(message_id)) = (place, message_id) {
            self.with_loop_guard(|guard| guard.sent(place, message_id, now_ms()));
        }
    }

    /// The pair a reply to `parent` from `agent` counts toward: its parent's
    /// sender, whatever recipient it names. `None` for a reply to the
    /// person. A parent this journal no longer holds keys its own count, so
    /// replies to it are still held to the cap without blaming another
    /// pair.
    fn reply_pair(&self, agent: &str, parent: &str) -> Option<(String, String)> {
        let peer = self.with_loop_guard(|guard| match guard.peer_of(agent, parent) {
            Some(peer) => Some(peer),
            None if guard.from_person(parent) => None,
            None => Some(format!("reply:{parent}")),
        })?;
        Some((peer, "the agent you are replying to".into()))
    }

    /// The automatic answer to `reply`'s place in its pair's count, saved
    /// before it is sent: `Some(None)` for an answer to the person. `None`
    /// when it must not be sent now: past the cap it is dropped, as the
    /// agent's own send would be refused; a place that could not be saved
    /// is tried again on the next pass.
    pub(in crate::relay::delivery) fn answer_place(
        &self,
        registration: &Registration,
        reply: &Reply,
    ) -> Option<Option<Place>> {
        let Some((peer, _)) = self.reply_pair(&reply.agent_id, &reply.message_id) else {
            return Some(None);
        };
        let name = reply
            .sender_name
            .as_deref()
            .map_or_else(|| "another agent".into(), |name| format!("@{name}"));
        match self.loop_reserve(registration, (&peer, &name)) {
            Ok(place) => Some(Some(place)),
            Err(LoopRefusal::Capped(_)) => {
                self.forget_reply(reply);
                None
            }
            Err(_) => None,
        }
    }

    /// Drops `reply`'s automatic answer.
    pub(in crate::relay::delivery) fn forget_reply(&self, reply: &Reply) {
        let _ = self.store.update(|store| {
            if let Some(list) = store.replies.as_mut() {
                list.retain(|r| {
                    !(r.agent_id == reply.agent_id && r.message_id == reply.message_id)
                });
            }
        });
    }
}

/// The Relaycast id `endpoint` names: the agent with that name, or, for an
/// address, the agent whose name is one reading before an `@` and whose
/// address it is.
async fn resolve(
    base_url: &str,
    workspace_key: &Secret,
    endpoint: &Endpoint,
) -> relaycast::Result<Option<String>> {
    let http = sdk_gaps::http(base_url, workspace_key)?;
    let names: Vec<&str> = match endpoint {
        Endpoint::Name(name) => vec![name.as_str()],
        Endpoint::Address(address) => address
            .char_indices()
            .filter(|(index, c)| *c == '@' && *index > 0)
            .map(|(index, _)| &address[..index])
            .collect(),
    };
    for name in names {
        let Some(agent) = sdk_gaps::get_agent(&http, name).await? else {
            continue;
        };
        let matches = match endpoint {
            Endpoint::Name(_) => true,
            Endpoint::Address(address) => agent["address"].as_str() == Some(address.as_str()),
        };
        if let Some(id) = agent["id"].as_str().filter(|id| matches && !id.is_empty()) {
            return Ok(Some(id.to_string()));
        }
    }
    Ok(None)
}
