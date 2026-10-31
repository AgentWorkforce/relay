//! Relay transport for a spawned Claude's own channel: the verified machine
//! owner's native turns (`Core::owner_sent` admits a driven Claude), its
//! permission requests relayed to that owner alone, their replies, and what
//! a message to a Claude that has ended comes to.

use super::{direct_from, watching, OwnerReply, ReplyDecision};
use crate::relay::client;
use crate::relay::daemon::Core;
use crate::relay::delivery::policy::{Delivery, MessageRef};
use crate::relay::harness::claude::{self, requests};
use crate::relay::links::Endpoint;
use crate::relay::store::Registration;
use crate::relay::workspace::Secret;
use std::time::Duration;

/// How often a spawned Claude's output is read for requests.
const POLL: Duration = Duration::from_millis(500);

/// A spawned Claude the desktop drives: not taken over.
fn spawned_claude(registration: &Registration) -> bool {
    registration
        .spawn
        .as_ref()
        .is_some_and(|spawn| spawn.harness == claude::ID.name() && spawn.taken_over_at.is_none())
}

/// The approval DM sent to the owner for `notice` of `agent`. The reference
/// is the only thing in it the agent's request decided.
pub(crate) fn approval_text(agent: &str, notice: &requests::Notice) -> String {
    let reference = &notice.reference;
    let response = if notice.approvable {
        format!("Reply `approve {reference}` or `deny {reference}` within five minutes.")
    } else if notice.options.is_empty() {
        format!("Reply `deny {reference}` within five minutes. This question cannot be answered through a Relay DM.")
    } else {
        format!(
            "Options: {}. Reply `choose {reference} <number>` or `deny {reference}` within five minutes.",
            notice.options.join(", ")
        )
    };
    format!(
        "[Claude approval {reference} for @{agent}]\n{}\n{response} Only the signed-in machine owner may answer.",
        notice.description
    )
}

/// The owner's `approve`, `deny` or `choose` reply to a spawned Claude's
/// request, answered; what to record.
pub(super) fn answer(
    session: &str,
    (decision, reference): (ReplyDecision, &str),
    sender: Option<&str>,
    owner_id: &str,
) -> String {
    let owner = Some(owner_id);
    let result = match decision {
        ReplyDecision::Choose(choice) => {
            requests::answer_choice(session, reference, sender, owner, choice)
        }
        decision => requests::answer(
            session,
            reference,
            sender,
            owner,
            matches!(decision, ReplyDecision::Approve),
        ),
    };
    format!("Claude approval reply: {result:?}")
}

impl Core {
    /// A spawned Claude the desktop drives through its own input, which a
    /// Claude spawned before that input existed has not.
    pub(super) fn driven_claude(&self, registration: &Registration) -> bool {
        spawned_claude(registration) && self.plugins.spawner.native_input(&registration.target)
    }

    /// A spawned Claude whose process ended finished its work: it is never
    /// started again for a message. The message is settled without being
    /// put anywhere, and a direct message's sender is told so.
    pub(crate) async fn ended_claude(
        &self,
        registration: &Registration,
        delivery: &Delivery,
    ) -> OwnerReply {
        let Some(process) = registration
            .spawn
            .as_ref()
            .filter(|_| spawned_claude(registration))
            .and_then(|spawn| spawn.process)
        else {
            return OwnerReply::NotOne;
        };
        let (spawner, target) = (self.plugins.spawner.clone(), registration.target.clone());
        let alive = tokio::task::spawn_blocking(move || spawner.alive(&target, Some(&process)))
            .await
            .unwrap_or(true);
        if alive {
            return OwnerReply::NotOne;
        }
        if self
            .store
            .remember(|store| store.record_injected(&delivery.id))
            .is_err()
        {
            return OwnerReply::Unsaved;
        }
        let sender = delivery
            .sender_address
            .clone()
            .map(Endpoint::Address)
            .or_else(|| delivery.sender.clone().map(Endpoint::Name))
            .filter(|_| direct_from(delivery, delivery.sender_id.as_deref()));
        if let (Some(sender), Some((current, token))) =
            (sender, self.agent_credential(&registration.name))
        {
            let text = format!(
                "@{}'s session has ended, so this message was not delivered.",
                registration.name
            );
            let key = format!("spawn-ended-{}", MessageRef::of(&delivery.id));
            let _ = client::send_dm(&current.base_url, &token, &sender, &text, Some(key)).await;
        }
        OwnerReply::Settled("Spawned Claude has ended; not delivered".into())
    }

    /// Starts relaying `registration`'s pending requests, whatever its
    /// harness. Idempotent; a restarted core starts again on its first look
    /// at its spawned agents or its first delivery.
    pub(crate) fn watch_spawned(&self, registration: &Registration) {
        self.watch_spawned_codex(registration);
        self.watch_spawned_claude(registration);
    }

    /// Relays a spawned Claude's requests to the owner while it runs.
    pub(crate) fn watch_spawned_claude(&self, registration: &Registration) {
        let Some(core) = self.arc().filter(|_| spawned_claude(registration)) else {
            return;
        };
        let session = registration.target.id.clone();
        if !watching().insert(session.clone()) {
            return;
        }
        let (agent_id, agent_name) = (registration.agent_id.clone(), registration.name.clone());
        tokio::spawn(async move {
            while let Some((registration, token)) = core.still_spawned(&agent_name, &agent_id) {
                let spawner = core.plugins.spawner.clone();
                let target = registration.target.clone();
                let process = registration.spawn.as_ref().and_then(|spawn| spawn.process);
                // Its recorded process ending ends its references, whatever
                // its pipe; without one, its pipe alone says.
                let polled = tokio::task::spawn_blocking(move || {
                    let ended =
                        process.is_some_and(|process| !spawner.alive(&target, Some(&process)));
                    (!ended).then(|| spawner.poll_requests(&target)).flatten()
                })
                .await;
                if polled.ok().flatten() != Some(true) {
                    break;
                }
                for notice in requests::unforwarded(&session) {
                    core.forward_request(&registration, &token, &notice).await;
                }
                tokio::time::sleep(POLL).await;
            }
            claude::channel::close(&session);
            watching().remove(&session);
        });
    }

    /// The registration and credential of a spawned Claude still on this
    /// computer under the same agent id, and not taken over.
    fn still_spawned(&self, name: &str, agent_id: &str) -> Option<(Registration, Secret)> {
        if self.stopping() {
            return None;
        }
        self.agent_credential(name)
            .filter(|(current, _)| current.agent_id == agent_id && spawned_claude(current))
    }

    /// Sends `notice` to the verified owner. Without one it is never
    /// forwarded, and the request expires to a refusal.
    async fn forward_request(
        &self,
        registration: &Registration,
        token: &Secret,
        notice: &requests::Notice,
    ) {
        let Some((owner, owner_id)) = self.verified_owner(registration).await else {
            return;
        };
        let text = approval_text(&registration.name, notice);
        let key = format!(
            "spawn-approval-{}-{}",
            notice.reference,
            MessageRef::of(&owner_id)
        );
        if client::send_dm(
            &registration.base_url,
            token,
            &Endpoint::Name(owner),
            &text,
            Some(key),
        )
        .await
        .is_ok()
        {
            requests::mark_forwarded(&notice.reference);
        }
    }
}

#[cfg(test)]
mod tests;
