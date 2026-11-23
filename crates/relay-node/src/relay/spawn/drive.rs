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
//! first answer counts, and each is written to the diagnostics log. With
//! **Approvals from workspace leaders** on (`settings::leader_approvals`,
//! off unless the machine owner turns it on), each listed workspace leader
//! is sent the requests it may approve or deny and may answer them with the
//! machine owner's standing (`Approver::Leader`, `relay::leaders`).

use crate::relay::client;
use crate::relay::codex::app_server::drive::{self, Notice, ReplyResult};
use crate::relay::contract::agents::WorkspaceLeader;
use crate::relay::daemon::Core;
use crate::relay::delivery::policy::{Delivery, MessageRef};
use crate::relay::harness::codex;
use crate::relay::links::Endpoint;
use crate::relay::sdk_gaps;
use crate::relay::state::SpawnClaimState;
use crate::relay::store::{Registration, SpawnRequester};
use crate::relay::workspace::{Secret, Workspace};
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

/// The prefix Relaycast gives a 1:1 DM conversation's channel id
/// (`dmch_<pair key>`). Group DMs and ordinary channels get other ids.
const ONE_TO_ONE_DM_CHANNEL: &str = "dmch_";

/// A 1:1 direct message whose immutable Relaycast sender id is `id`. A
/// name is never enough: it can be taken again.
///
/// That is a `dm` delivery that names no channel (a pushed `dm.received`)
/// or names the pair's own DM channel (the delivery queue names it), or a
/// reply in a thread of that DM conversation (`thread-reply` in a `dmch_`
/// channel). A channel post, a mention, a group DM and a thread reply in
/// any other channel never are.
pub(crate) fn direct_from(delivery: &Delivery, id: Option<&str>) -> bool {
    let in_dm_channel = delivery
        .channel_id
        .as_deref()
        .is_some_and(|channel| channel.starts_with(ONE_TO_ONE_DM_CHANNEL));
    let direct = match delivery.reason.as_deref() {
        Some("dm") => delivery.channel_id.is_none() || in_dm_channel,
        Some("thread-reply") => in_dm_channel,
        _ => false,
    };
    id.is_some() && delivery.sender_id.as_deref() == id && direct
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
    /// A workspace leader, by agent id, answering an approve/deny request
    /// with the machine owner's standing. Never recorded as the owner.
    Leader(WorkspaceLeader),
}

impl Approver {
    /// The immutable Relaycast id an answer must come from.
    pub(crate) fn id(&self) -> &str {
        match self {
            Approver::Owner(id) => id,
            Approver::Requester(requester) => &requester.agent_id,
            Approver::Leader(leader) => &leader.agent_id,
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
            Approver::Leader(leader) => format!(
                "the workspace leader @{} ({})",
                leader.name, leader.agent_id
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

/// How many leaders a notice names.
const LEADERS_NAMED: usize = 3;

/// The closing line of an approval DM that `leaders` may answer too (by
/// name, at most [`LEADERS_NAMED`] of them); without any, [`who_may_answer`].
pub(crate) fn who_may_answer_with(requester: Option<&str>, leaders: &[String]) -> String {
    if leaders.is_empty() {
        return who_may_answer(requester);
    }
    let mut named = leaders
        .iter()
        .take(LEADERS_NAMED)
        .map(|name| format!("@{name}"))
        .collect::<Vec<_>>()
        .join(", ");
    if leaders.len() > LEADERS_NAMED {
        named.push_str(&format!(" and {} more", leaders.len() - LEADERS_NAMED));
    }
    match requester {
        None => format!(
            "The signed-in machine owner or a workspace leader ({named}) may answer; \
             the first answer counts."
        ),
        Some(name) => format!(
            "The signed-in machine owner, @{name} (the agent that spawned this session) \
             or a workspace leader ({named}) may answer; the first answer counts."
        ),
    }
}

/// The approval DM for `notice` of `agent`, naming `requester` when the
/// spawning agent may answer it too.
#[cfg(test)]
pub(crate) fn approval_text(agent: &str, notice: &Notice, requester: Option<&str>) -> String {
    approval_text_with(agent, notice, requester, &[])
}

/// [`approval_text`], naming `leaders` too when they may answer it.
pub(crate) fn approval_text_with(
    agent: &str,
    notice: &Notice,
    requester: Option<&str>,
    leaders: &[String],
) -> String {
    let reference = &notice.reference;
    let response = if notice.approvable {
        format!("Reply `approve {reference}` or `deny {reference}` within 15 minutes.")
    } else if notice.options.is_empty() {
        format!("Reply `deny {reference}` within 15 minutes. This question cannot be approved through a Relay DM because it requires input or local verification.")
    } else {
        match requester {
            Some(name) => format!(
                "Options: {}. Only the signed-in machine owner may reply `choose {reference} <number>`; the owner or @{name} may reply `deny {reference}` within 15 minutes.",
                notice.options.join(", ")
            ),
            None => format!(
                "Options: {}. Reply `choose {reference} <number>` or `deny {reference}` within 15 minutes.",
                notice.options.join(", ")
            ),
        }
    };
    format!(
        "[Codex approval {reference} for @{agent}]\nStatus: `waiting_for_approval`. Unanswered requests expire as an explicit denial after 15 minutes.\n{}\n{response} {}",
        notice.description,
        who_may_answer_with(requester, leaders)
    )
}

/// The names of `leaders`, as a notice names them.
pub(crate) fn leader_names(leaders: &[WorkspaceLeader]) -> Vec<String> {
    leaders.iter().map(|leader| leader.name.clone()).collect()
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

    /// Sends `notice` to the verified owner and, when they may answer, the
    /// spawning agent and the workspace leaders. With neither owner nor
    /// requester it is never forwarded, and the request expires to a
    /// refusal.
    pub(crate) async fn forward_to_owner(
        &self,
        registration: &Registration,
        token: &Secret,
        notice: &Notice,
    ) {
        // A question goes to the question inbox instead, when escalation is
        // on; one it cannot send is forwarded as any other request.
        if self.escalate_codex_question(registration, notice).await {
            return;
        }
        let requester = self.approving_requester(registration);
        let leaders = self.notified_leaders(registration, notice.approvable).await;
        let text = approval_text_with(
            &registration.name,
            notice,
            requester.as_ref().map(|r| r.name.as_str()),
            &leader_names(&leaders),
        );
        if self
            .send_approval(
                registration,
                token,
                &notice.reference,
                &text,
                (requester, leaders),
            )
            .await
        {
            drive::mark_forwarded(&notice.reference);
        }
    }

    /// Sends an approval DM about `reference` to the verified owner, to
    /// `requester` and to `leaders` (already checked with
    /// [`Self::notified_leaders`]). True once the owner or the requester may
    /// answer it and both it is for have it; until then it is sent again,
    /// under the same keys. A leader's copy never counts: one that fails
    /// never holds the notice back or repeats the others, and is sent again
    /// (under its key) only while theirs are.
    pub(crate) async fn send_approval(
        &self,
        registration: &Registration,
        token: &Secret,
        reference: &str,
        text: &str,
        (requester, leaders): (Option<SpawnRequester>, Vec<WorkspaceLeader>),
    ) -> bool {
        let owner = self.verified_owner(registration).await;
        // A name can be taken again: the requester's copy goes to its saved
        // name only while Relaycast still gives it the requester's id.
        let (requester, mut sent) = match requester {
            None => (None, true),
            Some(requester) => match self
                .holds_name(registration, &requester.name, &requester.agent_id)
                .await
            {
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
        let base_url = registration.base_url.as_str();
        let send = |name: String, id: &str| {
            let key = format!("spawn-approval-{reference}-{}", MessageRef::of(id));
            async move { client::send_dm(base_url, token, &Endpoint::Name(name), text, Some(key)).await }
        };
        for (name, id) in &recipients {
            sent &= send(name.clone(), id).await.is_ok();
        }
        for leader in leaders {
            if recipients.iter().any(|(_, id)| *id == leader.agent_id) {
                continue;
            }
            let _ = send(leader.name, &leader.agent_id).await;
        }
        sent
    }

    /// Whether Relaycast still gives the saved `name` (a requester's or a
    /// listed leader's) its immutable `id` in `registration`'s workspace;
    /// `None` when it could not be asked, so the notice is sent again later.
    async fn holds_name(&self, registration: &Registration, name: &str, id: &str) -> Option<bool> {
        let workspace = self.workspace()?;
        if workspace.base_url != registration.base_url
            || registration.workspace_key.as_ref() != Some(&workspace.key)
        {
            return Some(false);
        }
        let http = sdk_gaps::workspace_http(&workspace).ok()?;
        let agent = sdk_gaps::get_agent(&http, name).await.ok()?;
        Some(agent.is_some_and(|agent| agent["id"].as_str() == Some(id)))
    }

    /// Whether workspace leaders may answer `registration`'s approve/deny
    /// requests at all: a build with an account, approvals from workspace
    /// leaders and native input from spawning agents on
    /// (`settings::leader_approvals`), and a spawned session not taken
    /// over. Neither `spawn_requester_approvals` nor the approval profile
    /// counts: those limit the spawning agent, and a leader's answer has the
    /// machine owner's standing.
    fn leaders_may_answer(&self, registration: &Registration) -> bool {
        self.plugins.account.is_some()
            && self.store.read(super::settings::leader_approvals)
            && registration
                .spawn
                .as_ref()
                .is_some_and(|spawn| spawn.taken_over_at.is_none())
    }

    /// Whether `id` may answer as a leader of `registration`: not the
    /// session itself, nor the agent that spawned it (which keeps the
    /// spawning agent's rules).
    fn leader_may_be(registration: &Registration, id: &str) -> bool {
        let requester = registration
            .spawn
            .as_ref()
            .and_then(|spawn| spawn.requester.as_ref())
            .map(|requester| requester.agent_id.as_str());
        !id.is_empty() && id != registration.agent_id && Some(id) != requester
    }

    /// The listed leaders to send an approval DM about a request of
    /// `registration` to: only for an `approvable` one, when leaders may
    /// answer it, from a list read successfully within `REFRESH_AFTER`,
    /// neither the session nor its requester (which has its own copy), and
    /// only those Relaycast still gives their listed name and id. Empty
    /// otherwise, and with the setting off.
    pub(crate) async fn notified_leaders(
        &self,
        registration: &Registration,
        approvable: bool,
    ) -> Vec<WorkspaceLeader> {
        if !approvable || !self.leaders_may_answer(registration) {
            return Vec::new();
        }
        let mut notified = Vec::new();
        for leader in self.verified_workspace_leaders(registration).await {
            if Self::leader_may_be(registration, &leader.agent_id)
                && self
                    .holds_name(registration, &leader.name, &leader.agent_id)
                    .await
                    == Some(true)
            {
                notified.push(leader);
            }
        }
        notified
    }

    /// The agent that spawned `registration`, when it may answer the
    /// session's requests: the machine owner's native-input and requester-
    /// approval settings permit it, the explicit profile does not restrict
    /// it to the owner, the session is not taken over, and its requester's
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
            .filter(|spawn| {
                spawn.taken_over_at.is_none()
                    && !matches!(
                        spawn.approval_profile,
                        Some(
                            super::wire::ApprovalProfile::Interactive
                                | super::wire::ApprovalProfile::FullAccess
                        )
                    )
            })
            .and_then(|spawn| spawn.requester.clone())
            .filter(|requester| !requester.agent_id.is_empty())
    }

    /// Whether `reference` is one of `registration`'s open requests, and
    /// then whether it may be approved (not a choice, form, input or local
    /// verification). An ended Claude's requests are not open: a message
    /// to it is settled as ended, never answered.
    async fn open_request(&self, registration: &Registration, reference: &str) -> Option<bool> {
        let thread = &registration.target.id;
        if driven_codex(registration) {
            return drive::pending_approvable(thread, reference);
        }
        if !self.driven_claude(registration) {
            return None;
        }
        let approvable =
            crate::relay::harness::claude::requests::pending_approvable(thread, reference)?;
        (!self.claude_ended(registration).await).then_some(approvable)
    }

    /// The workspace leader whose direct message `delivery` is, when it may
    /// approve or deny `reference` (`leaders_may_answer`): the sender is a
    /// listed leader by id alone, in a list read successfully within
    /// `REFRESH_AFTER`, neither the session nor its requester, and the
    /// reference is one of the session's open requests that may be
    /// approved.
    async fn approving_leader(
        &self,
        registration: &Registration,
        delivery: &Delivery,
        reference: &str,
    ) -> Option<WorkspaceLeader> {
        let sender_id = delivery.sender_id.as_deref()?;
        if !direct_from(delivery, Some(sender_id))
            || !Self::leader_may_be(registration, sender_id)
            || !self.leaders_may_answer(registration)
            || self.open_request(registration, reference).await != Some(true)
        {
            return None;
        }
        self.verified_workspace_leaders(registration)
            .await
            .into_iter()
            .find(|leader| leader.agent_id == sender_id)
    }

    /// Who may answer `reference` with `delivery`: the verified owner's
    /// direct message; a workspace leader's, when leaders may answer and the
    /// reference is an open request that may be approved
    /// (`approving_leader`); or the spawning agent's when it may answer and
    /// the reference is one of the session's open requests. A leader's or
    /// requester's reply to anything else (an answered, expired or ended
    /// request, or one a leader may not answer) is an ordinary message, so a
    /// session that ended still says so.
    async fn approver(
        &self,
        registration: &Registration,
        delivery: &Delivery,
        reference: &str,
    ) -> Option<Approver> {
        if let Some(owner_id) = self.owner_sent(registration, delivery).await {
            return Some(Approver::Owner(owner_id));
        }
        if let Some(leader) = self
            .approving_leader(registration, delivery, reference)
            .await
        {
            return Some(Approver::Leader(leader));
        }
        let requester = self.approving_requester(registration)?;
        let open = self.open_request(registration, reference).await.is_some();
        (open && direct_from(delivery, Some(&requester.agent_id)))
            .then_some(Approver::Requester(requester))
    }

    /// Whether this computer's ownership is verified for `registration`:
    /// its node is claimed by the signed-in person and `registration` is in
    /// their workspace.
    pub(crate) fn owned_here(&self, registration: &Registration) -> bool {
        self.workspace()
            .is_some_and(|workspace| self.owned_in(&workspace, registration))
    }

    /// [`Self::owned_here`] against one reading of the workspace.
    fn owned_in(&self, workspace: &Workspace, registration: &Registration) -> bool {
        claimed_by_signed_in(self)
            && workspace.base_url == registration.base_url
            && registration.workspace_key.as_ref() == Some(&workspace.key)
    }

    /// The signed-in person's relay identity, when this computer's node is
    /// claimed by them, `registration` is in their workspace, and Relaycast
    /// still gives the name their immutable id: (name, agent id).
    pub(crate) async fn verified_owner(
        &self,
        registration: &Registration,
    ) -> Option<(String, String)> {
        let workspace = self.workspace()?;
        if !self.owned_in(&workspace, registration) {
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

    /// Whether `delivery` is the verified owner's direct message (from the
    /// desktop or a phone) to an agent spawned here, not taken over, whose
    /// harness takes native input. Codex and Claude take it as a plain user
    /// turn (`owner_native_turn`); every other such harness takes it as
    /// native input that keeps the reply context, so the agent can still
    /// answer the owner.
    pub(crate) async fn owner_to_spawned(
        &self,
        registration: &Registration,
        delivery: &Delivery,
    ) -> bool {
        let spawned = registration
            .spawn
            .as_ref()
            .is_some_and(|spawn| spawn.taken_over_at.is_none());
        if !spawned
            || !direct_from(delivery, delivery.sender_id.as_deref())
            || !self.plugins.spawner.native_input(&registration.target)
        {
            return false;
        }
        // Someone else's message never waits on Relaycast: the identity
        // already in memory names the only id the lookup could confirm.
        if self
            .current_identity()
            .is_some_and(|person| delivery.sender_id.as_deref() != Some(person.agent_id.as_str()))
        {
            return false;
        }
        self.verified_owner(registration)
            .await
            .is_some_and(|(_, owner_id)| direct_from(delivery, Some(&owner_id)))
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
        // Choice replies answer a tool's input question, not a permission
        // prompt. Only the verified machine owner may supply that input; a
        // requester may still approve or deny where its profile permits it,
        // and a leader only a request that may be approved.
        if matches!(decision, ReplyDecision::Choose(_)) && !matches!(approver, Approver::Owner(_)) {
            return OwnerReply::NotOne;
        }
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
