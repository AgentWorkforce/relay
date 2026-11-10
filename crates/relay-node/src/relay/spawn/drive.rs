//! Relay transport for a spawned Codex thread's pending app-server requests,
//! and the machine owner's native turns.
//!
//! Only the verified machine owner (the signed-in person's own Relaycast
//! identity, matched by its immutable agent id) is trusted: their direct
//! messages start plain user turns, and every command, patch, permission and
//! elicitation request goes to them. The spawn's requester and every other
//! agent get `[via Agent Relay]` turns; only the requester's carry the owner
//! line (`spawn::from_requester`), or are native turns when its native input
//! is on (`session_text`). With **Approvals from the spawning agent** also on
//! (`settings::requester_approvals`), the requester, and no other agent, is
//! sent the same requests and may answer them by direct message too; the
//! first answer counts, and each is written to the diagnostics log.

use crate::relay::client;
use crate::relay::codex::app_server::drive::{self, Notice, ReplyResult};
use crate::relay::daemon::Core;
use crate::relay::delivery::policy::{Delivery, MessageRef};
use crate::relay::harness::codex;
use crate::relay::links::Endpoint;
use crate::relay::sdk_gaps;
use crate::relay::state::SpawnClaimState;
use crate::relay::store::{Registration, SpawnRequester};
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

/// Who answered a spawned session's pending request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Approver {
    /// The verified machine owner, by agent id.
    Owner(String),
    /// The agent that spawned the session, allowed to answer.
    Requester(SpawnRequester),
}

impl Approver {
    /// The immutable Relaycast id an answer must come from.
    pub(crate) fn id(&self) -> &str {
        match self {
            Approver::Owner(id) => id,
            Approver::Requester(requester) => &requester.agent_id,
        }
    }

    /// Who answered, for the delivery record and the diagnostics log.
    pub(crate) fn describe(&self) -> String {
        match self {
            Approver::Owner(_) => "the machine owner".into(),
            Approver::Requester(requester) => format!(
                "the spawning agent @{} ({})",
                requester.name, requester.agent_id
            ),
        }
    }
}

/// The closing line of an approval DM: who may answer it.
pub(crate) fn who_may_answer(requester: Option<&str>) -> String {
    match requester {
        None => "Only the signed-in machine owner may answer.".into(),
        Some(name) => format!(
            "The signed-in machine owner or @{name}, the agent that spawned this session, \
             may answer; the first answer counts."
        ),
    }
}

/// The approval DM for `notice` of `agent`, naming `requester` when the
/// spawning agent may answer it too.
pub(crate) fn approval_text(agent: &str, notice: &Notice, requester: Option<&str>) -> String {
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
        "[Codex approval {reference} for @{agent}]\n{}\n{response} {}",
        notice.description,
        who_may_answer(requester)
    )
}

/// The diagnostics line recording who answered `reference` of `agent`.
pub(crate) fn audit_line(
    harness: &str,
    agent: &str,
    reference: &str,
    approver: &Approver,
    result: ReplyResult,
) -> String {
    format!(
        "relay: {harness} approval {reference} for @{agent}: {result:?}, answered by {}",
        approver.describe()
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

    /// Sends `notice` to the verified owner and, when it may answer, the
    /// spawning agent. With neither it is never forwarded, and the request
    /// expires to a refusal.
    async fn forward_to_owner(&self, registration: &Registration, token: &Secret, notice: &Notice) {
        let requester = self.approving_requester(registration);
        let text = approval_text(
            &registration.name,
            notice,
            requester.as_ref().map(|r| r.name.as_str()),
        );
        if self
            .send_approval(registration, token, &notice.reference, &text, requester)
            .await
        {
            drive::mark_forwarded(&notice.reference);
        }
    }

    /// Sends an approval DM about `reference` to the verified owner and to
    /// `requester`. True once someone may answer it and everyone it is for
    /// has it; until then it is sent again, under the same keys.
    pub(crate) async fn send_approval(
        &self,
        registration: &Registration,
        token: &Secret,
        reference: &str,
        text: &str,
        requester: Option<SpawnRequester>,
    ) -> bool {
        let owner = self.verified_owner(registration).await;
        // A name can be taken again: the requester's copy goes to its saved
        // name only while Relaycast still gives it the requester's id.
        let (requester, mut sent) = match requester {
            None => (None, true),
            Some(requester) => match self.holds_name(registration, &requester).await {
                Some(true) => (Some(requester), true),
                Some(false) => (None, true),
                None => (None, false),
            },
        };
        let recipients: Vec<(String, String)> = owner
            .into_iter()
            .chain(requester.map(|r| (r.name, r.agent_id)))
            .collect();
        sent &= !recipients.is_empty();
        for (name, id) in recipients {
            let key = format!("spawn-approval-{reference}-{}", MessageRef::of(&id));
            sent &= client::send_dm(
                &registration.base_url,
                token,
                &Endpoint::Name(name),
                text,
                Some(key),
            )
            .await
            .is_ok();
        }
        sent
    }

    /// Whether Relaycast still gives `requester`'s saved name its immutable
    /// id in `registration`'s workspace; `None` when it could not be asked,
    /// so the notice is sent again later.
    async fn holds_name(
        &self,
        registration: &Registration,
        requester: &SpawnRequester,
    ) -> Option<bool> {
        let workspace = self.workspace()?;
        if workspace.base_url != registration.base_url
            || registration.workspace_key.as_ref() != Some(&workspace.key)
        {
            return Some(false);
        }
        let http = sdk_gaps::workspace_http(&workspace).ok()?;
        let agent = sdk_gaps::get_agent(&http, &requester.name).await.ok()?;
        Some(agent.is_some_and(|agent| agent["id"].as_str() == Some(requester.agent_id.as_str())))
    }

    /// The agent that spawned `registration`, when it may answer the
    /// session's requests: native input and approvals from the spawning
    /// agent are both on, the session is not taken over, and its requester's
    /// immutable id is known. Teammates and other agents never may.
    pub(crate) fn approving_requester(
        &self,
        registration: &Registration,
    ) -> Option<SpawnRequester> {
        // Only a build with an account offers this; a public core never does.
        if self.plugins.account.is_none() {
            return None;
        }
        let development = self.development();
        if !self
            .store
            .read(|store| super::settings::requester_approvals(store, development))
        {
            return None;
        }
        registration
            .spawn
            .as_ref()
            .filter(|spawn| spawn.taken_over_at.is_none())
            .and_then(|spawn| spawn.requester.clone())
            .filter(|requester| !requester.agent_id.is_empty())
    }

    /// Who may answer `reference` with `delivery`: the verified owner's
    /// direct message, or the spawning agent's when it may answer and the
    /// reference is one of the session's open requests. A requester's reply
    /// to anything else (an answered, expired or ended request) is an
    /// ordinary message, so a session that ended still says so.
    async fn approver(
        &self,
        registration: &Registration,
        delivery: &Delivery,
        reference: &str,
    ) -> Option<Approver> {
        if let Some(owner_id) = self.owner_sent(registration, delivery).await {
            return Some(Approver::Owner(owner_id));
        }
        let requester = self.approving_requester(registration)?;
        let thread = &registration.target.id;
        let open = if driven_codex(registration) {
            drive::has_pending(thread, reference)
        } else {
            // An ended Claude's message is settled as ended, never answered.
            self.driven_claude(registration)
                && crate::relay::harness::claude::requests::has_pending(thread, reference)
                && !self.claude_ended(registration).await
        };
        (open && direct_from(delivery, Some(&requester.agent_id)))
            .then_some(Approver::Requester(requester))
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
        let http = sdk_gaps::workspace_http(&workspace).ok()?;
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
            || self
                .native_continuation_owner_turn(registration, delivery)
                .await
    }

    /// Answers a pending request when `delivery` is the owner's (or an
    /// allowed spawning agent's, `approver`) `approve`/`deny`/`choose` reply
    /// to it; the first answer counts. The delivery record is saved
    /// before Codex is answered: a reply Relaycast sends again is skipped,
    /// and one whose record cannot be saved never acts (its request expires
    /// to a refusal). Anyone else's such text is an ordinary message.
    pub(crate) async fn owner_reply(
        &self,
        registration: &Registration,
        delivery: &Delivery,
    ) -> OwnerReply {
        if let Some(reply) = self.codex_mobile_reply(registration, delivery).await {
            return reply;
        }
        if let Some(reply) = self.mobile_permission_reply(registration, delivery).await {
            return reply;
        }
        let text = delivery.text.as_deref().unwrap_or_default();
        let Some((decision, reference)) = parse_reply(text) else {
            return OwnerReply::NotOne;
        };
        let Some(approver) = self.approver(registration, delivery, reference).await else {
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
        let allowed = Some(approver.id());
        let (harness, result) = if !driven_codex(registration) {
            (
                "Claude",
                claude::answer(thread, (decision, reference), sender, approver.id()),
            )
        } else {
            let result = match decision {
                ReplyDecision::Choose(choice) => {
                    drive::answer_choice(thread, reference, sender, allowed, choice)
                }
                decision => drive::answer(
                    thread,
                    reference,
                    sender,
                    allowed,
                    matches!(decision, ReplyDecision::Approve),
                ),
            };
            ("Codex", result)
        };
        crate::relay::diagnostics::write(format_args!(
            "{}",
            audit_line(harness, &registration.name, reference, &approver, result)
        ));
        OwnerReply::Settled(format!(
            "{harness} approval reply from {}: {result:?}",
            approver.describe()
        ))
    }
}
