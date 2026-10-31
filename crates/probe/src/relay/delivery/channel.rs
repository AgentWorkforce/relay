//! Posts in channels an agent subscribed to, coalesced: the ordinary posts
//! of one channel read in the same pass of the agent's queue become one
//! injection, so a busy channel costs the session one turn per pass rather
//! than one per message. Direct messages, mentions and thread replies are
//! handled one by one as before ([`Core::handle`]).
//!
//! The at-most-once rules of [`super`] hold for each post in an injection:
//! each is recorded as injected (or in doubt, or refused) before it is
//! settled with Relaycast. Before a prompt is handed over it is written to
//! the [`ChannelPins`] journal; until it settles, every retry hands over
//! that exact prompt under the same ids, also after a restart, so a post is
//! never put into a second prompt ([`pins`]).

pub(super) mod pins;
mod prompt;
mod settle;

use super::channel_text::{batch_delivery_id, batch_key, coalesced_text, fitting, thread_target};
use super::policy::{decide_for_agent, is_channel_post, Decision, Delivery};
use super::DeliveryState;
use crate::relay::claude_delivery_policy::Decision as ClaudeConsent;
use crate::relay::daemon::Core;
use crate::relay::inject::{DeliveryRoute, InjectOutcome};
use crate::relay::outbound::channels::thread_route;
use crate::relay::store::Registration;
use crate::relay::workspace::Secret;
use pins::{ChannelPins, Pin, FILE_NAME};
use settle::Settle;
use std::collections::HashSet;
use std::sync::{Arc, MutexGuard, PoisonError};
use std::time::Instant;

/// The most posts put into one injection; the rest wait for the next pass.
pub const MAX_COALESCED: usize = 20;

/// The most bytes of post text and files one injection is composed to,
/// below the 65,536-byte prompt limit of the OpenCode and Grok routes, so
/// the attribution and reply lines still fit.
pub const PROMPT_BUDGET: usize = 48 * 1024;

/// One channel's posts from one queue read, in queue order.
type Group = (String, Vec<Delivery>);

fn group_post(groups: &mut Vec<Group>, channel: &str, post: Delivery) {
    match groups.iter_mut().find(|(id, _)| id == channel) {
        Some((_, posts)) => posts.push(post),
        None => groups.push((channel.to_string(), vec![post])),
    }
}

impl Core {
    pub(super) fn delivery_state(&self) -> MutexGuard<'_, DeliveryState> {
        self.delivery.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Runs `change` on the injection journal, loading it on first use.
    pub(super) fn with_pins<T>(&self, change: impl FnOnce(&mut ChannelPins) -> T) -> T {
        let mut state = self.delivery_state();
        let pins = state
            .channel_pins
            .get_or_insert_with(|| ChannelPins::load(self.config.app_data_dir.join(FILE_NAME)));
        change(pins)
    }

    /// Handles one queue read: each subscribed channel's posts together,
    /// after every other delivery.
    pub(super) async fn handle_pending(
        self: &Arc<Core>,
        deliveries: &[Delivery],
        registration: &Registration,
    ) {
        let webhook = registration.webhook.as_ref().map(|w| w.channel_id.as_str());
        let integration = registration.integration_channel_id.as_deref();
        let queued: HashSet<&str> = deliveries.iter().map(|d| d.id.as_str()).collect();
        let _ = self.with_pins(|pins| pins.retain_queued(&registration.agent_id, &queued));
        let mut groups = Vec::new();
        for delivery in deliveries.iter().filter(|d| d.is_pending()) {
            // Sent under either of the session's names: acknowledged, not injected.
            let own = self.sent_by_itself(delivery, registration);
            let post = !own && is_channel_post(delivery, webhook, integration);
            match delivery.channel_id.as_deref().filter(|_| post) {
                Some(channel) => group_post(&mut groups, channel, delivery.clone()),
                None => self.handle(delivery, registration, false).await,
            }
        }
        for (_, posts) in groups {
            for post in self.handle_channel_posts(posts, registration).await {
                self.handle(&post, registration, false).await;
            }
        }
    }

    /// Injects the posts that are ready, under the agent's lock; returns
    /// the others (already handled, held for approval, skipped) for
    /// [`Core::handle`] to settle one by one.
    async fn handle_channel_posts(
        self: &Arc<Core>,
        posts: Vec<Delivery>,
        read: &Registration,
    ) -> Vec<Delivery> {
        let lock = self.agent_locks.get(&read.name);
        let _delivering = lock.lock().await;
        let current = self
            .agent_credential(&read.name)
            .filter(|(active, _)| active.agent_id == read.agent_id);
        let Some((registration, token)) = current else {
            return Vec::new();
        };
        if self.stopping() || registration.missing_since.is_some() {
            return Vec::new();
        }
        let _ = self.scope_claude_delivery();
        // A post waiting for its retry stays in the queue for the drain
        // that retry scheduled; handing it on could inject it alone once due.
        let now = Instant::now();
        let posts: Vec<Delivery> = posts
            .into_iter()
            .filter(|post| !self.waiting(post, now))
            .collect();
        let pinned = self.with_pins(|pins| {
            pins.find(&registration.agent_id, posts.iter().map(|p| p.id.as_str()))
        });
        if let Some(pin) = pinned {
            let (members, rest): (Vec<_>, Vec<_>) =
                posts.into_iter().partition(|p| pin.members.contains(&p.id));
            if !rest.is_empty() {
                self.request_drain(&registration.name);
            }
            self.inject_pinned(&registration, &token, pin, members)
                .await;
            return Vec::new();
        }
        let (ready, others): (Vec<_>, Vec<_>) = posts
            .into_iter()
            .partition(|post| self.post_ready(post, &registration));
        let take = fitting(&ready, MAX_COALESCED, PROMPT_BUDGET);
        if take < ready.len() {
            self.request_drain(&registration.name);
        }
        if take > 0 {
            let batch = ready.into_iter().take(take).collect();
            self.inject_posts(&registration, &token, batch).await;
        }
        others
    }

    /// Whether `post` waits for a retry that is not yet due.
    fn waiting(&self, post: &Delivery, now: Instant) -> bool {
        let state = self.delivery_state();
        state
            .retries
            .get(&post.id)
            .is_some_and(|retry| retry.after > now)
    }

    /// Whether `post` can go into a new injection now: still a post in a
    /// subscribed channel for the registration as it is now (a webhook or
    /// integration channel added since the queue read routes as before),
    /// not handled before, injected by policy, and consented to.
    fn post_ready(&self, post: &Delivery, registration: &Registration) -> bool {
        let webhook = registration.webhook.as_ref().map(|w| w.channel_id.as_str());
        let integration = registration.integration_channel_id.as_deref();
        is_channel_post(post, webhook, integration)
            && !self.store.read(|s| s.was_handled(&post.id))
            && decide_for_agent(post, &registration.name, webhook, integration) == Decision::Inject
            && self.claude_delivery.decide(registration, post) == ClaudeConsent::Deliver
    }

    /// The reply routes `posts` open that the session does not hold yet:
    /// only those are taken back if the injection fails, so a thread an
    /// earlier prompt already showed stays answerable.
    fn new_routes(
        &self,
        registration: &Registration,
        channel: &str,
        posts: &[Delivery],
    ) -> Vec<String> {
        let held = self.reply_parents(&registration.name);
        let mut routes: Vec<String> = Vec::new();
        for post in posts {
            let route = thread_route(channel, thread_target(post));
            if !held.contains(&route) && !routes.contains(&route) {
                routes.push(route);
            }
        }
        routes
    }

    async fn inject_posts(
        self: &Arc<Core>,
        registration: &Registration,
        token: &Secret,
        batch: Vec<Delivery>,
    ) {
        let channel_id = batch
            .first()
            .and_then(|p| p.channel_id.clone())
            .unwrap_or_default();
        let workspace = self.relaycast_registration_scope(registration, token);
        let Some(channel) = self.channel_name(registration, token, &channel_id).await else {
            // Replying needs the name; the posts wait rather than carry
            // commands for a channel that may not exist.
            let settle = Settle::new(registration, token, &workspace, &batch);
            self.posts_failed(&settle, "The channel's name could not be read.".into());
            return;
        };
        let posts = self.with_files(batch, registration, token).await;
        let lines = self
            .channel_prompt_lines(registration, &channel, &posts)
            .await;
        let routes = self.new_routes(registration, &channel, &posts);
        let pin = Pin {
            agent_id: registration.agent_id.clone(),
            delivery_id: batch_delivery_id(&posts),
            key: batch_key(&posts),
            members: posts.iter().map(|p| p.id.clone()).collect(),
            text: coalesced_text(&posts, &registration.name, &channel, &lines),
            routes,
            reply_post: settle::automatic_answer_post(registration, &posts, true)
                .map(pins::ReplyPost::from),
        };
        if let Err(error) = self.with_pins(|pins| pins.insert(pin.clone())) {
            let settle = Settle::new(registration, token, &workspace, &posts);
            self.posts_failed(&settle, format!("Could not save the injection. {error}"));
            return;
        }
        // Every new thread may be answered once the prompt is visible.
        for route in &pin.routes {
            self.authorize_reply_parent(registration, route);
        }
        self.hand_over(registration, token, &pin, &posts).await;
    }

    /// Hands a recorded injection over again, exactly as it was, settling
    /// whichever of its posts are still queued.
    async fn inject_pinned(
        self: &Arc<Core>,
        registration: &Registration,
        token: &Secret,
        pin: Pin,
        members: Vec<Delivery>,
    ) {
        for route in &pin.routes {
            self.authorize_reply_parent(registration, route);
        }
        self.hand_over(registration, token, &pin, &members).await;
    }

    async fn hand_over(
        self: &Arc<Core>,
        registration: &Registration,
        token: &Secret,
        pin: &Pin,
        posts: &[Delivery],
    ) {
        let injector = self.plugins.injector.clone();
        let registered = registration.clone();
        let (delivery_id, key, text) = (pin.delivery_id.clone(), pin.key.clone(), pin.text.clone());
        let (reply_post, outcome) = match pin.reply_delivery(registration.target.kind, posts) {
            Ok(reply_post) => {
                let channel = reply_post
                    .as_ref()
                    .and_then(|p| p.channel_id.clone())
                    .or_else(|| posts.iter().find_map(|p| p.channel_id.clone()));
                let answer_ref = reply_post
                    .as_ref()
                    .map(|post| post.message_id.clone())
                    .unwrap_or(key);
                let spawner = self.plugins.spawner.clone();
                let outcome = tokio::task::spawn_blocking(move || {
                    let route = DeliveryRoute {
                        delivery_id: &delivery_id,
                        message_id: &answer_ref,
                        reason: Some("message"),
                        channel_id: channel.as_deref(),
                        ..DeliveryRoute::default()
                    };
                    spawner.deliver_registered(&*injector, &registered, &route, &text)
                })
                .await
                .unwrap_or_else(|_| {
                    InjectOutcome::InDoubt("the injection stopped unexpectedly".into())
                });
                (reply_post, outcome)
            }
            Err(reason) => (None, InjectOutcome::InDoubt(reason)),
        };
        let workspace = self.relaycast_registration_scope(registration, token);
        let settle = Settle {
            answer_post: reply_post.as_ref(),
            routes: &pin.routes,
            pin_key: Some(&pin.key),
            members: &pin.members,
            ..Settle::new(registration, token, &workspace, posts)
        };
        self.settle_posts(&settle, outcome).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn posts_group_by_channel_in_first_seen_order() {
        let post = |id: &str| Delivery {
            id: id.into(),
            ..Delivery::default()
        };
        let mut groups = Vec::new();
        group_post(&mut groups, "ch_b", post("1"));
        group_post(&mut groups, "ch_a", post("2"));
        group_post(&mut groups, "ch_b", post("3"));
        let shape: Vec<(String, Vec<String>)> = groups
            .into_iter()
            .map(|(channel, posts)| (channel, posts.into_iter().map(|p| p.id).collect()))
            .collect();
        assert_eq!(
            shape,
            vec![
                ("ch_b".to_string(), vec!["1".to_string(), "3".to_string()]),
                ("ch_a".to_string(), vec!["2".to_string()]),
            ]
        );
    }

    #[test]
    fn the_budget_leaves_room_below_the_prompt_limit() {
        const { assert!(PROMPT_BUDGET + 8 * 1024 < 65_536) };
    }
}
