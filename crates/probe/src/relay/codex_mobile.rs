//! Verified-owner tickets for one already accepted Codex mobile turn.
//! Subscription state is ephemeral; consumed provider requests are durable.
use crate::relay::cloud_session::CloudAccount;
use crate::relay::codex::follower::{ApprovalRequest, Decision, DecisionOutcome};
use crate::relay::daemon::Core;
use crate::relay::delivery::policy::Delivery;
use crate::relay::spawn::drive::{direct_from, OwnerReply};
use crate::relay::store::{Registration, SessionKind};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, oneshot};

mod description;
mod ledger;
pub mod provider;
#[cfg(test)]
mod tests;
mod worker;

const REFERENCE_HEX_LEN: usize = 16;
fn new_reference() -> String {
    let hex: String = crate::relay::store::random_uuid()
        .chars()
        .filter(|c| *c != '-')
        .take(REFERENCE_HEX_LEN)
        .collect();
    format!("cxm-{hex}")
}
fn mobile_reply_text(text: &str) -> Option<(&str, &str)> {
    let mut words = text.split_ascii_whitespace();
    let verb = words.next()?;
    let reference = words.next()?;
    let hex = reference.strip_prefix("cxm-")?;
    if words.next().is_some()
        || !matches!(verb, "approve" | "deny")
        || hex.len() != REFERENCE_HEX_LEN
        || !hex.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return None;
    }
    Some((verb, reference))
}
const MAX_SESSIONS: usize = 8;
const MAX_REQUESTS: usize = 16;
const TTL: Duration = Duration::from_secs(300);

#[derive(Clone)]
struct Authority {
    account: CloudAccount,
    registration: Registration,
    owner: String,
    message: String,
    generation: String,
}
struct Session {
    authority: Authority,
    sender: mpsc::Sender<Command>,
    ready: Option<Instant>,
    verified: Option<Instant>,
    revoked: bool,
    pending: Option<Authority>,
}
#[derive(Clone)]
struct Ticket {
    authority: Authority,
    scope: provider::Scope,
    request: ApprovalRequest,
    expires: Instant,
    key: String,
    description: String,
}
struct Command {
    reference: String,
    decision: Decision,
    reply: oneshot::Sender<DecisionOutcome>,
}
#[derive(Default)]
pub(crate) struct Manager {
    sessions: HashMap<String, Session>,
    tickets: HashMap<String, Ticket>,
}

fn same_registration(current: &Registration, original: &Registration) -> bool {
    current.agent_id == original.agent_id
        && current.target == original.target
        && current.base_url == original.base_url
        && current.workspace_key == original.workspace_key
        && current.registered_at == original.registered_at
        && current.name == original.name
        && current.route_binding == original.route_binding
        && current.spawn == original.spawn
        && current.alias == original.alias
        && current.retired_aliases == original.retired_aliases
        && current.archived_at.is_none()
}
enum OwnerProof {
    Current(String),
    Unavailable,
    Revoked,
}
impl Authority {
    fn current(&self, core: &Core) -> bool {
        !core.stopping()
            && core.native_account_current(&self.account)
            && core
                .native_continuation_registration(&self.registration)
                .is_some_and(|current| same_registration(&current, &self.registration))
            && core
                .delivery
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .codex_mobile
                .sessions
                .get(&self.registration.agent_id)
                .is_some_and(|session| {
                    !session.revoked && session.authority.generation == self.generation
                })
    }
    fn verified_current(&self, core: &Core) -> bool {
        let verified = core
            .delivery
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .codex_mobile
            .sessions
            .get(&self.registration.agent_id)
            .is_some_and(|session| {
                session.authority.generation == self.generation
                    && !session.revoked
                    && session
                        .verified
                        .is_some_and(|seen| seen.elapsed() < Duration::from_secs(5))
            });
        verified && self.current(core)
    }
    async fn check_owner(&self, core: &Core) -> OwnerProof {
        if !self.current(core) {
            return OwnerProof::Revoked;
        }
        let owner = core.verified_owner(&self.registration).await;
        if !self.current(core) {
            return OwnerProof::Revoked;
        }
        let proof = match owner {
            Some((name, id)) if id == self.owner => OwnerProof::Current(name),
            Some(_) => OwnerProof::Revoked,
            None => OwnerProof::Unavailable,
        };
        core.codex_owner_observed(self, &proof);
        proof
    }
    async fn owner(&self, core: &Core) -> Option<String> {
        match self.check_owner(core).await {
            OwnerProof::Current(name) => Some(name),
            _ => None,
        }
    }
}

impl Core {
    /// No provider/network work here. The accepted input's immutable authority
    /// starts at most one bounded background observer per canonical session.
    pub(crate) fn engage_codex_mobile(
        &self,
        account: CloudAccount,
        registration: Registration,
        owner: String,
        message: String,
    ) {
        if registration.target.kind != SessionKind::Codex
            || !self.native_account_current(&account)
            || !self
                .native_continuation_registration(&registration)
                .is_some_and(|current| same_registration(&current, &registration))
        {
            return;
        }
        let Some(core) = self.arc() else {
            return;
        };
        let authority = Authority {
            account,
            registration: registration.clone(),
            owner,
            message,
            generation: crate::relay::store::random_uuid(),
        };
        let (sender, receiver) = mpsc::channel(8);
        {
            let mut state = self
                .delivery
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let manager = &mut state.codex_mobile;
            if let Some(session) = manager.sessions.get_mut(&registration.agent_id) {
                if session.authority.message != authority.message {
                    session.revoked = true;
                    session.pending = Some(authority);
                }
                return;
            }
            if manager.sessions.len() >= MAX_SESSIONS {
                return;
            }
            manager.sessions.insert(
                registration.agent_id.clone(),
                Session {
                    authority: authority.clone(),
                    sender,
                    ready: None,
                    verified: None,
                    revoked: false,
                    pending: None,
                },
            );
        }
        tokio::spawn(async move {
            worker::run(core.clone(), authority.clone(), receiver).await;
            core.finish_codex_mobile(&authority);
        });
    }

    fn finish_codex_mobile(&self, authority: &Authority) {
        let pending = {
            let mut state = self
                .delivery
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let manager = &mut state.codex_mobile;
            let pending = if manager
                .sessions
                .get(&authority.registration.agent_id)
                .is_some_and(|session| session.authority.generation == authority.generation)
            {
                manager
                    .sessions
                    .remove(&authority.registration.agent_id)
                    .and_then(|session| session.pending)
            } else {
                None
            };
            manager
                .tickets
                .retain(|_, ticket| ticket.authority.generation != authority.generation);
            pending
        };
        self.mobile_handoff_changed(&authority.registration);
        if let Some(next) = pending {
            self.engage_codex_mobile(next.account, next.registration, next.owner, next.message);
        }
    }

    pub(crate) fn withdraw_codex_mobile(&self) {
        let mut state = self
            .delivery
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        for session in state.codex_mobile.sessions.values_mut() {
            session.revoked = true;
            session.pending = None;
            session.ready = None;
        }
        state.codex_mobile.tickets.clear();
    }

    fn codex_owner_observed(&self, authority: &Authority, proof: &OwnerProof) {
        let changed = {
            let mut state = self
                .delivery
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            state
                .codex_mobile
                .sessions
                .get_mut(&authority.registration.agent_id)
                .filter(|session| session.authority.generation == authority.generation)
                .is_some_and(|session| {
                    let valid = matches!(proof, OwnerProof::Current(_));
                    session.verified = valid.then(Instant::now);
                    if matches!(proof, OwnerProof::Revoked) {
                        session.revoked = true;
                        session.pending = None;
                    }
                    !valid && session.ready.take().is_some()
                })
        };
        if changed {
            self.mobile_handoff_changed(&authority.registration);
        }
    }

    pub(crate) fn codex_mobile_approvals_ready(&self, registration: &Registration) -> bool {
        let authority = {
            let state = self
                .delivery
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            state
                .codex_mobile
                .sessions
                .get(&registration.agent_id)
                .filter(|session| {
                    session
                        .ready
                        .is_some_and(|seen| seen.elapsed() < Duration::from_secs(10))
                        && session
                            .verified
                            .is_some_and(|seen| seen.elapsed() < Duration::from_secs(5))
                })
                .map(|session| session.authority.clone())
        };
        authority.is_some_and(|authority| {
            self.native_continuation_registration(registration)
                .is_some_and(|current| same_registration(&current, &authority.registration))
                && authority.current(self)
        })
    }

    // Classifying a reply does not approve anything. Use the signed-in
    // immutable identity even after opt-out/restart; a missing identity must
    // wait, not turn an approval reference into fresh native input.
    async fn codex_mobile_reply_owner(
        &self,
        registration: &Registration,
        delivery: &Delivery,
    ) -> Result<bool, ()> {
        let Some(canonical) = self.mobile_handoff_registration(registration) else {
            return Err(());
        };
        let workspace = self.workspace().ok_or(())?;
        if workspace.base_url != canonical.base_url
            || canonical.workspace_key.as_ref() != Some(&workspace.key)
        {
            return Err(());
        }
        let account = self.native_continuation_account().ok_or(())?;
        let owner = self.person_identity(false).await.map_err(|_| ())?;
        if !self.native_account_current(&account)
            || !self
                .mobile_handoff_registration(registration)
                .is_some_and(|current| same_registration(&current, &canonical))
            || self.workspace().is_none_or(|current| {
                current.base_url != workspace.base_url || current.key != workspace.key
            })
        {
            return Err(());
        }
        if owner.base_url != canonical.base_url {
            return Err(());
        }
        Ok(direct_from(delivery, Some(&owner.agent_id)))
    }

    pub(crate) async fn codex_mobile_reply(
        &self,
        registration: &Registration,
        delivery: &Delivery,
    ) -> Option<OwnerReply> {
        if registration.target.kind != SessionKind::Codex
            || !direct_from(delivery, delivery.sender_id.as_deref())
        {
            return None;
        }
        let (verb, reference) = mobile_reply_text(delivery.text.as_deref()?)?;
        match self.codex_mobile_reply_owner(registration, delivery).await {
            Ok(true) => {}
            Ok(false) => return None,
            Err(()) => return Some(OwnerReply::Unsaved),
        }
        let parsed = if verb == "approve" {
            crate::relay::spawn::drive::ReplyDecision::Approve
        } else {
            crate::relay::spawn::drive::ReplyDecision::Deny
        };
        let context = {
            let state = self
                .delivery
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            state
                .codex_mobile
                .tickets
                .get(reference)
                .and_then(|ticket| {
                    state
                        .codex_mobile
                        .sessions
                        .get(&ticket.authority.registration.agent_id)
                        .map(|session| (ticket.clone(), session.sender.clone()))
                })
        };
        let Some((ticket, sender)) = context else {
            return Some(OwnerReply::Settled(
                "This mobile approval reference expired or is unavailable. No approval was sent."
                    .into(),
            ));
        };
        if !direct_from(delivery, Some(&ticket.authority.owner))
            || !self
                .native_continuation_registration(registration)
                .is_some_and(|current| same_registration(&current, &ticket.authority.registration))
            || ticket.expires <= Instant::now()
            || ticket.authority.owner(self).await.is_none()
        {
            return Some(OwnerReply::Settled("This mobile approval reply is not currently authorized. No approval was sent; check the reference or retry verification.".into()));
        }
        let decision = match parsed {
            crate::relay::spawn::drive::ReplyDecision::Approve => Decision::Accept,
            crate::relay::spawn::drive::ReplyDecision::Deny => Decision::Decline,
            _ => {
                return Some(OwnerReply::Settled(
                    "This Codex request accepts approve or deny only.".into(),
                ))
            }
        };
        if !ticket.request.allows(decision) {
            return Some(OwnerReply::Settled(
                "That decision is not offered by this Codex request.".into(),
            ));
        }
        if self
            .store
            .remember(|store| store.record_injected(&delivery.id))
            .is_err()
        {
            return Some(OwnerReply::Unsaved);
        }
        let (reply, received) = oneshot::channel();
        if sender
            .try_send(Command {
                reference: reference.into(),
                decision,
                reply,
            })
            .is_err()
        {
            return Some(OwnerReply::Settled(
                "The mobile approval observer is unavailable; use the existing Codex window."
                    .into(),
            ));
        }
        let outcome = tokio::time::timeout(Duration::from_secs(45), received).await;
        let text=match outcome {
            Ok(Ok(DecisionOutcome::AcknowledgedUnconfirmed))=>"The Codex window acknowledged the reply. It may already have been resolved on desktop; application is unconfirmed.",
            Ok(Ok(DecisionOutcome::Refused))=>"No approval was sent: the request, authority, or decision storage was no longer available.",
            _=>"The approval reply is unconfirmed and will not be resent. Check the existing Codex window.",
        };
        Some(OwnerReply::Settled(text.into()))
    }
}
