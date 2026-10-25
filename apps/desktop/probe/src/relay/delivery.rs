//! Inbound delivery: every message addressed to one of this computer's
//! agents is put into its session through the session's own route, then
//! settled with Relaycast.
//!
//! ```text
//! sender ─DM @name─▶ Relaycast deliveries ─push/poll─▶ core ─Injector─▶ session
//!                              ◀───────────────ack/fail────┘
//! ```
//!
//! Each agent has one line of work: deliveries its push socket carried, in
//! the order they were pushed, then a read of its queue when one was asked
//! for (a socket coming up or going down, a delivery the frame could not
//! carry, a retry coming due, the safety poll). A delivery is put into a
//! session at most once:
//!
//! - It is acknowledged only after the record that it was injected is on
//!   disk, so an acknowledgement lost on the way never causes a second
//!   injection: the next pass acknowledges again instead.
//! - An injection that may or may not have arrived is never repeated. It is
//!   recorded as in doubt and reported failed (not retryable), and reported
//!   failed again, never acknowledged, if Relaycast redelivers it.
//! - An agent being removed waits for the delivery in flight; nothing is
//!   injected for it once its removal returns.
//!
//! Every agent's queue also has a safety timer: five minutes with live push,
//! otherwise 3 s, backing off empty reads to 15 s. Successful queue reads
//! refresh server presence, as do acknowledged socket heartbeats. REST
//! heartbeats cover agents with neither form of confirmed presence: every
//! 30 s, or every 2 minutes with a live push socket to hosted Relaycast.
//! The supervisor also retries failed Relaycast
//! removals and, when auto-activation is on, registers newly found sessions.
//!
//! Automatic final answers run on their own timer: for each message whose
//! session could not answer it itself (or whose agent always answers), the
//! session's transcript is read and, once its turn is over, the answer is
//! claimed in the store before it is sent, so a concurrent socket send or a
//! lost response can never produce a second answer.

mod cadence;
mod channel;
pub mod channel_text;
pub mod final_answer;
mod inbox_watch;
pub mod policy;
mod session_text;
mod timing;
pub use timing::DeliveryTiming;

use crate::relay::backoff::WorkspaceScope;
use crate::relay::claude_delivery_policy::{Decision as ClaudeConsent, PriorOutcome};
use crate::relay::client;
use crate::relay::contract::claude_delivery::ClaudeDeliveryStatus;
use crate::relay::daemon::Core;
use crate::relay::files;
use crate::relay::inject::{DeliveryRoute, InjectOutcome};
use crate::relay::links::Endpoint;
use crate::relay::protocol::RpcError;
use crate::relay::push::{PushState, PushTarget};
use crate::relay::state::{now_ms, Level, Listing};
use crate::relay::store::{Destination, Registration, Reply, Store};
use crate::relay::store::{SessionKind, Target};
use crate::relay::workspace::Secret;
use cadence::{claim_due, heartbeat_interval, is_due, queue_poll_interval};
use futures_util::{future::BoxFuture, stream, StreamExt};
use policy::{decide_for_agent, Attachment, Decision, Delivery};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// How many delivery outcomes `activity.list` keeps.
const ACTIVITY_KEPT: usize = 50;
const HEARTBEAT_SPACING: Duration = Duration::from_millis(100);
const HEARTBEAT_WORKSPACES: usize = 4;

fn claude_policy_error(error: String) -> RpcError {
    RpcError::new(
        crate::relay::protocol::ErrorKind::StoreFailed,
        format!("Could not save Claude Code delivery choices. {error}"),
    )
}

fn queue_read_matches_credential(
    registration: &Registration,
    token: &Secret,
    current: Option<(&Registration, &Secret)>,
) -> bool {
    current.is_some_and(|(active, active_token)| {
        active.agent_id == registration.agent_id
            && active.base_url == registration.base_url
            && active_token == token
    })
}

/// What happened to one delivery, as `activity.list` reports it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, schemars::JsonSchema, Deserialize)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-fallback" = "skipped"))]
pub enum DeliveryOutcome {
    Injected,
    Skipped,
    Failed,
    Waiting,
    InDoubt,
    /// An automatic final answer was sent.
    Answered,
}

/// Where a message stands in the session it was handed to. A message the
/// session's own queue accepted is `handed_off`, or `waiting_for_turn` while
/// the session runs a turn it must finish first; it is `visible` once the
/// session records it (for a Codex queue handoff, its rollout records the
/// message's turn).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, schemars::JsonSchema, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeliverySettlement {
    HandedOff,
    WaitingForTurn,
    Visible,
}

impl DeliverySettlement {
    /// The settlement an injection outcome proves, if any.
    pub fn of(outcome: &InjectOutcome) -> Option<DeliverySettlement> {
        match outcome {
            InjectOutcome::Delivered => Some(DeliverySettlement::Visible),
            InjectOutcome::Accepted(_) => Some(DeliverySettlement::HandedOff),
            InjectOutcome::WaitingForTurn(_) => Some(DeliverySettlement::WaitingForTurn),
            _ => None,
        }
    }
}

/// A message delivered to one of this computer's agents.
#[derive(Clone, Debug, PartialEq, Serialize, schemars::JsonSchema, Deserialize)]
pub struct DeliveryActivity {
    pub at_ms: i64,
    pub agent: String,
    pub sender: Option<String>,
    pub preview: String,
    pub outcome: DeliveryOutcome,
    pub detail: Option<String>,
    /// Set for outcomes that place the message in the session.
    pub settlement: Option<DeliverySettlement>,
}

struct Retry {
    agent: String,
    after: Instant,
    /// Failed attempts in a row, for the backoff.
    failures: u32,
}

type TerminalIntegration = (String, String, String);

/// Records that a provider resource ended. This is part of settling the
/// terminal event, not a consequence of successful session injection: an
/// in-doubt or permanently refused injection must still retire the binding.
fn mark_terminal(
    store: &mut Store,
    registration: &Registration,
    terminal: Option<&TerminalIntegration>,
) {
    let Some((entry_id, _, _)) = terminal else {
        return;
    };
    if let Some(mut current) = store
        .registrations
        .iter()
        .find(|current| current.agent_id == registration.agent_id)
        .cloned()
    {
        if let Some(entry) = current
            .integrations
            .iter_mut()
            .flatten()
            .find(|entry| &entry.id == entry_id)
        {
            entry.terminal = Some(true);
            store.update(current);
        }
    }
}

fn clean_terminal(
    core: &Arc<Core>,
    registration: &Registration,
    terminal: Option<TerminalIntegration>,
) {
    if let Some((_, provider, resource)) = terminal {
        let core = core.clone();
        let name = registration.name.clone();
        tokio::spawn(async move {
            if let Err(error) = core
                .unsubscribe_integration(&name, &provider, &resource)
                .await
            {
                core.hub.activity(
                    Level::Warning,
                    format!(
                        "Will retry cleanup of @{name}'s closed {provider} subscription: {}",
                        error.message
                    ),
                );
            }
        });
    }
}

#[derive(Default)]
struct Line {
    pushed: VecDeque<Delivery>,
    drain: bool,
    running: bool,
}

/// The delivery runtime's memory. Nothing here needs to survive a
/// restart: what must is in the store.
#[derive(Default)]
pub struct DeliveryState {
    lines: HashMap<String, Line>,
    /// Deliveries tried and not yet settled, by delivery id. Dropped once
    /// a delivery settles, leaves its queue, or its agent is removed.
    retries: HashMap<String, Retry>,
    /// The last queue read's problem, per agent.
    pub(crate) queue_errors: BTreeMap<String, String>,
    activity: VecDeque<DeliveryActivity>,
    /// Last queue read request/completion per agent. Push wakes are immediate;
    /// a successful read also satisfies the periodic safety net.
    last_queue_poll: HashMap<String, Instant>,
    /// Consecutive successful reads with no pending deliveries.
    empty_queue_reads: HashMap<String, u32>,
    /// Last REST heartbeat attempt, successful queue read, or acknowledged
    /// socket presence update. Failed reads never postpone a heartbeat.
    last_heartbeat: HashMap<String, Instant>,
    last_integration_cleanup: Option<Instant>,
    last_activation_failures: Vec<String>,
    /// Channel injections handed over and not yet settled, loaded from
    /// disk on first use (`channel::pins`).
    channel_pins: Option<channel::pins::ChannelPins>,
    /// Channel names by id, as the agents' channel lists gave them.
    channel_names: HashMap<String, String>,
    /// Terminal Claude Code sessions holding relay messages not yet seen
    /// read, by agent name (`inbox_watch`).
    inbox: HashMap<String, crate::relay::claude::inbox::Watch>,
}

impl DeliveryState {
    fn presence_confirmed(&mut self, name: &str, sent_at: Instant) {
        self.last_heartbeat
            .entry(name.into())
            .and_modify(|last| *last = (*last).max(sent_at))
            .or_insert(sent_at);
    }

    fn queue_read_succeeded(
        &mut self,
        name: &str,
        pending: bool,
        started: Instant,
        finished: Instant,
    ) {
        self.last_queue_poll.insert(name.into(), finished);
        // Presence middleware runs before the queue handler. A slow response
        // must neither pretend presence was refreshed at completion nor
        // overwrite a newer heartbeat sent while that read was in flight.
        self.presence_confirmed(name, started);
        let empty_reads = self.empty_queue_reads.entry(name.into()).or_default();
        *empty_reads = if pending {
            0
        } else {
            empty_reads.saturating_add(1)
        };
    }
}

enum Work {
    Pushed(Box<Delivery>),
    Drain,
}

pub(crate) fn preview(delivery: &Delivery) -> String {
    let text = delivery.text.as_deref().unwrap_or_default();
    let text = if text.trim().is_empty() && !delivery.attachments.is_empty() {
        delivery
            .attachments
            .iter()
            .map(|attachment| format!("📎 {}", attachment.display_name()))
            .collect::<Vec<_>>()
            .join(" ")
    } else {
        text.to_string()
    };
    text.chars().take(140).collect()
}

impl Core {
    fn credit_queue_read_if_current(
        &self,
        registration: &Registration,
        token: &Secret,
        pending: bool,
        started: Instant,
        finished: Instant,
    ) {
        // Hold the store lock through the credit so a removal or replacement
        // cannot land between checking the credential and advancing presence.
        self.store.read(|store| {
            let current = store.credential_named(&registration.name);
            if queue_read_matches_credential(
                registration,
                token,
                current.as_ref().map(|(active, key)| (active, key)),
            ) {
                self.delivery.lock().unwrap().queue_read_succeeded(
                    &registration.name,
                    pending,
                    started,
                    finished,
                );
            }
        });
    }
    fn scope_claude_delivery(&self) -> Result<(), String> {
        let Some(workspace) = self.workspace() else {
            // Discovery can briefly have no answer while registrations still
            // drain. Keep the last durable scope instead of treating absence
            // as a workspace change and erasing its safety state.
            return Ok(());
        };
        let scope =
            WorkspaceScope::credential(&workspace.base_url, &workspace.key, "Claude delivery")
                .key()
                .to_string();
        self.claude_delivery.use_workspace(&scope).map(drop)
    }

    pub fn claude_delivery_status(&self) -> ClaudeDeliveryStatus {
        let _ = self.scope_claude_delivery();
        let registrations = self.store.read(|store| store.registrations.clone());
        self.claude_delivery.status(&registrations)
    }

    pub fn set_claude_delivery_restricted(&self, restricted: bool) -> Result<(), RpcError> {
        self.scope_claude_delivery().map_err(claude_policy_error)?;
        self.claude_delivery
            .set_restricted(restricted)
            .map_err(claude_policy_error)?;
        self.request_claude_drains();
        Ok(())
    }

    pub fn set_claude_session_delivery(
        &self,
        session_id: &str,
        direct: bool,
    ) -> Result<(), RpcError> {
        self.scope_claude_delivery().map_err(claude_policy_error)?;
        let known = self.store.read(|store| {
            store.registrations.iter().any(|registration| {
                registration.target.kind == SessionKind::ClaudeTerminal
                    && registration.target.id == session_id
            })
        });
        if !known {
            return Err(RpcError::invalid_params(
                "Choose a local Claude Code session.",
            ));
        }
        self.claude_delivery
            .set_session(session_id, direct)
            .map_err(claude_policy_error)?;
        self.request_claude_drains();
        Ok(())
    }

    pub fn set_claude_sender_delivery(
        &self,
        sender: &str,
        name: &str,
        allowed: bool,
    ) -> Result<(), RpcError> {
        self.scope_claude_delivery().map_err(claude_policy_error)?;
        if sender.trim().is_empty() || sender.len() > 512 || name.len() > 256 {
            return Err(RpcError::invalid_params("Choose a valid workspace member."));
        }
        self.claude_delivery
            .set_sender(sender, name, allowed)
            .map_err(claude_policy_error)?;
        self.request_claude_drains();
        Ok(())
    }

    fn request_claude_drains(&self) {
        for name in self.store.read(|store| {
            store
                .registrations
                .iter()
                .filter(|registration| registration.target.kind == SessionKind::ClaudeTerminal)
                .map(|registration| registration.name.clone())
                .collect::<Vec<_>>()
        }) {
            self.request_drain(&name);
        }
    }

    fn hold_claude_delivery(&self, registration: &Registration, delivery: &Delivery) {
        match self.claude_delivery.hold(registration, delivery) {
            Ok(true) => self.record(
                registration,
                delivery,
                DeliveryOutcome::Waiting,
                Some("Waiting for your approval in Agent Relay.".into()),
            ),
            Ok(false) => {}
            Err(error) => self.record(
                registration,
                delivery,
                DeliveryOutcome::Failed,
                Some(format!("Could not save the approval request — {error}")),
            ),
        }
    }

    pub fn approve_claude_delivery(&self, id: &str) -> Result<bool, RpcError> {
        self.scope_claude_delivery().map_err(claude_policy_error)?;
        let agent = self
            .claude_delivery
            .approve(id)
            .map_err(claude_policy_error)?;
        if let Some(agent) = &agent {
            self.request_drain(agent);
        }
        Ok(agent.is_some())
    }

    pub fn dismiss_claude_delivery(&self, id: &str) -> Result<bool, RpcError> {
        self.scope_claude_delivery().map_err(claude_policy_error)?;
        let agent = self
            .claude_delivery
            .dismiss(id)
            .map_err(claude_policy_error)?;
        if let Some(agent) = &agent {
            self.request_drain(agent);
        }
        Ok(agent.is_some())
    }

    /// `delivery` with each attachment saved where the session can open it,
    /// read with the credential the delivery was read with; the delivery
    /// itself when it carries none. Bounded; never fails.
    pub(crate) async fn with_saved_attachments(
        &self,
        delivery: &Delivery,
        base_url: &str,
        token: &Secret,
    ) -> Option<Delivery> {
        if delivery.attachments.is_empty() {
            return None;
        }
        let mut saved = delivery.clone();
        let source = files::RelaycastFiles::new(base_url, token);
        files::save_attachments(
            &source,
            &self.config.app_data_dir.join(files::ATTACHMENTS_DIR),
            &mut saved.attachments,
            files::DOWNLOAD_TIMEOUT,
        )
        .await;
        Some(saved)
    }

    /// Gives every attachment that could not be saved the socket command
    /// that fetches it later, when this session can use the socket.
    pub(crate) async fn add_fetch_hints(&self, target: &Target, attachments: &mut [Attachment]) {
        let missing: Vec<String> = attachments
            .iter()
            .filter(|a| !matches!(a.local, Some(Ok(_))))
            .map(|a| a.file_id.clone())
            .collect();
        if missing.is_empty() {
            return;
        }
        let injector = self.plugins.injector.clone();
        let target = target.clone();
        let hints = tokio::task::spawn_blocking(move || {
            missing
                .into_iter()
                .map(|id| {
                    let hint = injector.fetch_hint(&target, &id);
                    (id, hint)
                })
                .collect::<Vec<_>>()
        })
        .await
        .unwrap_or_default();
        for (id, hint) in hints {
            if let Some(attachment) = attachments.iter_mut().find(|a| a.file_id == id) {
                attachment.fetch_hint = hint;
            }
        }
    }
}

#[cfg(test)]
mod interval_tests {
    use super::*;

    use crate::relay::daemon::Config;
    use crate::relay::paths::CorePaths;
    use crate::relay::push::PushTiming;

    #[test]
    fn queue_poll_cadence_is_per_registration_push_state() {
        let timing = DeliveryTiming {
            safety_poll: Duration::from_secs(30),
            fast_poll: Duration::from_secs(3),
            ..DeliveryTiming::default()
        };
        assert_eq!(
            queue_poll_interval(Some(&PushState::Live), timing, 0),
            Duration::from_secs(30)
        );
        assert_eq!(
            queue_poll_interval(Some(&PushState::Connecting), timing, 0),
            Duration::from_secs(3)
        );
        assert_eq!(queue_poll_interval(None, timing, 0), Duration::from_secs(3));
    }

    #[test]
    fn empty_queue_backoff_is_bounded_and_never_delays_live_push_safety() {
        let timing = DeliveryTiming::default();
        let delays: Vec<_> = (0..5)
            .map(|empty| queue_poll_interval(None, timing, empty).as_secs())
            .collect();
        assert_eq!(delays, vec![3, 6, 12, 15, 15]);
        assert_eq!(
            queue_poll_interval(None, timing, u32::MAX),
            Duration::from_secs(15)
        );
        assert_eq!(
            queue_poll_interval(Some(&PushState::Live), timing, u32::MAX),
            timing.safety_poll
        );
    }

    #[test]
    fn slow_queue_read_credits_request_start_and_preserves_newer_presence() {
        let started = Instant::now();
        let finished = started + Duration::from_secs(25);
        let mut state = DeliveryState::default();
        state.queue_read_succeeded("quiet", false, started, finished);
        assert_eq!(state.last_heartbeat["quiet"], started);
        assert_eq!(state.last_queue_poll["quiet"], finished);
        assert_eq!(state.empty_queue_reads["quiet"], 1);
        let heartbeat = started + Duration::from_secs(10);
        state.last_heartbeat.insert("quiet".into(), heartbeat);
        state.queue_read_succeeded("quiet", true, started, finished);
        assert_eq!(state.last_heartbeat["quiet"], heartbeat);
        assert_eq!(state.empty_queue_reads["quiet"], 0);
    }

    #[test]
    fn queue_read_presence_requires_the_exact_current_credential() {
        let original: Registration = serde_json::from_value(serde_json::json!({
            "name": "quiet", "agentID": "old-id",
            "target": {"kind": "codex", "id": "old-session"},
            "baseURL": "https://old.example", "registeredAt": 1790683200.0
        }))
        .unwrap();
        let old_token = Secret::new("old-token");
        assert!(queue_read_matches_credential(
            &original,
            &old_token,
            Some((&original, &old_token))
        ));
        assert!(!queue_read_matches_credential(&original, &old_token, None));
        let mut replacement = original.clone();
        replacement.agent_id = "new-id".into();
        assert!(!queue_read_matches_credential(
            &original,
            &old_token,
            Some((&replacement, &old_token))
        ));
        replacement = original.clone();
        replacement.base_url = "https://new.example".into();
        assert!(!queue_read_matches_credential(
            &original,
            &old_token,
            Some((&replacement, &old_token))
        ));
        let new_token = Secret::new("new-token");
        assert!(!queue_read_matches_credential(
            &original,
            &old_token,
            Some((&original, &new_token))
        ));
    }

    #[test]
    fn stale_queue_read_does_not_credit_the_replacement() {
        let temp = tempfile::tempdir().unwrap();
        let config = Config {
            paths: CorePaths::for_socket(temp.path().join("core.sock")).unwrap(),
            home: temp.path().into(),
            app_data_dir: temp.path().join("app-data"),
            env: Default::default(),
            version: "0.0.0-test".into(),
            host_name: "Test Desk.local".into(),
            rediscover_every: Duration::from_secs(3600),
            push_timing: PushTiming::default(),
            delivery_timing: DeliveryTiming::default(),
        };
        let (core, _signals) = Core::new(config);
        let original: Registration = serde_json::from_value(serde_json::json!({
            "name": "quiet", "agentID": "old-id",
            "target": {"kind": "codex", "id": "old-session"},
            "baseURL": "https://old.example", "registeredAt": 1790683200.0
        }))
        .unwrap();
        let old_token = Secret::new("old-token");
        let started = Instant::now();
        core.store
            .update(|s| {
                s.registrations.push(original.clone());
                s.tokens.insert("quiet".into(), old_token.clone());
            })
            .unwrap();
        core.credit_queue_read_if_current(&original, &old_token, false, started, started);
        assert_eq!(
            core.delivery.lock().unwrap().last_queue_poll["quiet"],
            started
        );

        for replacement in [None, Some("agent"), Some("url"), Some("token")] {
            core.delivery.lock().unwrap().last_queue_poll.clear();
            core.delivery.lock().unwrap().last_heartbeat.clear();
            core.delivery.lock().unwrap().empty_queue_reads.clear();
            core.store
                .update(|s| {
                    s.registrations.clear();
                    s.tokens.clear();
                    if let Some(change) = replacement {
                        let mut next = original.clone();
                        if change == "agent" {
                            next.agent_id = "new-id".into();
                        }
                        if change == "url" {
                            next.base_url = "https://new.example".into();
                        }
                        s.registrations.push(next);
                        s.tokens.insert(
                            "quiet".into(),
                            Secret::new(if change == "token" {
                                "new-token"
                            } else {
                                "old-token"
                            }),
                        );
                    }
                })
                .unwrap();
            core.credit_queue_read_if_current(&original, &old_token, false, started, started);
            let state = core.delivery.lock().unwrap();
            assert!(
                !state.last_queue_poll.contains_key("quiet"),
                "stale {replacement:?} queue read postponed polling"
            );
            assert!(
                !state.last_heartbeat.contains_key("quiet"),
                "stale {replacement:?} queue read credited presence"
            );
            assert!(
                !state.empty_queue_reads.contains_key("quiet"),
                "stale {replacement:?} queue read changed backoff"
            );
        }
    }

    #[test]
    fn gated_work_does_not_advance_its_schedule() {
        let mut schedule = HashMap::new();
        let now = Instant::now();
        assert!(!claim_due(
            &mut schedule,
            "alice",
            Duration::from_secs(30),
            false,
            now
        ));
        assert!(!schedule.contains_key("alice"));
        assert!(claim_due(
            &mut schedule,
            "alice",
            Duration::from_secs(30),
            true,
            now
        ));
    }
}

/// Records the reply paths a delivery opened, owned by the registration its
/// session has now: a renamed agent's remaining deliveries are answered as
/// the new name. Read in the same store change as the write, so a rename
/// cannot slip between them.
fn record_reply(
    store: &mut crate::relay::store::Store,
    delivery: &Delivery,
    registration: &Registration,
    manual: bool,
    prefix: &str,
) {
    let owner = store.reply_owner(registration).clone();
    store.record_reply_opportunity(delivery, &owner, manual, prefix);
}

impl Core {
    /// A push channel's wake: `frame` is a pushed delivery, `None` asks for
    /// a queue read.
    pub fn wake(&self, agent: String, frame: Option<Value>) {
        if self.is_person(&agent) {
            self.person_woke();
            return;
        }
        match frame.as_ref().and_then(Delivery::from_push_frame) {
            Some(delivery) => self.enqueue(&agent, Some(delivery)),
            None => self.enqueue(&agent, None),
        }
    }

    /// Reads one agent's queue soon. A request made while the agent's work
    /// is running is folded into that run.
    pub fn request_drain(&self, name: &str) {
        self.enqueue(name, None);
    }

    fn enqueue(&self, name: &str, delivery: Option<Delivery>) {
        let start = {
            let mut state = self.delivery.lock().unwrap();
            let line = state.lines.entry(name.into()).or_default();
            match delivery {
                Some(delivery) => line.pushed.push_back(delivery),
                None => line.drain = true,
            }
            !std::mem::replace(&mut line.running, true)
        };
        if start {
            if let Some(core) = self.arc() {
                let name = name.to_string();
                tokio::spawn(async move { core.pump(name).await });
            }
        }
    }

    /// Forgets the runtime's memory of a removed agent.
    pub(crate) fn forget_agent(&self, name: &str) {
        let approval_error = match self.claude_delivery.remove_agent(name) {
            Ok(true) => {
                self.hub.invalidated(Listing::Activity);
                None
            }
            Ok(false) => None,
            Err(error) => Some(format!(
                "Could not remove @{name}'s Claude approval requests — {error}"
            )),
        };
        let queue_error = {
            let mut state = self.delivery.lock().unwrap();
            state.queue_errors.remove(name);
            state.retries.retain(|_, retry| retry.agent != name);
            state.inbox.remove(name);
            state.queue_errors.values().next().cloned()
        };
        let error = approval_error.or(queue_error);
        self.hub
            .update(|status| status.agents.delivery_error = error);
    }

    async fn pump(self: Arc<Core>, name: String) {
        loop {
            let work = {
                let mut state = self.delivery.lock().unwrap();
                // After shutdown nothing new starts; what is left stays in
                // Relaycast's queue for the next start.
                if self.stopping() {
                    state.lines.remove(&name);
                    return;
                }
                let Some(line) = state.lines.get_mut(&name) else {
                    return;
                };
                if let Some(delivery) = line.pushed.pop_front() {
                    Work::Pushed(Box::new(delivery))
                } else if std::mem::take(&mut line.drain) {
                    Work::Drain
                } else {
                    state.lines.remove(&name);
                    return;
                }
            };
            match work {
                Work::Pushed(delivery) => {
                    if let Some((registration, _)) = self.agent_credential(&name) {
                        self.handle(&delivery, &registration, true).await;
                    }
                }
                Work::Drain => self.drain(&name).await,
            }
        }
    }

    /// The registration and token an agent acts with: deliveries to it are
    /// handled, and the relay-send socket sends as it, with these. Includes
    /// an agent's alias, and an alias being renamed away from.
    pub fn agent_credential(&self, name: &str) -> Option<(Registration, Secret)> {
        let current = self.store.read(|store| store.credential_named(name));
        current.or_else(|| self.retiring.lock().unwrap().get(name).cloned())
    }

    /// Ignore acknowledgements queued by a socket for a retired credential.
    pub(crate) fn record_push_presence(&self, target: &PushTarget, sent_at: Instant) {
        if self
            .agent_credential(&target.agent)
            .is_some_and(|(registration, token)| {
                registration.base_url == target.base_url && token == target.token
            })
        {
            self.delivery
                .lock()
                .unwrap()
                .presence_confirmed(&target.agent, sent_at);
        }
    }

    /// Before a session sends through the relay-send socket as `agent`:
    /// claims the automatic final answer that send replaces (the exact turn
    /// for `reply_to`, else the latest from `endpoint`), on disk, so the
    /// answer loop never sends a second one. When the claim cannot be saved
    /// nothing may be sent.
    pub fn claim_socket_reply(
        &self,
        agent: &str,
        endpoint: &Endpoint,
        reply_to: Option<&str>,
    ) -> Result<(), RpcError> {
        let Some((registration, _)) = self.agent_credential(agent) else {
            return Ok(());
        };
        // Read in the same change as the claim: during a rename the old
        // name still sends, but its answers are already the new agent's.
        self.store
            .update(|store| {
                let owner = store.reply_owner(&registration).agent_id.clone();
                store.claim_socket_reply(&owner, endpoint, reply_to)
            })
            .map(drop)
            .map_err(|error| {
                RpcError::new(
                    crate::relay::protocol::ErrorKind::StoreFailed,
                    format!("Could not save reply state, so nothing was sent. {error}"),
                )
            })
    }

    /// The messages a session was shown a reply command for: the parents
    /// its socket send may answer beneath.
    pub fn reply_parents(&self, agent: &str) -> HashSet<String> {
        match self.agent_credential(agent) {
            Some((registration, _)) => self
                .store
                .read(|s| s.reply_routes_for(&s.reply_owner(&registration).agent_id)),
            None => Default::default(),
        }
    }

    /// Allows `message_id` as a reply parent before the prompt is handed
    /// over. Injection can return only after the session has already read
    /// the command, and `/send` rejects a parent that is not recorded yet.
    fn authorize_reply_parent(&self, registration: &Registration, message_id: &str) {
        let _ = self.store.remember(|store| {
            let owner = store.reply_owner(registration).agent_id.clone();
            store.record_reply_route(&owner, message_id);
        });
    }

    /// A prompt that certainly never arrived must not stay replyable.
    fn revoke_reply_parent(&self, registration: &Registration, message_id: &str) {
        let _ = self.store.remember(|store| {
            let owner = store.reply_owner(registration).agent_id.clone();
            store.forget_reply_route(&owner, message_id);
        });
    }

    /// Whether the session sent `delivery` itself, as its name or its alias.
    fn sent_by_itself(&self, delivery: &Delivery, registration: &Registration) -> bool {
        let Some(sender) = delivery.sender.as_deref() else {
            return false;
        };
        sender == registration.name
            || self
                .store
                .read(|s| s.reply_owner(registration).answers_to(sender))
    }

    /// Whether `registration` is still the agent under its name: not
    /// removed, nor replaced, since it was read.
    fn current(&self, registration: &Registration) -> bool {
        self.agent_credential(&registration.name)
            .is_some_and(|(active, _)| active.agent_id == registration.agent_id)
    }

    async fn drain(self: &Arc<Core>, name: &str) {
        let Some((registration, token)) = self.agent_credential(name) else {
            return;
        };
        // An absent registration's queue is never read, not even by a retry
        // scheduled before its session ended: a read with its token would
        // show the agent active again. Its messages wait on Relaycast.
        if registration.missing_since.is_some() {
            return;
        }
        let workspace = self.relaycast_registration_scope(&registration, &token);
        if !self.relaycast_poll_allowed(&workspace) {
            // A periodic request may have been queued just before another
            // call established the workspace pause. Do not let that gated
            // no-op consume this agent's safety-net interval.
            self.delivery.lock().unwrap().last_queue_poll.remove(name);
            return;
        }
        let held_before_read = self.claude_delivery.held_ids_for_agent(name);
        let started = Instant::now();
        let result = client::deliveries(&registration.base_url, &token).await;
        self.observe_relaycast_result(&workspace, &result);
        match result {
            Ok(deliveries) => {
                self.credit_queue_read_if_current(
                    &registration,
                    &token,
                    deliveries.iter().any(|d| d.is_pending()),
                    started,
                    Instant::now(),
                );
                self.set_queue_error(name, None);
                // What left the queue (settled, expired) is not tried again.
                let queued: HashSet<&str> = deliveries.iter().map(|d| d.id.as_str()).collect();
                match self
                    .claude_delivery
                    .reconcile_queue(&held_before_read, &queued)
                {
                    Ok(true) => self.hub.invalidated(Listing::Activity),
                    Ok(false) => {}
                    Err(error) => self.set_queue_error(
                        name,
                        Some(format!(
                            "@{name}: Could not clean up expired approval requests — {error}"
                        )),
                    ),
                }
                self.delivery
                    .lock()
                    .unwrap()
                    .retries
                    .retain(|id, retry| retry.agent != name || queued.contains(id.as_str()));
                self.handle_pending(&deliveries, &registration).await;
            }
            // An agent removed while its queue was read reports nothing.
            Err(error) if self.current(&registration) => {
                let mapped = RpcError::from_relaycast(&error);
                self.set_queue_error(name, Some(format!("@{name}: {}", mapped.message)));
            }
            Err(_) => {}
        }
    }

    fn set_queue_error(&self, name: &str, error: Option<String>) {
        let first = {
            let mut state = self.delivery.lock().unwrap();
            match error {
                Some(error) => state.queue_errors.insert(name.into(), error),
                None => state.queue_errors.remove(name),
            };
            state.queue_errors.values().next().cloned()
        };
        self.hub
            .update(|status| status.agents.delivery_error = first);
    }

    /// One delivery, under its agent's lock: never handled twice at once,
    /// and never injected once the agent was removed or replaced since
    /// `read` was read.
    async fn handle(self: &Arc<Core>, delivery: &Delivery, read: &Registration, from_push: bool) {
        let lock = self.agent_locks.get(&read.name);
        let _delivering = lock.lock().await;
        if self.stopping() {
            return;
        }
        // The registration as it is now, not as the queue read began: a
        // webhook or integration channel added meanwhile already routes.
        let Some((registration, token)) = self
            .agent_credential(&read.name)
            .filter(|(active, _)| active.agent_id == read.agent_id)
        else {
            return;
        };
        // A pushed delivery for a session that has since ended waits too.
        if registration.missing_since.is_some() {
            return;
        }
        let (registration, token) = (&registration, &token);
        let waiting = self
            .delivery
            .lock()
            .unwrap()
            .retries
            .get(&delivery.id)
            .is_some_and(|retry| retry.after > Instant::now());
        if waiting {
            return;
        }
        let base = &registration.base_url;
        let workspace = self.relaycast_registration_scope(registration, token);
        // Consent belongs to the active desktop workspace, not to whichever
        // registration credential happened to read this delivery.
        let _ = self.scope_claude_delivery();
        let (handled, in_doubt, refused) = self.store.read(|s| {
            (
                s.was_handled(&delivery.id),
                s.was_in_doubt(&delivery.id),
                s.was_refused(&delivery.id),
            )
        });
        if handled {
            // Put into the session on an earlier pass whose settlement was
            // lost: make the record durable, then settle again. An ack would
            // record an in-doubt delivery as arrived, so it is failed again.
            if self.store.flush().is_ok() {
                let _ = if refused {
                    self.settle_refused_delivery(registration, token, &delivery.id)
                        .await
                } else if in_doubt {
                    self.relaycast_fail(
                        &workspace,
                        base,
                        token,
                        &delivery.id,
                        "in doubt, not resent",
                        false,
                    )
                    .await
                } else {
                    self.relaycast_ack(&workspace, base, token, &delivery.id)
                        .await
                };
                self.claude_delivery.finish(&delivery.id);
            }
            return;
        }
        if self.sent_by_itself(delivery, registration) {
            let _ = self
                .relaycast_ack(&workspace, base, token, &delivery.id)
                .await;
            return;
        }
        let webhook_channel = registration.webhook.as_ref().map(|w| w.channel_id.as_str());
        let integration_channel = registration.integration_channel_id.as_deref();
        let decision = decide_for_agent(
            delivery,
            &registration.name,
            webhook_channel,
            integration_channel,
        );
        if let Decision::Skip(reason) = decision {
            let _ = self
                .relaycast_ack(&workspace, base, token, &delivery.id)
                .await;
            self.record(
                registration,
                delivery,
                DeliveryOutcome::Skipped,
                Some(reason),
            );
            return;
        }
        // The owner's reply to a live app-server request is a protocol
        // answer, not a new user turn (`spawn::drive`).
        if self
            .took_owner_reply(registration, delivery, (&workspace, base, token))
            .await
        {
            return;
        }
        match self.claude_delivery.decide(registration, delivery) {
            ClaudeConsent::Deliver => {}
            ClaudeConsent::Hold => {
                self.hold_claude_delivery(registration, delivery);
                return;
            }
            ClaudeConsent::Dismiss => {
                if self
                    .relaycast_ack(&workspace, base, token, &delivery.id)
                    .await
                {
                    self.claude_delivery.finish(&delivery.id);
                }
                self.record(
                    registration,
                    delivery,
                    DeliveryOutcome::Skipped,
                    Some("Dismissed by the local user.".into()),
                );
                return;
            }
            ClaudeConsent::ReadQueue => {
                if from_push {
                    self.request_drain(&registration.name);
                } else {
                    // The full queue record is also missing an authenticated
                    // address. Keep it visible for a one-time choice, but do
                    // not offer a persistent sender exception.
                    self.hold_claude_delivery(registration, delivery);
                }
                return;
            }
            ClaudeConsent::Handled(outcome) => {
                let recorded = match &outcome {
                    PriorOutcome::Delivered => self.store.remember(|store| {
                        store.record_injected(&delivery.id);
                    }),
                    PriorOutcome::InDoubt => self.store.remember(|store| {
                        store.record_in_doubt(&delivery.id);
                    }),
                    PriorOutcome::Refused(reason) => self.store.remember(|store| {
                        store.queue_refusal_with_reason(
                            &delivery.id,
                            &registration.agent_id,
                            Some(reason),
                        );
                    }),
                };
                if recorded.is_ok() {
                    match outcome {
                        PriorOutcome::Delivered => {
                            let _ = self
                                .relaycast_ack(&workspace, base, token, &delivery.id)
                                .await;
                        }
                        PriorOutcome::InDoubt => {
                            let _ = self
                                .relaycast_fail(
                                    &workspace,
                                    base,
                                    token,
                                    &delivery.id,
                                    "in doubt, not resent",
                                    false,
                                )
                                .await;
                        }
                        PriorOutcome::Refused(_) => {
                            self.settle_refused_delivery(registration, token, &delivery.id)
                                .await;
                        }
                    }
                    self.claude_delivery.finish(&delivery.id);
                }
                return;
            }
        }
        let from =
            |channel: Option<&str>| channel.is_some() && delivery.channel_id.as_deref() == channel;
        let via_webhook = from(webhook_channel);
        let via_integration = from(integration_channel);
        let injector = self.plugins.injector.clone();
        let mut saved = self.with_saved_attachments(delivery, base, token).await;
        if let Some(saved) = saved.as_mut() {
            self.add_fetch_hints(&registration.target, &mut saved.attachments)
                .await;
        }
        let (text, hint, native) = self
            .session_text(
                registration,
                (delivery, saved.as_ref()),
                via_webhook,
                via_integration,
            )
            .await;
        let terminal = via_integration
            .then(|| {
                delivery.text.as_deref().and_then(|text| {
                    crate::relay::integrations::terminal_integration(
                        registration,
                        text,
                        delivery.relayfile_path.as_deref(),
                    )
                })
            })
            .flatten();
        let registered = registration.clone();
        let routed = delivery.clone();
        // The command is already in `text`. Record the parent before the
        // session can run it. A Muse courier can sit inside this call for
        // the whole receipt window after the prompt is visible.
        let manual = hint.is_some();
        if manual {
            self.authorize_reply_parent(registration, &delivery.message_id);
        }
        // A spawned agent's harness may have a route of its own into it.
        let spawner = self.plugins.spawner.clone();
        let outcome = tokio::task::spawn_blocking(move || {
            let route = DeliveryRoute::of(&routed).native(native);
            spawner.deliver_registered(&*injector, &registered, &route, &text)
        })
        .await
        .unwrap_or_else(|_| InjectOutcome::InDoubt("the injection stopped unexpectedly".into()));
        let prefix = self.machine_prefix.clone();
        match outcome {
            InjectOutcome::Delivered => {
                {
                    let mut state = self.delivery.lock().unwrap();
                    state.retries.remove(&delivery.id);
                }
                if registration.target.kind == SessionKind::ClaudeTerminal {
                    let _ = self.claude_delivery.consume(
                        &delivery.id,
                        &registration.name,
                        PriorOutcome::Delivered,
                    );
                    // Delivered stays delivered; this only watches whether
                    // the session reads it.
                    self.watch_inbox(registration, &delivery.message_id);
                }
                let recorded = self.store.remember(|store| {
                    store.record_injected(&delivery.id);
                    record_reply(store, delivery, registration, manual, &prefix);
                    mark_terminal(store, registration, terminal.as_ref());
                });
                // Acknowledged only once the record that prevents a second
                // injection is on disk; otherwise the next pass retries the
                // save and the acknowledgement, never the injection.
                if recorded.is_ok() {
                    let _ = self
                        .relaycast_ack(&workspace, base, token, &delivery.id)
                        .await;
                    clean_terminal(self, registration, terminal);
                    self.claude_delivery.finish(&delivery.id);
                }
                self.record_settled(
                    registration,
                    delivery,
                    DeliveryOutcome::Injected,
                    None,
                    Some(DeliverySettlement::Visible),
                );
            }
            InjectOutcome::InDoubt(reason) => {
                self.delivery.lock().unwrap().retries.remove(&delivery.id);
                // The prompt, and its reply command, may already be in the
                // session: keep the reply paths as for a confirmed injection.
                // Reported only once the in-doubt record is on disk; until
                // then the next pass saves it and reports it.
                if registration.target.kind == SessionKind::ClaudeTerminal {
                    let _ = self.claude_delivery.consume(
                        &delivery.id,
                        &registration.name,
                        PriorOutcome::InDoubt,
                    );
                }
                let recorded = self.store.remember(|store| {
                    store.record_in_doubt(&delivery.id);
                    record_reply(store, delivery, registration, manual, &prefix);
                    mark_terminal(store, registration, terminal.as_ref());
                });
                if recorded.is_ok() {
                    let _ = self
                        .relaycast_fail(
                            &workspace,
                            base,
                            token,
                            &delivery.id,
                            &format!("in doubt, not resent: {reason}"),
                            false,
                        )
                        .await;
                    clean_terminal(self, registration, terminal);
                    self.claude_delivery.finish(&delivery.id);
                }
                self.record(
                    registration,
                    delivery,
                    DeliveryOutcome::InDoubt,
                    Some(format!("May have arrived; not resent — {reason}")),
                );
            }
            InjectOutcome::Retry(reason) => {
                // Nothing reached the session, so the command was not shown.
                self.revoke_reply_parent(registration, &delivery.message_id);
                // It stays in Relaycast's queue:
                // tried again shortly (a briefly locked queue or a restarting
                // session usually clears in seconds), and it expires there if
                // the session never comes back.
                let units = {
                    let mut state = self.delivery.lock().unwrap();
                    let failures = state
                        .retries
                        .get(&delivery.id)
                        .map_or(0, |retry| retry.failures)
                        + 1;
                    let units = 30f64.min(3.0 * 2f64.powi(failures as i32 - 1));
                    let delay = self.config.delivery_timing.retry_unit.mul_f64(units);
                    state.retries.insert(
                        delivery.id.clone(),
                        Retry {
                            agent: registration.name.clone(),
                            after: Instant::now() + delay,
                            failures,
                        },
                    );
                    units
                };
                self.drain_later(registration, units + 0.2);
                self.record(
                    registration,
                    delivery,
                    DeliveryOutcome::Failed,
                    Some(reason),
                );
            }
            InjectOutcome::Refused(reason) => {
                self.revoke_reply_parent(registration, &delivery.message_id);
                self.delivery.lock().unwrap().retries.remove(&delivery.id);
                // A terminal event is not disposable even when its text cannot
                // enter the session. Save the retirement marker before making
                // Relaycast's non-retryable settlement durable.
                if registration.target.kind == SessionKind::ClaudeTerminal {
                    let _ = self.claude_delivery.consume(
                        &delivery.id,
                        &registration.name,
                        PriorOutcome::Refused(reason.clone()),
                    );
                }
                let recorded = self
                    .store
                    .remember(|store| {
                        store.queue_refusal_with_reason(
                            &delivery.id,
                            &registration.agent_id,
                            Some(&reason),
                        );
                        mark_terminal(store, registration, terminal.as_ref());
                    })
                    .is_ok();
                // Hide an archived session immediately, but keep its
                // registration until the independent settlement journal drains.
                if registration.target.kind == SessionKind::ClaudeCloud
                    && crate::relay::claude::is_archived_refusal(&reason)
                {
                    // Through an alias, the session is archived under its name.
                    let name = self
                        .store
                        .read(|s| s.reply_owner(registration).name.clone());
                    self.mark_sessions_archived(std::slice::from_ref(&name));
                }
                if recorded {
                    self.settle_refused_delivery(registration, token, &delivery.id)
                        .await;
                    clean_terminal(self, registration, terminal);
                    self.claude_delivery.finish(&delivery.id);
                }
                self.record(
                    registration,
                    delivery,
                    DeliveryOutcome::Failed,
                    Some(format!("Refused; not retried — {reason}")),
                );
            }
            InjectOutcome::Waiting(ref reason)
            | InjectOutcome::Accepted(ref reason)
            | InjectOutcome::WaitingForTurn(ref reason) => {
                // Waiting never handed the prompt over. Accepted and
                // waiting-for-turn did: the command becomes visible before
                // this delivery is confirmed, so the parent stays allowed.
                if matches!(outcome, InjectOutcome::Waiting(_)) {
                    self.revoke_reply_parent(registration, &delivery.message_id);
                }
                {
                    let mut state = self.delivery.lock().unwrap();
                    let delay = self.config.delivery_timing.retry_unit.mul_f64(5.0);
                    state.retries.insert(
                        delivery.id.clone(),
                        Retry {
                            agent: registration.name.clone(),
                            after: Instant::now() + delay,
                            failures: 0,
                        },
                    );
                }
                self.drain_later(registration, 5.2);
                self.record_settled(
                    registration,
                    delivery,
                    DeliveryOutcome::Waiting,
                    Some(reason.clone()),
                    DeliverySettlement::of(&outcome),
                );
            }
        }
    }

    /// Reads the agent's queue again after `units` retry units, if it is
    /// still on the relay then.
    fn drain_later(self: &Arc<Core>, registration: &Registration, units: f64) {
        let core = self.clone();
        let registration = registration.clone();
        let delay = self.config.delivery_timing.retry_unit.mul_f64(units);
        tokio::spawn(async move {
            tokio::time::sleep(delay).await;
            if core.current(&registration) {
                core.request_drain(&registration.name);
            }
        });
    }

    fn record(
        &self,
        registration: &Registration,
        delivery: &Delivery,
        outcome: DeliveryOutcome,
        detail: Option<String>,
    ) {
        self.record_settled(registration, delivery, outcome, detail, None);
    }

    fn record_settled(
        &self,
        registration: &Registration,
        delivery: &Delivery,
        outcome: DeliveryOutcome,
        detail: Option<String>,
        settlement: Option<DeliverySettlement>,
    ) {
        self.record_activity(DeliveryActivity {
            at_ms: now_ms(),
            agent: registration.name.clone(),
            sender: delivery.sender.clone(),
            preview: preview(delivery),
            outcome,
            detail,
            settlement,
        });
    }

    pub(crate) fn record_activity(&self, entry: DeliveryActivity) {
        {
            let mut state = self.delivery.lock().unwrap();
            state.activity.push_front(entry);
            state.activity.truncate(ACTIVITY_KEPT);
        }
        self.hub.invalidated(Listing::Activity);
    }

    /// Recent delivery outcomes, newest first.
    pub fn activity_list(&self, limit: Option<usize>) -> Vec<DeliveryActivity> {
        let state = self.delivery.lock().unwrap();
        state
            .activity
            .iter()
            .take(limit.unwrap_or(ACTIVITY_KEPT))
            .cloned()
            .collect()
    }

    /// The safety net under push, until shutdown. A pass in progress
    /// finishes first.
    pub async fn delivery_loop(self: Arc<Core>) {
        let mut stopping = self.shutdown_requested();
        while !*stopping.borrow() {
            // Include the work in this pass in the poll interval. A slow
            // heartbeat cohort must not add another full sleep afterwards.
            let started = tokio::time::Instant::now();
            self.poll_once().await;
            // Re-evaluate after the pass: a newly joined Connect or a push
            // disconnect must select the fast cadence immediately.
            let next_poll = started + self.poll_interval();
            tokio::select! {
                _ = tokio::time::sleep_until(next_poll) => {}
                _ = stopping.changed() => {}
            }
        }
    }

    /// Waits until every agent's line of work has stopped.
    pub(crate) async fn deliveries_stopped(&self) {
        while !self.delivery.lock().unwrap().lines.is_empty() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    fn poll_interval(&self) -> Duration {
        if !self.connect.lock().unwrap().sessions.is_empty() {
            return self.config.delivery_timing.fast_poll;
        }
        // Only a present registration has a push channel; an absent one's
        // missing channel must not keep the fast poll going.
        let names: Vec<String> = self.store.read(|s| {
            s.registrations
                .iter()
                .filter(|r| r.missing_since.is_none())
                .map(|r| r.name.clone())
                .collect()
        });
        let status = self.status();
        let live = names
            .iter()
            .all(|name| status.push.get(name) == Some(&PushState::Live));
        let timing = self.config.delivery_timing;
        if !names.is_empty() && live {
            // Queue safety reads can be sparse while REST presence still
            // needs its own deadline (node heartbeats do not refresh it).
            timing.safety_poll.min(timing.heartbeat)
        } else {
            timing.fast_poll
        }
    }

    async fn settle_refused_delivery(
        &self,
        registration: &Registration,
        token: &Secret,
        id: &str,
    ) -> bool {
        let workspace = self.relaycast_registration_scope(registration, token);
        let reason = self.store.read(|s| {
            s.pending_refusal_settlements
                .as_deref()
                .unwrap_or_default()
                .iter()
                .find(|p| p.delivery_id == id)
                .and_then(|p| p.reason.as_deref())
                .map(|reason| format!("refused by the session: {reason}"))
                .unwrap_or_else(|| "refused by the session, not resent".into())
        });
        if self
            .relaycast_fail(
                &workspace,
                &registration.base_url,
                token,
                id,
                &reason,
                false,
            )
            .await
        {
            let _ = self.store.update(|s| s.settle_refusal(id));
            true
        } else {
            false
        }
    }

    /// Retry terminal refusals even for absent/archived registrations. Never
    /// read their queue or make them present merely to settle a refusal.
    async fn retry_refused_settlements(&self) {
        let pending = self
            .store
            .read(|s| s.pending_refusal_settlements.clone().unwrap_or_default());
        for pending in pending {
            if self.stopping() {
                break;
            }
            let registration = self
                .store
                .read(|s| s.credential_for_agent_id(&pending.agent_id))
                .or_else(|| {
                    self.retiring
                        .lock()
                        .unwrap()
                        .values()
                        .find(|(r, _)| r.agent_id == pending.agent_id)
                        .cloned()
                });
            let Some((registration, token)) = registration else {
                // Explicit removal/rename may discard the final credential
                // after a late refusal. Retire unresolvable work, keep history.
                let _ = self
                    .store
                    .update(|s| s.settle_refusal(&pending.delivery_id));
                continue;
            };
            let lock = self.agent_locks.get(&registration.name);
            let _delivering = lock.lock().await;
            if self.store.read(|s| {
                s.pending_refusal_settlements
                    .as_deref()
                    .unwrap_or_default()
                    .iter()
                    .any(|p| p == &pending)
            }) && self.store.flush().is_ok()
            {
                self.settle_refused_delivery(&registration, &token, &pending.delivery_id)
                    .await;
            }
        }
    }

    /// One pass: auto-activation, failed removals, the presence heartbeat,
    /// and every agent queue whose own safety-net interval is due.
    pub async fn poll_once(self: &Arc<Core>) {
        let failures = self.activate_new_sessions().await;
        let report = {
            let mut state = self.delivery.lock().unwrap();
            let changed = state.last_activation_failures != failures;
            state.last_activation_failures = failures.clone();
            changed && !failures.is_empty()
        };
        if report {
            self.hub.activity(
                Level::Warning,
                format!(
                    "Could not put new sessions on the relay: {}",
                    failures.join("; ")
                ),
            );
        }
        self.retry_pending_cleanups().await;
        let clean_integrations = {
            let mut state = self.delivery.lock().unwrap();
            let due = state
                .last_integration_cleanup
                .is_none_or(|at| at.elapsed() >= Duration::from_secs(60));
            if due {
                state.last_integration_cleanup = Some(Instant::now());
            }
            due
        };
        if clean_integrations {
            let core = self.clone();
            tokio::spawn(async move { core.retry_unfinished_integrations().await });
        }
        let present = self.present_registrations();
        let names: HashSet<&str> = present
            .iter()
            .map(|(registration, _, _)| registration.name.as_str())
            .collect();
        self.delivery
            .lock()
            .unwrap()
            .last_heartbeat
            .retain(|name, _| names.contains(name.as_str()));
        self.poll_registration_queues(&present);
        let mut heartbeats: BoxFuture<'_, ()> =
            Box::pin(self.poll_registration_heartbeats(present.clone()));
        let mut refusals: BoxFuture<'_, ()> = Box::pin(self.retry_refused_settlements());
        let mut refusals_finished = false;
        let cadence = self.config.delivery_timing.fast_poll;
        let mut polls = tokio::time::interval_at(tokio::time::Instant::now() + cadence, cadence);
        polls.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        // A large or slow heartbeat cohort must not stretch delivery polls
        // from their own cadence to the cohort's total duration.
        let mut heartbeat_finished = false;
        let mut connect_polling = true;
        let mut connect_poll: BoxFuture<'_, ()> = Box::pin(self.poll_connects());
        loop {
            tokio::select! {
                _ = &mut heartbeats, if !heartbeat_finished => {
                    heartbeat_finished = true;
                    if !connect_polling && refusals_finished {
                        break;
                    }
                },
                _ = &mut connect_poll, if connect_polling => {
                    connect_polling = false;
                    if heartbeat_finished && refusals_finished {
                        break;
                    }
                },
                _ = &mut refusals, if !refusals_finished => {
                    refusals_finished = true;
                    if heartbeat_finished && !connect_polling { break; }
                },
                _ = polls.tick() => {
                    let present = self.present_registrations();
                    self.poll_registration_queues(&present);
                    // A held Connect read can outlive a full heartbeat
                    // interval. Keep due presence and refusal work moving,
                    // refreshing registrations after archives/removals.
                    if heartbeat_finished {
                        heartbeats = Box::pin(self.poll_registration_heartbeats(present));
                        heartbeat_finished = false;
                    }
                    if refusals_finished {
                        refusals = Box::pin(self.retry_refused_settlements());
                        refusals_finished = false;
                    }
                    // Keep one Connect pass in flight without suspending
                    // heartbeats or agent queues on a slow inbox. Retain
                    // its per-Connect lock, and finish any settlement pass
                    // before leaving rather than canceling it midway.
                    if !connect_polling && !(heartbeat_finished && refusals_finished) {
                        connect_poll = Box::pin(self.poll_connects());
                        connect_polling = true;
                    }
                },
            }
        }
    }

    fn present_registrations(&self) -> Vec<(Registration, Secret, WorkspaceScope)> {
        // A registration whose session has ended keeps its name and queued
        // messages, but is neither heartbeated nor read until it runs again.
        // An alias is heartbeated and read as an agent of its own.
        let present: Vec<(Registration, Secret)> = self.store.read(|s| {
            s.credentials()
                .into_iter()
                .filter(|(registration, _)| registration.missing_since.is_none())
                .collect()
        });
        present
            .into_iter()
            .map(|(registration, token)| {
                let workspace = self.relaycast_registration_scope(&registration, &token);
                (registration, token, workspace)
            })
            .collect()
    }

    async fn poll_registration_heartbeats(
        &self,
        present: Vec<(Registration, Secret, WorkspaceScope)>,
    ) {
        // One heartbeat at a time per workspace leaves admission capacity
        // for other writers. Observe each response before admitting the next
        // agent, and pace the cohort instead of sending a startup burst.
        // Independent workspaces can progress while another is slow; queue
        // reads above are already running and do not wait for this cohort.
        let status = self.status();
        let mut workspaces: BTreeMap<String, Vec<_>> = BTreeMap::new();
        let now = self.store.read(Store::current_names);
        for agent in present.into_iter().filter(|a| now.contains(&a.0.name)) {
            workspaces
                .entry(agent.2.key().to_owned())
                .or_default()
                .push(agent);
        }
        let status = &status;
        stream::iter(workspaces.into_values().map(|agents| async move {
            let lock = self
                .agent_locks
                .get(&format!("heartbeats:{}", agents[0].2.key()));
            let _heartbeating = lock.lock().await;
            let mut attempted = false;
            for (registration, token, workspace) in agents {
                let interval = heartbeat_interval(
                    &registration.base_url,
                    status.push.get(&registration.name),
                    self.config.delivery_timing,
                );
                if !is_due(
                    &self.delivery.lock().unwrap().last_heartbeat,
                    &registration.name,
                    interval,
                    Instant::now(),
                ) {
                    continue;
                }
                if attempted {
                    tokio::time::sleep(HEARTBEAT_SPACING).await;
                }
                let allowed = self.relaycast_write_allowed(&workspace);
                if !claim_due(
                    &mut self.delivery.lock().unwrap().last_heartbeat,
                    &registration.name,
                    interval,
                    allowed,
                    Instant::now(),
                ) {
                    // Every remaining agent in this group shares the same
                    // gate. Leave them due instead of waiting between skips.
                    if !allowed {
                        break;
                    }
                    continue;
                }
                attempted = true;
                let result = client::heartbeat(&registration.base_url, &token).await;
                self.observe_relaycast_write_result(&workspace, &result);
            }
        }))
        .buffer_unordered(HEARTBEAT_WORKSPACES)
        .collect::<Vec<_>>()
        .await;
    }

    fn poll_registration_queues(&self, present: &[(Registration, Secret, WorkspaceScope)]) {
        // An absent registration's queue is not read: a read with its token
        // would show the agent active on every device, and its messages
        // wait on Relaycast for the session to run again.
        let names: HashSet<&str> = present
            .iter()
            .map(|(registration, _, _)| registration.name.as_str())
            .collect();
        let status = self.status();
        let due: Vec<String> = {
            let now = Instant::now();
            let timing = self.config.delivery_timing;
            let mut state = self.delivery.lock().unwrap();
            state
                .last_queue_poll
                .retain(|name, _| names.contains(name.as_str()));
            state
                .empty_queue_reads
                .retain(|name, _| names.contains(name.as_str()));
            present
                .iter()
                .filter_map(|(registration, _, _workspace)| {
                    let interval = queue_poll_interval(
                        status.push.get(&registration.name),
                        timing,
                        state
                            .empty_queue_reads
                            .get(&registration.name)
                            .copied()
                            .unwrap_or(0),
                    );
                    // `drain` owns the gate permit immediately before its
                    // HTTP call. If it loses the workspace's single-flight
                    // race, it removes this timestamp so the poll stays due.
                    claim_due(
                        &mut state.last_queue_poll,
                        &registration.name,
                        interval,
                        true,
                        now,
                    )
                    .then(|| registration.name.clone())
                })
                .collect()
        };
        for name in due {
            self.request_drain(&name);
        }
    }

    /// Sends automatic final answers until shutdown. A pass in progress
    /// finishes first: an answer claimed on disk is always sent.
    pub async fn reply_loop(self: Arc<Core>) {
        let mut stopping = self.shutdown_requested();
        while !*stopping.borrow() {
            self.check_replies().await;
            self.check_inboxes().await;
            tokio::select! {
                _ = tokio::time::sleep(self.config.delivery_timing.replies) => {}
                _ = stopping.changed() => {}
            }
        }
    }

    /// One pass over unsent automatic answers.
    pub async fn check_replies(self: &Arc<Core>) {
        let pending: Vec<Reply> = self.store.read(|s| {
            s.replies
                .iter()
                .flatten()
                .filter(|r| r.claimed != Some(true))
                .cloned()
                .collect()
        });
        for reply in pending {
            self.check_reply(&reply).await;
        }
        let _ = self.store.update(|store| store.prune_replies());
    }

    async fn check_reply(self: &Arc<Core>, reply: &Reply) {
        let owner = self.store.read(|s| {
            let registration = s
                .registrations
                .iter()
                .find(|r| r.agent_id == reply.agent_id)?
                .clone();
            // One name per session: the answer goes out under its current name.
            let token = registration.sender_token(s.tokens.get(&registration.name)?.clone());
            Some((registration, token))
        });
        let Some((registration, token)) = owner else {
            return;
        };
        if reply.targets_integration(&registration) {
            // Would be written back to the provider as a comment nobody
            // asked for.
            let _ = self.store.update(|store| {
                if let Some(list) = store.replies.as_mut() {
                    list.retain(|r| {
                        !(r.agent_id == reply.agent_id && r.message_id == reply.message_id)
                    });
                }
            });
            return;
        }
        let changing = || {
            self.target_locks
                .get(&registration.target.key())
                .try_lock()
                .is_err()
        };
        if registration.reply_with_final_answer == Some(false) || changing() {
            return;
        }
        let injector = self.plugins.injector.clone();
        let registered = registration.clone();
        let reference = reply.message_ref();
        let answer = tokio::task::spawn_blocking(move || {
            injector.final_answer_registered(&registered, &reference)
        })
        .await
        .ok()
        .flatten();
        let Some(answer) = answer else {
            return;
        };
        if changing() || !self.requester_still_named(reply, &registration).await {
            return;
        }
        // Claimed on disk before anything is sent: a socket send racing this
        // read, or an uncertain network result, must never produce a second
        // answer.
        let claimed = self.store.update(|store| {
            let replying = store
                .registrations
                .iter()
                .any(|r| r.agent_id == reply.agent_id && r.reply_with_final_answer != Some(false));
            let entry = store
                .replies
                .iter_mut()
                .flatten()
                .find(|r| r.agent_id == reply.agent_id && r.message_id == reply.message_id);
            match entry {
                Some(entry) if replying && entry.claimed != Some(true) => {
                    entry.claimed = Some(true);
                    true
                }
                _ => false,
            }
        });
        match claimed {
            Ok(true) => {}
            Ok(false) => return,
            Err(_) => {
                self.hub.activity(
                    Level::Error,
                    format!(
                        "Could not save a reply claim for @{}; no reply sent.",
                        registration.name
                    ),
                );
                return;
            }
        }
        let key = format!("desktop-reply-{}-{}", reply.agent_id, reply.message_id);
        let base = &registration.base_url;
        let sent = match &reply.destination {
            Destination::Thread(parent) => {
                client::reply(base, &token, &parent.value, &answer, Some(key)).await
            }
            Destination::Dm(name) => {
                client::send_dm(
                    base,
                    &token,
                    &Endpoint::Name(name.value.clone()),
                    &answer,
                    Some(key),
                )
                .await
            }
            Destination::Address(address) => {
                client::send_dm(
                    base,
                    &token,
                    &Endpoint::Address(address.value.clone()),
                    &answer,
                    Some(key),
                )
                .await
            }
        };
        let (outcome, detail, preview) = match sent {
            Ok(_) => (
                DeliveryOutcome::Answered,
                Some("Final answer sent".to_string()),
                answer.chars().take(140).collect(),
            ),
            Err(_) => (
                DeliveryOutcome::InDoubt,
                Some("Reply may have arrived; not resent.".to_string()),
                format!("Reply ref {}", reply.message_ref()),
            ),
        };
        self.record_activity(DeliveryActivity {
            at_ms: now_ms(),
            agent: registration.name.clone(),
            sender: None,
            preview,
            outcome,
            detail,
            settlement: None,
        });
    }
}
