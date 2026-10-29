//! Settling a channel injection's posts by how it went: each post is
//! recorded before it is settled with Relaycast, and the injection leaves
//! the journal once it settles ([`super::pins`]).

use crate::relay::backoff::WorkspaceScope;
use crate::relay::claude_delivery_policy::PriorOutcome;
use crate::relay::daemon::Core;
use crate::relay::delivery::policy::Delivery;
use crate::relay::delivery::{DeliveryOutcome, DeliverySettlement, Retry};
use crate::relay::inject::InjectOutcome;
use crate::relay::store::{Registration, SessionKind};
use crate::relay::workspace::Secret;
use std::sync::Arc;
use std::time::Instant;

/// These adapters return completed answers through the automatic reply loop;
/// their agents cannot answer through the session socket.
pub(super) fn uses_automatic_replies(kind: SessionKind) -> bool {
    matches!(
        kind,
        SessionKind::OpenClaw | SessionKind::Hermes | SessionKind::Pi
    )
}

/// The post an OpenClaw, Hermes or Pi agent's answer to a delivered batch
/// replies to: its last, the one whose reference the adapters keep the
/// answer under (`hand_over`). `None` for other kinds, which answer on the
/// session socket, and for a batch that may not have arrived.
pub(super) fn automatic_answer_post<'a>(
    registration: &Registration,
    posts: &'a [Delivery],
    delivered: bool,
) -> Option<&'a Delivery> {
    (delivered && uses_automatic_replies(registration.target.kind))
        .then(|| posts.last())
        .flatten()
}

/// One injection's posts, the credential they are settled with, the reply
/// routes it opened and its journal entry.
pub(super) struct Settle<'a> {
    pub registration: &'a Registration,
    pub token: &'a Secret,
    pub workspace: &'a WorkspaceScope,
    pub posts: &'a [Delivery],
    pub routes: &'a [String],
    pub pin_key: Option<&'a str>,
    /// The original batch's reply target, even when absent from the latest read.
    pub answer_post: Option<&'a Delivery>,
    /// Every post of the journaled prompt, also those not read in this
    /// pass: once it settles, each is recorded, so one read later is
    /// settled as already handled rather than put into another prompt.
    pub members: &'a [String],
}

impl<'a> Settle<'a> {
    pub fn new(
        registration: &'a Registration,
        token: &'a Secret,
        workspace: &'a WorkspaceScope,
        posts: &'a [Delivery],
    ) -> Settle<'a> {
        Settle {
            registration,
            token,
            workspace,
            posts,
            routes: &[],
            pin_key: None,
            answer_post: None,
            members: &[],
        }
    }
}

impl Settle<'_> {
    /// The deliveries an outcome is recorded for: the posts read in this
    /// pass and every journaled member.
    fn recorded_ids(&self) -> Vec<&str> {
        let mut ids: Vec<&str> = self.posts.iter().map(|p| p.id.as_str()).collect();
        for member in self.members {
            if !ids.contains(&member.as_str()) {
                ids.push(member);
            }
        }
        ids
    }
}

impl Core {
    pub(super) async fn settle_posts(
        self: &Arc<Core>,
        settle: &Settle<'_>,
        outcome: InjectOutcome,
    ) {
        match outcome {
            InjectOutcome::Delivered => self.posts_arrived(settle, None).await,
            InjectOutcome::InDoubt(reason) => self.posts_arrived(settle, Some(reason)).await,
            InjectOutcome::Retry(reason) => self.posts_failed(settle, reason),
            InjectOutcome::Refused(reason) => self.posts_refused(settle, reason).await,
            InjectOutcome::Waiting(_)
            | InjectOutcome::Accepted(_)
            | InjectOutcome::WaitingForTurn(_) => self.posts_wait(settle, &outcome),
        }
    }

    fn consume_posts(&self, settle: &Settle<'_>, outcome: &PriorOutcome) {
        if settle.registration.target.kind != SessionKind::ClaudeTerminal {
            return;
        }
        for id in settle.recorded_ids() {
            let _ = self
                .claude_delivery
                .consume(id, &settle.registration.name, outcome.clone());
        }
    }

    /// The injection settled: no retry waits and its journal entry goes.
    fn forget_posts(&self, settle: &Settle<'_>) {
        {
            let mut state = self.delivery_state();
            for post in settle.posts {
                state.retries.remove(&post.id);
            }
        }
        if let Some(key) = settle.pin_key {
            let _ = self.with_pins(|pins| pins.remove(&settle.registration.agent_id, key));
        }
    }

    /// Takes back only the reply routes this injection opened.
    fn revoke_routes(&self, settle: &Settle<'_>) {
        for route in settle.routes {
            self.revoke_reply_parent(settle.registration, route);
        }
    }

    /// Delivered (`doubt` is `None`) or in doubt: recorded, then settled.
    async fn posts_arrived(&self, settle: &Settle<'_>, doubt: Option<String>) {
        let prior = match doubt {
            None => PriorOutcome::Delivered,
            Some(_) => PriorOutcome::InDoubt,
        };
        self.consume_posts(settle, &prior);
        let prefix = self.machine_prefix.clone();
        let recorded = self.store.remember(|store| {
            for id in settle.recorded_ids() {
                match doubt {
                    None => store.record_injected(id),
                    Some(_) => store.record_in_doubt(id),
                }
            }
            // OpenClaw, Hermes and Pi cannot answer on the session socket: their
            // answer to the batch goes back automatically, in reply to its
            // last post.
            if let Some(last) = settle.answer_post.filter(|_| doubt.is_none()) {
                store.record_reply_opportunity(last, settle.registration, false, &prefix);
            }
        });
        if recorded.is_ok() {
            self.forget_posts(settle);
        }
        for post in settle.posts {
            if recorded.is_ok() {
                self.settle_arrived(settle, &post.id, doubt.as_deref())
                    .await;
                self.claude_delivery.finish(&post.id);
            }
            match &doubt {
                None => self.record_settled(
                    settle.registration,
                    post,
                    DeliveryOutcome::Injected,
                    None,
                    Some(DeliverySettlement::Visible),
                ),
                Some(reason) => self.record(
                    settle.registration,
                    post,
                    DeliveryOutcome::InDoubt,
                    Some(format!("May have arrived; not resent — {reason}")),
                ),
            }
        }
    }

    async fn settle_arrived(&self, settle: &Settle<'_>, id: &str, doubt: Option<&str>) {
        let base = &settle.registration.base_url;
        match doubt {
            None => {
                let _ = self
                    .relaycast_ack(settle.workspace, base, settle.token, id)
                    .await;
            }
            Some(reason) => {
                let detail = format!("in doubt, not resent: {reason}");
                let _ = self
                    .relaycast_fail(settle.workspace, base, settle.token, id, &detail, false)
                    .await;
            }
        }
    }

    /// Nothing reached the session: each post backs off as a failed
    /// injection does, and may join a different injection next time.
    pub(super) fn posts_failed(self: &Arc<Core>, settle: &Settle<'_>, reason: String) {
        self.revoke_routes(settle);
        self.forget_posts(settle);
        let mut longest = 0f64;
        {
            let mut state = self.delivery_state();
            for post in settle.posts {
                let failures = state.retries.get(&post.id).map_or(0, |r| r.failures) + 1;
                let units = 30f64.min(3.0 * 2f64.powi(failures as i32 - 1));
                longest = longest.max(units);
                let after = Instant::now() + self.config.delivery_timing.retry_unit.mul_f64(units);
                let agent = settle.registration.name.clone();
                state.retries.insert(
                    post.id.clone(),
                    Retry {
                        agent,
                        after,
                        failures,
                    },
                );
            }
        }
        self.drain_later(settle.registration, longest + 0.2);
        for post in settle.posts {
            self.record(
                settle.registration,
                post,
                DeliveryOutcome::Failed,
                Some(reason.clone()),
            );
        }
    }

    async fn posts_refused(&self, settle: &Settle<'_>, reason: String) {
        self.revoke_routes(settle);
        self.consume_posts(settle, &PriorOutcome::Refused(reason.clone()));
        let agent_id = &settle.registration.agent_id;
        let recorded = self.store.remember(|store| {
            for id in settle.recorded_ids() {
                store.queue_refusal_with_reason(id, agent_id, Some(&reason));
            }
        });
        if recorded.is_ok() {
            self.forget_posts(settle);
        }
        for post in settle.posts {
            if recorded.is_ok() {
                self.settle_refused_delivery(settle.registration, settle.token, &post.id)
                    .await;
                self.claude_delivery.finish(&post.id);
            }
            let detail = format!("Refused; not retried — {reason}");
            self.record(
                settle.registration,
                post,
                DeliveryOutcome::Failed,
                Some(detail),
            );
        }
    }

    /// Not yet visible: looked at again, with the same prompt, which stays
    /// in the journal.
    fn posts_wait(self: &Arc<Core>, settle: &Settle<'_>, outcome: &InjectOutcome) {
        // Waiting never handed the prompt over; the retry opens the routes again.
        if matches!(outcome, InjectOutcome::Waiting(_)) {
            self.revoke_routes(settle);
        }
        let reason = match outcome {
            InjectOutcome::Waiting(r)
            | InjectOutcome::Accepted(r)
            | InjectOutcome::WaitingForTurn(r) => r.clone(),
            _ => String::new(),
        };
        {
            let mut state = self.delivery_state();
            let after = Instant::now() + self.config.delivery_timing.retry_unit.mul_f64(5.0);
            let agent = settle.registration.name.clone();
            for post in settle.posts {
                let retry = Retry {
                    agent: agent.clone(),
                    after,
                    failures: 0,
                };
                state.retries.insert(post.id.clone(), retry);
            }
        }
        self.drain_later(settle.registration, 5.2);
        for post in settle.posts {
            self.record_settled(
                settle.registration,
                post,
                DeliveryOutcome::Waiting,
                Some(reason.clone()),
                DeliverySettlement::of(outcome),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registration(kind: SessionKind, id: &str) -> Registration {
        serde_json::from_value(serde_json::json!({
            "name": "agent", "agentID": "a-1",
            "target": {"kind": kind.as_str(), "id": id},
            "baseURL": "https://cast.example", "registeredAt": "2026-10-18T00:00:00Z"
        }))
        .unwrap()
    }

    fn post(message_id: &str) -> Delivery {
        Delivery {
            id: format!("d-{message_id}"),
            message_id: message_id.into(),
            reason: Some("message".into()),
            channel_id: Some("ch_swarm".into()),
            sender: Some("alice".into()),
            ..Delivery::default()
        }
    }

    #[test]
    fn a_gateway_agents_batch_answer_replies_to_its_last_post() {
        let posts = [post("m-1"), post("m-2")];
        for kind in [SessionKind::OpenClaw, SessionKind::Hermes, SessionKind::Pi] {
            let agent = registration(
                kind,
                if kind == SessionKind::Hermes {
                    "relay"
                } else {
                    "main"
                },
            );
            assert_eq!(
                automatic_answer_post(&agent, &posts, true).map(|p| p.message_id.as_str()),
                Some("m-2")
            );
            // In doubt, nothing is answered twice.
            assert!(automatic_answer_post(&agent, &posts, false).is_none());
        }
        // Other kinds answer on the session socket.
        let codex = registration(SessionKind::Codex, "11111111-2222-3333-4444-555555555555");
        assert!(automatic_answer_post(&codex, &posts, true).is_none());
    }
}
