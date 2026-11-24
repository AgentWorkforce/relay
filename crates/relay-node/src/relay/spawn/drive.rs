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
//! is sent the requests it may approve or deny and may approve or deny them
//! as the machine owner could, whatever the spawn's approval profile
//! (`Approver::Leader`, `relay::leaders`); choices, forms, input and local
//! verification stay with the owner. With **Approvals from the owner's
//! delegates** on (`spawn_delegate_approvals`, on unless turned off), a
//! delegate of the machine owner whose reply carries an owner approval that
//! Agent Relay Cloud attests as a `prompt_approval` of exactly that request
//! may approve or deny it too (`Approver::Delegate`, `delegate`).

use crate::relay::claude_delivery_policy::Decision as ClaudeConsent;
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
use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::{Duration, Instant};

pub(crate) mod claude;
mod delegate;
pub(crate) use delegate::DelegateApprover;

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
pub(crate) const ONE_TO_ONE_DM_CHANNEL: &str = "dmch_";

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

/// What Relaycast says of the 1:1 conversation between a session and a peer
/// (`Core::pair_conversation`). Relaycast lets a participant add a third
/// agent to a 1:1 conversation (`POST /v1/dm/{id}/participants`), keeping
/// its type and `dmch_` channel, so neither proves a message private.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PairConversation {
    /// It exists, with exactly the session and the peer as participants.
    Private,
    /// None is listed: none exists yet, or the session left it (Relaycast
    /// no longer lists it to the session). Never safe for a notice.
    Absent,
    /// One has (or had) another participant.
    Shared,
    /// Relaycast could not be asked.
    Unknown,
}

/// How long the conversation lookup may take.
const PAIR_LOOKUP_WAIT: Duration = Duration::from_secs(3);

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
    /// A workspace leader, by agent id, approving or denying an approvable
    /// request as the machine owner could; never a choice, form, input or
    /// local verification. Never recorded as the owner.
    Leader(WorkspaceLeader),
    /// A delegate of the machine owner, approving or denying one approvable
    /// request named by an attested `prompt_approval` (`delegate`), Codex
    /// extra-permission requests included; never a choice, form, input or
    /// local verification. Never recorded as the owner.
    Delegate(DelegateApprover),
}

impl Approver {
    /// The immutable Relaycast id an answer must come from.
    pub(crate) fn id(&self) -> &str {
        match self {
            Approver::Owner(id) => id,
            Approver::Requester(requester) => &requester.agent_id,
            Approver::Leader(leader) => &leader.agent_id,
            Approver::Delegate(delegate) => &delegate.agent_id,
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
            Approver::Delegate(delegate) => delegate.describe(),
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

/// Which workspace leaders an approval DM says may answer it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Leaders {
    /// None: the setting is off, or the request may not be approved.
    Not,
    /// Any listed leader.
    Listed,
    /// Only a listed leader that is one of the organization's admins: the
    /// organization holds every other sender's messages.
    Admins,
    /// The copy for one of the machine owner's delegates (`delegate`): its
    /// closing says how a delegate answers, not who else may.
    Delegate,
}

/// The closing line of an approval DM that a workspace leader may answer
/// too (`leaders`); without, [`who_may_answer`]. It never names the
/// leaders: one fixed sentence, so the text never waits for the list or
/// changes with it.
pub(crate) fn who_may_answer_with(requester: Option<&str>, leaders: Leaders) -> String {
    let leader = match leaders {
        Leaders::Not => return who_may_answer(requester),
        Leaders::Delegate => {
            return "As a delegate of the machine owner you may answer too, as the next line \
                    says; the first answer counts."
                .into()
        }
        Leaders::Listed => "a workspace leader",
        Leaders::Admins => "a workspace leader that is one of the organization's admins",
    };
    match requester {
        None => {
            format!("The signed-in machine owner or {leader} may answer; the first answer counts.")
        }
        Some(name) => format!(
            "The signed-in machine owner, @{name} (the agent that spawned this session) \
             or {leader} may answer; the first answer counts."
        ),
    }
}

/// The approval DM for `notice` of `agent`, naming `requester` when the
/// spawning agent may answer it too.
#[cfg(test)]
pub(crate) fn approval_text(agent: &str, notice: &Notice, requester: Option<&str>) -> String {
    approval_text_with(agent, notice, requester, Leaders::Not)
}

/// [`approval_text`], saying which workspace leaders may answer too
/// (`leaders`).
pub(crate) fn approval_text_with(
    agent: &str,
    notice: &Notice,
    requester: Option<&str>,
    leaders: Leaders,
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

/// Sends `text`, the approval DM about `reference`, to `name` (agent id
/// `id`), under the request's key for that recipient.
async fn send_approval_dm(
    base_url: &str,
    token: &Secret,
    reference: &str,
    text: &str,
    name: &str,
    id: &str,
) -> relaycast::Result<client::Sent> {
    send_approval_dm_keyed(base_url, token, "spawn-approval", reference, text, name, id).await
}

/// [`send_approval_dm`] under a key of its own kind (`kind`): a delegate's
/// copy differs from a leader's, so an agent that is both gets both.
async fn send_approval_dm_keyed(
    base_url: &str,
    token: &Secret,
    kind: &str,
    reference: &str,
    text: &str,
    name: &str,
    id: &str,
) -> relaycast::Result<client::Sent> {
    let key = format!("{kind}-{reference}-{}", MessageRef::of(id));
    client::send_dm(
        base_url,
        token,
        &Endpoint::Name(name.into()),
        text,
        Some(key),
    )
    .await
}

/// How many times at most a leader's copy of an approval DM is sent: once,
/// and again only after a failed send, never once per watcher tick.
pub(crate) const LEADER_SENDS: u32 = 3;

/// What one try at a leader's copy of an approval DM may do.
enum LeaderTry {
    /// Send it, to this name, which Relaycast gave the leader's id just now.
    Send(String),
    /// Not this try: something could not be asked. It counts as a try.
    Skip,
    /// Never again for this leader and request.
    Stop,
}

/// The wait before a leader's failed copy is sent again.
#[cfg(not(test))]
const LEADER_RESEND_AFTER: Duration = Duration::from_secs(5);
#[cfg(test)]
const LEADER_RESEND_AFTER: Duration = Duration::from_millis(50);

/// How long a request's fixed approval DM is kept: longer than any request
/// stays open (Codex's 15 minutes, Claude's five).
const PLAN_KEPT: Duration = Duration::from_secs(20 * 60);

/// The approval DM of each request forwarded, by reference, as its first
/// try fixed it: every later try sends the same text under the same keys.
fn plans() -> MutexGuard<'static, HashMap<String, (Instant, String)>> {
    static PLANS: OnceLock<Mutex<HashMap<String, (Instant, String)>>> = OnceLock::new();
    PLANS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
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
    /// spawning agent; with approvals from workspace leaders on, it goes to
    /// the listed leaders too (`notify_leaders`), once, apart from the
    /// others. Only the owner's or the requester's copy marks it forwarded:
    /// with neither it is tried again each tick (the leaders' copies are
    /// not) until the request expires to a refusal.
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
        let text = self.approval_plan(
            registration,
            token,
            &notice.reference,
            notice.approvable,
            |leaders| {
                approval_text_with(
                    &registration.name,
                    notice,
                    requester.as_ref().map(|r| r.name.as_str()),
                    leaders,
                )
            },
        );
        if self
            .send_approval(registration, token, &notice.reference, &text, requester)
            .await
        {
            drive::mark_forwarded(&notice.reference);
        }
    }

    /// The approval DM about `reference`, fixed by the first try to send
    /// it (`text`, told which workspace leaders may answer), so every
    /// later try sends the same text under the same keys. That first try
    /// also starts the leaders' copies (`notify_leaders`) when the request
    /// is `approvable` and leaders may answer: never again for the request,
    /// and never waited for. While the organization holds messages from
    /// senders who are not its admins, the text says only a leader that is
    /// one of its admins may answer: no other leader's answer is taken then
    /// (`approving_leader`). The text is fixed by that first try; a hold
    /// that begins or ends later changes who is sent copies and whose
    /// answer is taken, not the text.
    pub(crate) fn approval_plan(
        &self,
        registration: &Registration,
        token: &Secret,
        reference: &str,
        approvable: bool,
        text: impl Fn(Leaders) -> String,
    ) -> String {
        let leaders;
        let planned = {
            let mut plans = plans();
            plans.retain(|_, (at, _)| at.elapsed() < PLAN_KEPT);
            if let Some((_, text)) = plans.get(reference) {
                return text.clone();
            }
            leaders = if !approvable || !self.leaders_may_answer(registration) {
                Leaders::Not
            } else if self.claude_delivery.organization_holds() {
                Leaders::Admins
            } else {
                Leaders::Listed
            };
            let text = text(leaders);
            plans.insert(reference.into(), (Instant::now(), text.clone()));
            text
        };
        if leaders != Leaders::Not {
            self.notify_leaders(registration, token, reference, &planned);
        }
        // The machine owner's delegates Cloud names get a copy too, once,
        // in the background (`delegate::notify_delegates`).
        if approvable && self.delegates_may_answer(registration) {
            self.notify_delegates(registration, token, reference, &text(Leaders::Delegate));
        }
        planned
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
        for (name, id) in recipients {
            sent &= send_approval_dm(&registration.base_url, token, reference, text, &name, &id)
                .await
                .is_ok();
        }
        sent
    }

    /// Sends `text`, the approval DM about `reference`, to each workspace
    /// leader `leaders_to_notify` gives, in the background: each is sent
    /// one copy, sent again after a failure at most [`LEADER_SENDS`] times
    /// in all. Never the signed-in person, who has the owner's copy.
    ///
    /// Every try, the first included, checks again just before it sends
    /// (`leader_try`): the request is open, leaders may answer, the leader
    /// is still listed with its id and may answer this session, the
    /// organization's hold (if any) lets it answer, and Relaycast gives its
    /// name its id now. A copy goes only to a name Relaycast has just said
    /// is the leader's. Relaycast addresses a DM by name, not by id, so a
    /// name taken by another agent between that check and the send is
    /// not caught: the check narrows that window, it does not close it.
    fn notify_leaders(
        &self,
        registration: &Registration,
        token: &Secret,
        reference: &str,
        text: &str,
    ) {
        let Some(core) = self.arc() else {
            return;
        };
        let (registration, token) = (registration.clone(), token.clone());
        let (reference, text) = (reference.to_string(), text.to_string());
        tokio::spawn(async move {
            let person = core.current_identity().map(|person| person.agent_id);
            let leaders = core
                .leaders_to_notify(&registration)
                .await
                .into_iter()
                .filter(|leader| Some(&leader.agent_id) != person.as_ref());
            let (core, registration) = (&core, &registration);
            let (token, reference, text) = (&token, reference.as_str(), text.as_str());
            futures_util::future::join_all(leaders.map(|leader| {
                let copy = async move {
                    let id = &leader.agent_id;
                    for send in 0..LEADER_SENDS {
                        if send > 0 {
                            tokio::time::sleep(LEADER_RESEND_AFTER).await;
                        }
                        let name = match core.leader_try(registration, token, reference, id).await {
                            LeaderTry::Send(name) => name,
                            LeaderTry::Skip => continue,
                            LeaderTry::Stop => return,
                        };
                        let base_url = &registration.base_url;
                        if send_approval_dm(base_url, token, reference, text, &name, id)
                            .await
                            .is_ok()
                        {
                            return;
                        }
                    }
                };
                async move {
                    copy.await;
                    core.note_copy_settled();
                }
            }))
            .await;
        });
    }

    /// Counts a leader's or delegate's copy of an approval DM whose tries
    /// are over (sent, stopped or out of tries), for tests to wait on.
    pub(crate) fn note_copy_settled(&self) {
        #[cfg(test)]
        self.notice_copies_settled
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }

    /// Whether one try at the leader `id`'s copy of the approval DM about
    /// `reference` may send it, and to which name. Each awaited check comes
    /// first and the request, the setting and the organization's hold are
    /// read again after them, so a change while Relaycast was asked wins.
    async fn leader_try(
        &self,
        registration: &Registration,
        token: &Secret,
        reference: &str,
        id: &str,
    ) -> LeaderTry {
        if self.open_request(registration, reference).await != Some(true)
            || !self.leaders_may_answer_now(registration)
            || !Self::leader_may_be(registration, id)
        {
            return LeaderTry::Stop;
        }
        let Some(listed) = self.verified_workspace_leaders_read(registration).await else {
            return LeaderTry::Skip;
        };
        let Some(leader) = listed.into_iter().find(|leader| leader.agent_id == id) else {
            return LeaderTry::Stop;
        };
        match self.holds_name(registration, &leader.name, id).await {
            Some(true) => {}
            Some(false) => return LeaderTry::Stop,
            None => return LeaderTry::Skip,
        }
        // Only into a conversation Relaycast lists with just the two of
        // them: never one someone else was added to, nor one the session
        // left (unlisted), whose other members a send cannot see.
        match self.pair_conversation(registration, token, id).await {
            PairConversation::Private => {}
            PairConversation::Absent | PairConversation::Shared => return LeaderTry::Stop,
            PairConversation::Unknown => return LeaderTry::Skip,
        }
        if self.open_request(registration, reference).await != Some(true)
            || !self.leaders_may_answer_now(registration)
        {
            return LeaderTry::Stop;
        }
        // While the organization holds, only an admin's answer is taken,
        // and its admins are named, not given by id: the verified name
        // must be one. Not this try otherwise: the hold may be lifted.
        if self.claude_delivery.organization_admin_name(&leader.name) == Some(false) {
            return LeaderTry::Skip;
        }
        LeaderTry::Send(leader.name)
    }

    /// The 1:1 conversation between `registration` and `peer_id`, as
    /// Relaycast lists `registration`'s conversations (`GET
    /// /v1/dm/conversations`, with its own `token`): every 1:1 conversation
    /// that includes the peer must have exactly the two of them as
    /// participants, a participant who left included. Used wherever a
    /// leader's or delegate's message counts as a 1:1 direct message, and
    /// before a notice is sent to one, never on the conversation type alone.
    pub(crate) async fn pair_conversation(
        &self,
        registration: &Registration,
        token: &Secret,
        peer_id: &str,
    ) -> PairConversation {
        self.pair_conversation_in(registration, token, peer_id, None)
            .await
    }

    /// [`Self::pair_conversation`], limited to the conversation of
    /// `channel` (`dmch_<key>` is conversation `dm_<key>`) when a reply names
    /// the one that carried it: another conversation with the peer does not
    /// decide it.
    pub(crate) async fn pair_conversation_in(
        &self,
        registration: &Registration,
        token: &Secret,
        peer_id: &str,
        channel: Option<&str>,
    ) -> PairConversation {
        let carried = channel
            .and_then(|channel| channel.strip_prefix(ONE_TO_ONE_DM_CHANNEL))
            .map(|key| format!("dm_{key}"));
        let Ok(http) = sdk_gaps::http(&registration.base_url, token) else {
            return PairConversation::Unknown;
        };
        let list = tokio::time::timeout(PAIR_LOOKUP_WAIT, sdk_gaps::dm_conversations(&http)).await;
        let Ok(Ok(list)) = list else {
            return PairConversation::Unknown;
        };
        let pair: HashSet<&str> = [registration.agent_id.as_str(), peer_id].into();
        let mut found = false;
        for conversation in list.iter().filter(|c| {
            c["type"].as_str() == Some("1:1")
                && carried
                    .as_deref()
                    .is_none_or(|id| c["id"].as_str() == Some(id))
        }) {
            let ids: HashSet<&str> = conversation["participants"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|p| p["agent_id"].as_str())
                .collect();
            if !ids.contains(peer_id) {
                continue;
            }
            let others = conversation["participants"]
                .as_array()
                .map_or(0, |p| p.len());
            if ids != pair || others != 2 {
                return PairConversation::Shared;
            }
            found = true;
        }
        match found {
            true => PairConversation::Private,
            false => PairConversation::Absent,
        }
    }

    /// Whether the reply `delivery` from `sender_id` came in the private
    /// 1:1 conversation of `registration` and the sender: the conversation
    /// that carried it when the delivery names its channel, else every 1:1
    /// conversation with the sender.
    async fn in_private_pair(
        &self,
        registration: &Registration,
        delivery: &Delivery,
        sender_id: &str,
    ) -> bool {
        let Some((_, token)) = self
            .agent_credential(&registration.name)
            .filter(|(current, _)| current.agent_id == registration.agent_id)
        else {
            return false;
        };
        self.pair_conversation_in(
            registration,
            &token,
            sender_id,
            delivery.channel_id.as_deref(),
        )
        .await
            == PairConversation::Private
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
    /// requests at all: a build with an account, a workspace that is not
    /// gate-only (`leader_approvals_unavailable`), approvals from workspace
    /// leaders and native input from spawning agents on
    /// (`settings::leader_approvals`), and a spawned session not taken
    /// over. Neither `spawn_requester_approvals` nor the approval profile
    /// (`interactive` included) counts: those limit the spawning agent, and
    /// a leader's approve or deny counts as the machine owner's would.
    fn leaders_may_answer(&self, registration: &Registration) -> bool {
        self.plugins.account.is_some()
            && self.leader_approvals_unavailable().is_none()
            && self.store.read(super::settings::leader_approvals)
            && registration
                .spawn
                .as_ref()
                .is_some_and(|spawn| spawn.taken_over_at.is_none())
    }

    /// [`Self::leaders_may_answer`] for `registration` as the store saves it
    /// now: false once it is gone.
    fn leaders_may_answer_now(&self, registration: &Registration) -> bool {
        self.store
            .read(|store| {
                store
                    .registrations
                    .iter()
                    .find(|saved| saved.agent_id == registration.agent_id)
                    .cloned()
            })
            .is_some_and(|saved| self.leaders_may_answer(&saved))
    }

    /// Whether `id` may answer as a leader of `registration`: not the
    /// session itself, nor the agent that spawned it (which keeps the
    /// spawning agent's rules). Only these two are refused: a session a
    /// leader asked another agent to spawn, or a leader that is itself a
    /// spawned session, is not.
    fn leader_may_be(registration: &Registration, id: &str) -> bool {
        let requester = registration
            .spawn
            .as_ref()
            .and_then(|spawn| spawn.requester.as_ref())
            .map(|requester| requester.agent_id.as_str());
        !id.is_empty() && id != registration.agent_id && Some(id) != requester
    }

    /// The listed leaders to try to send an approval DM about a request of
    /// `registration` to, when leaders may answer it: from a list read
    /// successfully within `REFRESH_AFTER`, and neither the session nor its
    /// requester (which has its own copy). Each try checks the rest again
    /// (`leader_try`). Empty otherwise, and with the setting off.
    pub(crate) async fn leaders_to_notify(
        &self,
        registration: &Registration,
    ) -> Vec<WorkspaceLeader> {
        if !self.leaders_may_answer(registration) {
            return Vec::new();
        }
        self.verified_workspace_leaders(registration)
            .await
            .into_iter()
            .filter(|leader| Self::leader_may_be(registration, &leader.agent_id))
            .collect()
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

    /// Whether the organization's hold, while there is one, lets
    /// `delivery` into `registration` act for the person: only when the
    /// delivery policy's own decision for it is to deliver it
    /// (`ClaudeDeliveryPolicy::organization_decision`, the rule `decide`
    /// applies). Without a hold, always.
    fn organization_admits(&self, registration: &Registration, delivery: &Delivery) -> bool {
        self.claude_delivery
            .organization_decision(registration, delivery)
            .is_none_or(|decision| decision == ClaudeConsent::Deliver)
    }

    /// The workspace leader whose direct message `delivery` is, when it may
    /// approve or deny `reference` (`leaders_may_answer`): the sender is a
    /// listed leader by id alone, in a list read successfully within
    /// `REFRESH_AFTER`, neither the session nor its requester, the
    /// reference is one of the session's open requests that may be
    /// approved, and the organization's hold, while there is one, would
    /// deliver the message (`organization_admits`). Otherwise the message
    /// takes the ordinary path, where that hold keeps it for the person.
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
            || !self.organization_admits(registration, delivery)
            || self.open_request(registration, reference).await != Some(true)
            || !self
                .in_private_pair(registration, delivery, sender_id)
                .await
        {
            return None;
        }
        let leader = self
            .verified_workspace_leaders(registration)
            .await
            .into_iter()
            .find(|leader| leader.agent_id == sender_id)?;
        // Reading the list can take a while: the setting turned off, the
        // session taken over, or an organization hold begun meanwhile makes
        // no approver.
        (self
            .in_private_pair(registration, delivery, sender_id)
            .await
            && self.leaders_may_answer_now(registration)
            && self.organization_admits(registration, delivery))
        .then_some(leader)
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
        if let Some(delegate) = self
            .approving_delegate(registration, delivery, reference)
            .await
        {
            return Some(Approver::Delegate(delegate));
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
