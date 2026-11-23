//! The machine owner's delegates as approvers of spawned sessions' requests
//! (`Approver::Delegate`, design §9.3).
//!
//! With **Approvals from the owner's delegates** on (`spawn_delegate_approvals`,
//! on unless the person turns it off) and `delegated_approvals_from` not
//! `off`, a delegate's 1:1 direct message `approve <ref>` or `deny <ref>`
//! answers a spawned session's open request when Agent Relay Cloud attests
//! its owner approval (`relay::delegation`) as exactly one action
//! `{class: "prompt_approval", target: "<session agent id>:<ref>:approve"}`
//! (or `:deny`, matching the reply's verb; no conditions), with
//! the owner's own standing (never a code owner's), from the sender itself,
//! for an owner who is this computer's signed-in person (by Cloud human id).
//! It answers what a leader may (`Approver::Leader`), Codex's requests for
//! extra permissions included (permissions are delegable): never a choice,
//! form, `AskUserQuestion`, dialog or local verification. Never the session's own agent, the agent that spawned
//! it or its launcher, a session taken over, or on a gate-only install.
//! Under an organization hold the leaders' rule applies. Independent of
//! `spawn_leader_approvals` and `spawn_native_input`.
//!
//! Approval notices also go to the delegates Cloud names for the session
//! (`POST /messaging/delegation/prompt-delegates`), each re-checked before
//! every send, at most [`LEADER_SENDS`] tries.

use super::*;
use crate::relay::delegation::{self, Accept, PROMPT_APPROVAL};

/// A delegate of the machine owner, answering one request with an
/// attested `prompt_approval`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DelegateApprover {
    pub name: String,
    pub agent_id: String,
    /// The owner as the attestation names them (`policy::owner_display`).
    pub owner: String,
    pub grant_id: String,
}

impl DelegateApprover {
    pub(crate) fn describe(&self) -> String {
        format!(
            "the delegate @{} ({}) of {}, grant {}",
            self.name, self.agent_id, self.owner, self.grant_id
        )
    }
}

/// The line under a delegate's copy of an approval DM: how it answers.
pub(crate) fn delegate_note(registration: &Registration, reference: &str) -> String {
    format!(
        "As a delegate of the machine owner you may answer: send `approve {reference}` or \
         `deny {reference}` with an owner_approval whose one action is \
         {{\"class\":\"prompt_approval\",\"target\":\"{id}:{reference}:approve\"}} \
         (`{id}:{reference}:deny` to deny), with no conditions.",
        id = registration.agent_id
    )
}

/// What one try at a delegate's copy of an approval DM may do.
enum DelegateTry {
    Send(String),
    Skip,
    Stop,
}

impl Core {
    /// Whether the owner's delegates may answer `registration`'s requests at
    /// all: signed in to Cloud, not gate-only, `delegated_approvals_from` not
    /// `off`, `spawn_delegate_approvals` on, and a spawned session not taken
    /// over.
    pub(super) fn delegates_may_answer(&self, registration: &Registration) -> bool {
        self.plugins.cloud.account().is_some()
            && self.delegation_unavailable().is_none()
            && self.store.read(|store| {
                delegation::accept(store) != Accept::Off
                    && delegation::spawn_delegate_approvals(store)
            })
            && registration
                .spawn
                .as_ref()
                .is_some_and(|spawn| spawn.taken_over_at.is_none())
    }

    /// [`Self::delegates_may_answer`] for `registration` as saved now.
    fn delegates_may_answer_now(&self, registration: &Registration) -> bool {
        self.store
            .read(|store| {
                store
                    .registrations
                    .iter()
                    .find(|saved| saved.agent_id == registration.agent_id)
                    .cloned()
            })
            .is_some_and(|saved| self.delegates_may_answer(&saved))
    }

    /// Whether `id` may answer as a delegate for `registration`: not the
    /// session itself, the agent that spawned it, or its launcher.
    fn delegate_may_be(registration: &Registration, id: &str) -> bool {
        let spawn = registration.spawn.as_ref();
        let requester = spawn
            .and_then(|spawn| spawn.requester.as_ref())
            .map(|r| r.agent_id.as_str());
        let launcher = spawn
            .and_then(|spawn| spawn.launcher.as_ref())
            .map(|l| l.agent_id.as_str());
        !id.is_empty()
            && id != registration.agent_id
            && Some(id) != requester
            && Some(id) != launcher
    }

    /// Whether `reference` is an open request a delegate may answer: one
    /// that may be approved (Codex extra-permission requests included,
    /// permissions being delegable); never a choice, form, input or local
    /// verification.
    async fn delegate_request(&self, registration: &Registration, reference: &str) -> bool {
        self.open_request(registration, reference).await == Some(true)
    }

    /// The delegate whose direct message `delivery` is, when it may approve
    /// or deny `reference`: see the module comment. Checked again after
    /// Cloud's attestation comes back, so a change meanwhile wins.
    pub(super) async fn approving_delegate(
        &self,
        registration: &Registration,
        delivery: &Delivery,
        reference: &str,
    ) -> Option<DelegateApprover> {
        if !delivery.has_owner_approval {
            return None;
        }
        let sender_id = delivery.sender_id.as_deref()?;
        if !direct_from(delivery, Some(sender_id))
            || !Self::delegate_may_be(registration, sender_id)
            || !self.delegates_may_answer(registration)
            || !self.organization_admits(registration, delivery)
            || !self.delegate_request(registration, reference).await
            || !self
                .in_private_pair(registration, delivery, sender_id)
                .await
        {
            return None;
        }
        let (_, token) = self
            .agent_credential(&registration.name)
            .filter(|(current, _)| current.agent_id == registration.agent_id)?;
        let attestation = self
            .attest_delegation(registration, delivery, &token)
            .await?;
        let claims = &attestation.claims;
        // The decision is bound in the target: `…:approve` answers only an
        // `approve <ref>` reply, `…:deny` only a `deny <ref>` one.
        let verb = match parse_reply(delivery.text.as_deref().unwrap_or_default()) {
            Some((ReplyDecision::Approve, _)) => "approve",
            Some((ReplyDecision::Deny, _)) => "deny",
            _ => return None,
        };
        let target = format!("{}:{reference}:{verb}", registration.agent_id);
        let [action] = claims.actions.as_slice() else {
            return None;
        };
        // Only a delegate of the person who owns this computer answers its
        // prompts (§9.3): the owner Cloud attests must be the signed-in
        // machine owner, by Cloud human id, with their own standing. An
        // unknown signed-in owner answers nothing.
        let machine_owner = self
            .plugins
            .cloud
            .account()
            .and_then(|account| account.user_id)
            .filter(|id| !id.is_empty());
        if action.class != PROMPT_APPROVAL
            || action.target != target
            || claims.standing != "own_owner"
            || machine_owner.as_deref() != Some(claims.owner_id.as_str())
            || claims.delegate_agent_id != sender_id
            // A prompt approval takes no conditions.
            || !action.conditions.is_empty()
        {
            crate::relay::diagnostics::write(format_args!(
                "relay: delegate approval: message {}: not a prompt approval of {target} \
                 by a delegate of this computer's signed-in owner, with their own standing",
                delivery.message_id
            ));
            return None;
        }
        // The awaited check first, the synchronous ones last: nothing can
        // change between them and the answer.
        let exp = claims.exp;
        (self.delegate_request(registration, reference).await
            && self.in_private_pair(registration, delivery, sender_id).await
            // The attestation must still be live when the answer is taken.
            && crate::relay::state::now_ms() / 1000 < exp
            && self.delegates_may_answer_now(registration)
            && self.organization_admits(registration, delivery))
        .then(|| DelegateApprover {
            name: delivery.sender.clone().unwrap_or_default(),
            agent_id: sender_id.to_string(),
            owner: crate::relay::delivery::policy::owner_display(claims.owner_display.as_deref()),
            grant_id: claims.grant_id.clone(),
        })
    }

    /// The delegates Cloud names for `registration` (`prompt-delegates`):
    /// the machine owner's delegates whose `prompt_approval` targets cover
    /// the session, by agent id. `None` when Cloud cannot be asked.
    pub(crate) async fn prompt_delegates(
        &self,
        registration: &Registration,
        token: &Secret,
    ) -> Option<Vec<String>> {
        let account = self.plugins.cloud.account()?;
        let path = format!(
            "/workspaces/{}/messaging/delegation/prompt-delegates",
            crate::relay::cloud_session::segment(&account.workspace_id)
        );
        let body = serde_json::json!({
            "session_agent_id": registration.agent_id,
            "session_token": token.expose(),
        });
        let answer = self
            .plugins
            .cloud
            .request("POST", path, Some(body))
            .await
            .ok()?;
        answer["delegates"].as_array()?;
        let mut ids: Vec<String> = answer["delegates"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|delegate| delegate["agent_id"].as_str())
            .filter(|id| !id.is_empty())
            .map(str::to_string)
            .collect();
        ids.sort();
        ids.dedup();
        Some(ids)
    }

    /// Sends `text`, the approval DM about `reference`, with
    /// [`delegate_note`], to each delegate [`Self::prompt_delegates`] names,
    /// in the background: at most [`LEADER_SENDS`] tries each, every one
    /// checked again first (`delegate_try`). Never the signed-in person.
    pub(super) fn notify_delegates(
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
        let reference = reference.to_string();
        let text = format!("{text}\n{}", delegate_note(&registration, &reference));
        tokio::spawn(async move {
            // Discovery has bounded tries of its own, while the request is
            // open and delegates may answer: a failed read is not an empty
            // list.
            let mut listed = None;
            for attempt in 0..LEADER_SENDS {
                if attempt > 0 {
                    tokio::time::sleep(LEADER_RESEND_AFTER).await;
                }
                if !core.delegate_request(&registration, &reference).await
                    || !core.delegates_may_answer_now(&registration)
                {
                    return;
                }
                listed = core.prompt_delegates(&registration, &token).await;
                if listed.is_some() {
                    break;
                }
            }
            let person = core.current_identity().map(|person| person.agent_id);
            let delegates = listed
                .unwrap_or_default()
                .into_iter()
                .filter(|id| Some(id) != person.as_ref())
                .filter(|id| Self::delegate_may_be(&registration, id));
            let (core, registration) = (&core, &registration);
            let (token, reference, text) = (&token, reference.as_str(), text.as_str());
            futures_util::future::join_all(delegates.map(|id| {
                let copy = async move {
                    for send in 0..LEADER_SENDS {
                        if send > 0 {
                            tokio::time::sleep(LEADER_RESEND_AFTER).await;
                        }
                        let name =
                            match core.delegate_try(registration, token, reference, &id).await {
                                DelegateTry::Send(name) => name,
                                DelegateTry::Skip => continue,
                                DelegateTry::Stop => return,
                            };
                        let base_url = &registration.base_url;
                        if send_approval_dm_keyed(
                            base_url,
                            token,
                            "spawn-approval-delegate",
                            reference,
                            text,
                            &name,
                            &id,
                        )
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

    /// Whether one try at the delegate `id`'s copy may send it, and to which
    /// name Relaycast gives that id now.
    async fn delegate_try(
        &self,
        registration: &Registration,
        token: &Secret,
        reference: &str,
        id: &str,
    ) -> DelegateTry {
        if !self.delegate_request(registration, reference).await
            || !self.delegates_may_answer_now(registration)
        {
            return DelegateTry::Stop;
        }
        let Some(name) = self.name_of(registration, id).await else {
            return DelegateTry::Skip;
        };
        let Some(name) = name else {
            return DelegateTry::Stop;
        };
        // Only into a conversation Relaycast lists with just the two of
        // them (not one the session left, which is unlisted).
        match self.pair_conversation(registration, token, id).await {
            PairConversation::Private => {}
            PairConversation::Absent | PairConversation::Shared => return DelegateTry::Stop,
            PairConversation::Unknown => return DelegateTry::Skip,
        }
        // Every try, the first included, asks Cloud as late as it can
        // whether the delegate's grant still covers the session: a revoked
        // delegate is never sent it.
        match self.prompt_delegates(registration, token).await {
            None => return DelegateTry::Skip,
            Some(ids) if !ids.iter().any(|listed| listed == id) => return DelegateTry::Stop,
            Some(_) => {}
        }
        if !self.delegate_request(registration, reference).await
            || !self.delegates_may_answer_now(registration)
        {
            return DelegateTry::Stop;
        }
        if self.claude_delivery.organization_admin_name(&name) == Some(false) {
            return DelegateTry::Skip;
        }
        DelegateTry::Send(name)
    }

    /// The name Relaycast gives agent `id` in `registration`'s workspace:
    /// `Some(None)` when no agent has it, `None` when it could not be asked.
    async fn name_of(&self, registration: &Registration, id: &str) -> Option<Option<String>> {
        let workspace = self.workspace()?;
        if workspace.base_url != registration.base_url
            || registration.workspace_key.as_ref() != Some(&workspace.key)
        {
            return Some(None);
        }
        let http = sdk_gaps::workspace_http(&workspace).ok()?;
        let agents = sdk_gaps::list_agents(&http, "all").await.ok()?;
        Some(
            agents
                .iter()
                .find(|agent| agent["id"].as_str() == Some(id))
                .and_then(|agent| agent["name"].as_str())
                .map(str::to_string),
        )
    }
}
