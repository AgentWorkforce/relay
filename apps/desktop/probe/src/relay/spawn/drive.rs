//! Relay transport for a spawned Codex thread's pending app-server requests,
//! and the machine owner's native turns.
//!
//! Only the verified machine owner (the signed-in person's own Relaycast
//! identity, matched by its immutable agent id) is trusted: their direct
//! messages start plain user turns, and every command, patch, permission and
//! elicitation request goes to them alone. The spawn's requester and every
//! other agent keep `[via Agent Relay]` peer framing and cannot answer a
//! request.

use crate::relay::client;
use crate::relay::codex::app_server::drive::{self, Notice, ReplyResult};
use crate::relay::daemon::Core;
use crate::relay::delivery::policy::{Delivery, MessageRef};
use crate::relay::harness::codex;
use crate::relay::links::Endpoint;
use crate::relay::sdk_gaps;
use crate::relay::state::SpawnClaimState;
use crate::relay::store::Registration;
use crate::relay::workspace::Secret;
use std::collections::HashSet;
use std::sync::{Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::Duration;

pub(crate) mod claude;

fn watching() -> MutexGuard<'static, HashSet<String>> {
    static WATCHING: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    WATCHING
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
}

fn claimed_by_signed_in(core: &Core) -> bool {
    core.status()
        .spawn
        .as_ref()
        .and_then(|spawn| spawn.claim.as_ref())
        .is_some_and(|claim| claim.state == SpawnClaimState::Claimed)
}

/// A spawned Codex thread the desktop still drives: not taken over.
fn driven_codex(registration: &Registration) -> bool {
    registration
        .spawn
        .as_ref()
        .is_some_and(|spawn| spawn.harness == codex::ID.name() && spawn.taken_over_at.is_none())
}

/// A direct message (no channel) whose immutable Relaycast sender id is
/// `id`. A name is never enough: it can be taken again.
pub(crate) fn direct_from(delivery: &Delivery, id: Option<&str>) -> bool {
    id.is_some()
        && delivery.sender_id.as_deref() == id
        && delivery.channel_id.is_none()
        && delivery.reason.as_deref() == Some("dm")
}

pub(crate) enum ReplyDecision {
    Approve,
    Deny,
    Choose(usize),
}

pub(crate) fn parse_reply(text: &str) -> Option<(ReplyDecision, &str)> {
    let mut words = text.split_ascii_whitespace();
    let verb = words.next()?;
    let reference = words.next()?;
    if reference.len() != 16 || !reference.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let decision = match verb {
        "approve" if words.next().is_none() => ReplyDecision::Approve,
        "deny" if words.next().is_none() => ReplyDecision::Deny,
        "choose" => {
            let choice = words.next()?.parse().ok()?;
            if words.next().is_some() {
                return None;
            }
            ReplyDecision::Choose(choice)
        }
        _ => return None,
    };
    Some((decision, reference))
}

/// What the owner's DM about a pending request did.
pub(crate) enum OwnerReply {
    /// Not the owner's reply to a request: delivered as a message.
    NotOne,
    /// Its delivery record could not be saved, so nothing was answered.
    Unsaved,
    /// Answered (or refused), with what to record.
    Settled(String),
}

/// The approval DM sent to the owner for `notice` of `agent`.
pub(crate) fn approval_text(agent: &str, notice: &Notice) -> String {
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
        "[Codex approval {reference} for @{agent}]\n{}\n{response} Only the signed-in machine owner may answer.",
        notice.description
    )
}

impl Core {
    /// Idempotent across a spawn and later deliveries. A restarted core
    /// starts the watcher on its first subsequent delivery.
    pub(crate) fn watch_spawned_codex(&self, registration: &Registration) {
        let Some(core) = self.arc().filter(|_| driven_codex(registration)) else {
            return;
        };
        let thread = registration.target.id.clone();
        if !watching().insert(thread.clone()) {
            return;
        }
        let (agent_id, agent_name) = (registration.agent_id.clone(), registration.name.clone());
        tokio::spawn(async move {
            while !core.stopping() {
                let Some((registration, token)) = core
                    .agent_credential(&agent_name)
                    .filter(|(current, _)| current.agent_id == agent_id && driven_codex(current))
                else {
                    break;
                };
                for notice in drive::unforwarded(&thread) {
                    core.forward_to_owner(&registration, &token, &notice).await;
                }
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
            watching().remove(&thread);
        });
    }

    /// Sends `notice` to the verified owner. Without one it is never
    /// forwarded, and the request expires to a refusal.
    async fn forward_to_owner(&self, registration: &Registration, token: &Secret, notice: &Notice) {
        let Some((owner, owner_id)) = self.verified_owner(registration).await else {
            return;
        };
        let key = format!(
            "spawn-approval-{}-{}",
            notice.reference,
            MessageRef::of(&owner_id)
        );
        let text = approval_text(&registration.name, notice);
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
            drive::mark_forwarded(&notice.reference);
        }
    }

    /// The signed-in person's relay identity, when this computer's node is
    /// claimed by them, `registration` is in their workspace, and Relaycast
    /// still gives the name their immutable id: (name, agent id).
    pub(crate) async fn verified_owner(
        &self,
        registration: &Registration,
    ) -> Option<(String, String)> {
        let workspace = self.workspace()?;
        if !claimed_by_signed_in(self)
            || workspace.base_url != registration.base_url
            || registration.workspace_key.as_ref() != Some(&workspace.key)
        {
            return None;
        }
        let owner = self.person_identity(false).await.ok()?;
        let http = sdk_gaps::http(&registration.base_url, &workspace.key).ok()?;
        let holds = sdk_gaps::get_agent(&http, &owner.name)
            .await
            .ok()
            .flatten()
            .is_some_and(|agent| agent["id"].as_str() == Some(owner.agent_id.as_str()));
        (owner.base_url == registration.base_url && holds).then_some((owner.name, owner.agent_id))
    }

    /// The verified owner's id, when `delivery` is their direct message to a
    /// spawned Codex or Claude the desktop drives.
    async fn owner_sent(&self, registration: &Registration, delivery: &Delivery) -> Option<String> {
        let driven = driven_codex(registration) || self.driven_claude(registration);
        if !driven || !direct_from(delivery, delivery.sender_id.as_deref()) {
            return None;
        }
        let (_, owner_id) = self.verified_owner(registration).await?;
        direct_from(delivery, Some(&owner_id)).then_some(owner_id)
    }

    /// Whether `delivery` is the owner's message, which starts a plain user
    /// turn rather than a peer-framed one.
    pub(crate) async fn owner_native_turn(
        &self,
        registration: &Registration,
        delivery: &Delivery,
    ) -> bool {
        self.owner_sent(registration, delivery).await.is_some()
            || self.mobile_owner_turn(registration, delivery).await
    }

    /// Answers a pending request when `delivery` is the owner's
    /// `approve`/`deny`/`choose` reply to it. The delivery record is saved
    /// before Codex is answered: a reply Relaycast sends again is skipped,
    /// and one whose record cannot be saved never acts (its request expires
    /// to a refusal). Anyone else's such text is an ordinary message.
    pub(crate) async fn owner_reply(
        &self,
        registration: &Registration,
        delivery: &Delivery,
    ) -> OwnerReply {
        if let Some(reply) = self.mobile_permission_reply(registration, delivery).await {
            return reply;
        }
        let text = delivery.text.as_deref().unwrap_or_default();
        let Some((decision, reference)) = parse_reply(text) else {
            return OwnerReply::NotOne;
        };
        let Some(owner_id) = self.owner_sent(registration, delivery).await else {
            return OwnerReply::NotOne;
        };
        if self
            .store
            .remember(|store| store.record_injected(&delivery.id))
            .is_err()
        {
            return OwnerReply::Unsaved;
        }
        let (thread, sender) = (&registration.target.id, delivery.sender_id.as_deref());
        if !driven_codex(registration) {
            return OwnerReply::Settled(claude::answer(
                thread,
                (decision, reference),
                sender,
                &owner_id,
            ));
        }
        let result: ReplyResult = match decision {
            ReplyDecision::Choose(choice) => {
                drive::answer_choice(thread, reference, sender, Some(&owner_id), choice)
            }
            decision => drive::answer(
                thread,
                reference,
                sender,
                Some(&owner_id),
                matches!(decision, ReplyDecision::Approve),
            ),
        };
        OwnerReply::Settled(format!("Codex approval reply: {result:?}"))
    }
}
