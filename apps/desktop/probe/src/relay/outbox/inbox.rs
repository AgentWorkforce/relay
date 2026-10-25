//! The inboxes: where every cloud transport hands in a message, and where
//! each message's fate goes back out as an ack.
//!
//! ```text
//! cloud ─▶ receive ─▶ [known id] ─▶ [id shape] ─▶ [pause] ─▶ [rate limit] ─▶ [sharing policy]
//!                         │                                                     ├─ deny  → rejected (recorded)
//!                    re-ack its state                                           ├─ hold  → held
//!                                                                               └─ deliver → queued
//!          then the delivery worker drives delivered / completed / failed / expired acks
//! ```
//!
//! Receipt is serialized, so dedupe, policy, rate accounting and the first
//! ack happen as one step. A refusal for a reason that may not hold later
//! (a pause, the rate limit, sharing) is recorded, so a repeat of the id
//! gets the same answer instead of a delivery. At most 30 messages per
//! sender per thread are accepted in any 60 s, refusals included.

use super::claude_delivery::ClaudeDelivery;
use super::codex_delivery::CodexDelivery;
use super::messages::{
    is_claude_session_id, is_codex_thread_id, message_ref, AckStatus, ClaudeInboundMessage,
    CodexInboundAck, CodexInboundMessage,
};
use super::sharing::{CodexSharingDecision, CodexSharingPolicy};
use super::store::{CodexOutboxMessage, NewMessage, OutboxState};
use super::{Clock, OutboxError, Result, DEFAULT_LIFETIME};
use std::sync::{Arc, Mutex, RwLock, Weak};
use std::time::{Duration, SystemTime};

const RATE_LIMIT: usize = 30;
const RATE_WINDOW: Duration = Duration::from_secs(60);

type AckSink = Arc<dyn Fn(CodexInboundAck) + Send + Sync>;
type Gate = Arc<dyn Fn() -> bool + Send + Sync>;
type ThreadGate = Arc<dyn Fn(&str) -> bool + Send + Sync>;

fn read<T: Clone>(lock: &RwLock<T>) -> T {
    lock.read().unwrap_or_else(|p| p.into_inner()).clone()
}

fn write<T>(lock: &RwLock<T>, value: T) {
    *lock.write().unwrap_or_else(|p| p.into_inner()) = value;
}

/// Receives Codex messages from the cloud into a `CodexDelivery`.
pub struct CodexInbox {
    delivery: Arc<CodexDelivery>,
    policy: Arc<CodexSharingPolicy>,
    ack_sink: RwLock<Option<AckSink>>,
    is_unrestricted: RwLock<ThreadGate>,
    is_paused: RwLock<Gate>,
    is_authorized: RwLock<Gate>,
    now: RwLock<Clock>,
    lock: Mutex<()>,
}

impl CodexInbox {
    /// Wires `delivery` to `policy` through this inbox: the policy is
    /// re-checked before every send, delivery runs only while this inbox
    /// can deliver, and every state change is acked from the latest
    /// committed state.
    ///
    /// Until set, threads count as unrestricted (the restrictive answer),
    /// receipt is unpaused and authorized, and the clock is the delivery's.
    pub fn new(delivery: Arc<CodexDelivery>, policy: Arc<CodexSharingPolicy>) -> Arc<Self> {
        let clock: Clock = {
            let delivery = delivery.clone();
            Arc::new(move || delivery.now())
        };
        Arc::new_cyclic(|inbox: &Weak<CodexInbox>| {
            let weak = inbox.clone();
            let decide_policy = policy.clone();
            delivery.set_authorize(move |thread_id| {
                let unrestricted = weak
                    .upgrade()
                    .is_none_or(|inbox| inbox.is_unrestricted(thread_id));
                decide_policy.decide(thread_id, unrestricted)
            });
            let weak = inbox.clone();
            delivery
                .set_is_paused(move || !weak.upgrade().is_some_and(|inbox| inbox.can_deliver()));
            let weak = inbox.clone();
            delivery.set_on_change(move |message| {
                let Some(inbox) = weak.upgrade() else { return };
                let _serial = inbox.serial();
                // The latest committed state: a delayed callback must not
                // move an ack backwards past a redelivery or an approval.
                if let Ok(Some(current)) = inbox.delivery.message(&message.id) {
                    inbox.emit(&current);
                }
            });
            CodexInbox {
                delivery: delivery.clone(),
                policy,
                ack_sink: RwLock::new(None),
                is_unrestricted: RwLock::new(Arc::new(|_| true)),
                is_paused: RwLock::new(Arc::new(|| false)),
                is_authorized: RwLock::new(Arc::new(|| true)),
                now: RwLock::new(clock),
                lock: Mutex::new(()),
            }
        })
    }

    // MARK: Gates

    /// Receives every ack as it happens, beside the journal in the outbox.
    pub fn set_ack_sink(&self, sink: Box<dyn Fn(CodexInboundAck) + Send + Sync>) {
        write(&self.ack_sink, Some(Arc::from(sink)));
    }

    /// Whether a thread's sandbox is off (or unknown).
    pub fn set_is_unrestricted(&self, gate: impl Fn(&str) -> bool + Send + Sync + 'static) {
        write(&self.is_unrestricted, Arc::new(gate));
    }

    /// The user's pause: messages received while paused are refused, and
    /// nothing is delivered or approved.
    pub fn set_is_paused(&self, gate: impl Fn() -> bool + Send + Sync + 'static) {
        write(&self.is_paused, Arc::new(gate));
    }

    /// Transient authentication loss suspends receipt; it is never a durable
    /// refusal. Delivery and approval also wait until it returns.
    pub fn set_is_authorized(&self, gate: impl Fn() -> bool + Send + Sync + 'static) {
        write(&self.is_authorized, Arc::new(gate));
    }

    pub fn set_now(&self, clock: Clock) {
        write(&self.now, clock);
    }

    fn is_unrestricted(&self, thread_id: &str) -> bool {
        read(&self.is_unrestricted)(thread_id)
    }

    fn is_paused(&self) -> bool {
        read(&self.is_paused)()
    }

    fn is_authorized(&self) -> bool {
        read(&self.is_authorized)()
    }

    fn now(&self) -> SystemTime {
        read(&self.now)()
    }

    /// Whether delivery and approval may proceed: authorized and unpaused.
    pub fn can_deliver(&self) -> bool {
        self.is_authorized() && !self.is_paused()
    }

    fn serial(&self) -> std::sync::MutexGuard<'_, ()> {
        self.lock.lock().unwrap_or_else(|p| p.into_inner())
    }

    // MARK: Receiving

    /// Stores one message from the cloud, or its refusal, before returning;
    /// only then may the transport advance its cursor. Idempotent on the
    /// message id: a repeat re-acks the stored state. Fails, storing
    /// nothing, when not authorized or when the store fails — never with an
    /// invented refusal.
    pub fn receive_durably(&self, message: CodexInboundMessage) -> Result<()> {
        let now = self.now();
        self.receive_durably_at(message, now)
    }

    /// `receive_durably` as of `now`.
    pub fn receive_durably_at(&self, message: CodexInboundMessage, now: SystemTime) -> Result<()> {
        let _serial = self.serial();
        if !self.is_authorized() {
            return Err(OutboxError::AuthenticationRequired);
        }
        let store = self.delivery.store()?;
        if let Some(existing) = store.message(&message.id)? {
            store.reack(&existing.id)?;
            self.emit(&existing);
            return Ok(());
        }
        if let Some(retired) = store.retired_ack(&message.id)? {
            store.reack(&message.id)?;
            self.send_ack(retired);
            return Ok(());
        }
        let refusal = if !is_codex_thread_id(&message.thread_id) {
            Some("not a Codex thread UUID")
        } else if self.is_paused() {
            Some("incoming messages are paused")
        } else if store.enqueued_count(
            Some(&message.sender.id),
            Some(&message.thread_id),
            now - RATE_WINDOW,
        )? >= RATE_LIMIT
        {
            Some("rate limit reached for this sender and thread")
        } else {
            None
        };
        let decision = match refusal {
            None => self
                .policy
                .decide(&message.thread_id, self.is_unrestricted(&message.thread_id)),
            Some(_) => CodexSharingDecision::Deny,
        };
        let entry = NewMessage {
            id: message.id.clone(),
            thread_id: message.thread_id.clone(),
            text: format!(
                "{}\n\n{}",
                message_ref::attribution(Some(&message.sender.display_name), &message.id),
                message.text
            ),
            sender_id: Some(message.sender.id.clone()),
            sender_name: Some(message.sender.display_name.clone()),
        };
        let reason = refusal.or((decision == CodexSharingDecision::Deny)
            .then_some("thread is not shared for incoming messages"));
        if let Some(reason) = reason {
            store.record_rejected(&entry, reason, now)?;
        } else {
            let latest = message.created_at + DEFAULT_LIFETIME;
            let expiry = message
                .expires_at
                .unwrap_or(latest)
                .min(latest)
                .min(now + DEFAULT_LIFETIME);
            store.enqueue(&entry, decision == CodexSharingDecision::Hold, expiry, now)?;
            // Older messages this expires are acked too; the received one is
            // acked below either way.
            for expired in store.expire(now)? {
                if expired.id != message.id {
                    self.emit(&expired);
                }
            }
        }
        if let Some(current) = store.message(&message.id)? {
            self.emit(&current);
        }
        self.delivery.wake();
        Ok(())
    }

    /// Approves a held message. Returns whether one was waiting; always
    /// `false` while delivery is paused or unauthorized.
    pub fn approve(&self, id: &str) -> Result<bool> {
        let _serial = self.serial();
        if !self.can_deliver() {
            return Ok(false);
        }
        let approved = self.delivery.approve(id)?;
        if approved {
            if let Some(current) = self.delivery.message(id)? {
                self.emit(&current);
            }
        }
        Ok(approved)
    }

    /// Declines a held message. Returns whether one was waiting.
    pub fn reject(&self, id: &str, reason: Option<&str>) -> Result<bool> {
        self.delivery.reject(id, reason)
    }

    pub fn held_messages(&self) -> Result<Vec<CodexOutboxMessage>> {
        self.delivery.held_messages()
    }

    fn emit(&self, message: &CodexOutboxMessage) {
        self.send_ack(CodexInboundAck {
            id: message.id.clone(),
            status: message.state.codex_ack_status(),
            reply: message.reply.clone(),
            error: message.last_error.clone(),
            at: message.updated_at,
        });
    }

    fn send_ack(&self, ack: CodexInboundAck) {
        if let Some(sink) = read(&self.ack_sink) {
            sink(ack);
        }
    }
}

/// Receives Claude messages from the cloud into a `ClaudeDelivery`.
///
/// `delivered` is the last ack a successful message gets: Claude confirms
/// that it took the message, not how the session's turn went, so there is
/// no `completed` ack and never a `reply`.
pub struct ClaudeInbox {
    delivery: Arc<ClaudeDelivery>,
    policy: Arc<CodexSharingPolicy>,
    ack_sink: RwLock<Option<AckSink>>,
    is_unrestricted: RwLock<ThreadGate>,
    is_paused: RwLock<Gate>,
    /// Orders acks. Storing a message wakes the worker, which could
    /// otherwise report `delivered` before receipt sent `queued`.
    ack_lock: Mutex<()>,
    /// Serializes receipt, so the rate limit counts every message accepted
    /// before it.
    receipt: Mutex<()>,
}

impl ClaudeInbox {
    /// Wires `delivery` to `policy` through this inbox and turns every state
    /// change into an ack. This app cannot see a cloud session's permission
    /// mode, so until set every session counts as unrestricted: an `auto`
    /// share also needs `allows_unrestricted` to deliver without approval.
    pub fn new(delivery: Arc<ClaudeDelivery>, policy: Arc<CodexSharingPolicy>) -> Arc<Self> {
        Arc::new_cyclic(|inbox: &Weak<ClaudeInbox>| {
            let weak = inbox.clone();
            let decide_policy = policy.clone();
            delivery.set_authorize(move |session_id| {
                let unrestricted = weak
                    .upgrade()
                    .is_none_or(|inbox| inbox.is_unrestricted(session_id));
                decide_policy.decide(session_id, unrestricted)
            });
            let weak = inbox.clone();
            delivery.set_on_change(move |message| {
                // A pending state is a retry going back in line, which the
                // cloud already knows as queued. Every other transition is
                // news — including `held`, reported only when tightened
                // sharing pulled a queued message back for approval.
                if message.state == OutboxState::Pending {
                    return;
                }
                let Some(inbox) = weak.upgrade() else { return };
                let _acks = inbox.acks();
                inbox.send_ack_for(message);
            });
            ClaudeInbox {
                delivery: delivery.clone(),
                policy,
                ack_sink: RwLock::new(None),
                is_unrestricted: RwLock::new(Arc::new(|_| true)),
                is_paused: RwLock::new(Arc::new(|| false)),
                ack_lock: Mutex::new(()),
                receipt: Mutex::new(()),
            }
        })
    }

    pub fn set_ack_sink(&self, sink: Box<dyn Fn(CodexInboundAck) + Send + Sync>) {
        write(&self.ack_sink, Some(Arc::from(sink)));
    }

    pub fn set_is_unrestricted(&self, gate: impl Fn(&str) -> bool + Send + Sync + 'static) {
        write(&self.is_unrestricted, Arc::new(gate));
    }

    pub fn set_is_paused(&self, gate: impl Fn() -> bool + Send + Sync + 'static) {
        write(&self.is_paused, Arc::new(gate));
    }

    fn is_unrestricted(&self, session_id: &str) -> bool {
        read(&self.is_unrestricted)(session_id)
    }

    fn is_paused(&self) -> bool {
        read(&self.is_paused)()
    }

    fn acks(&self) -> std::sync::MutexGuard<'_, ()> {
        self.ack_lock.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Handles one message from the cloud. Idempotent on the id: a repeat
    /// re-acks the current state instead of queueing again. A store failure
    /// is acked as a rejection.
    pub fn receive(&self, message: ClaudeInboundMessage) {
        let now = self.delivery.now();
        self.receive_at(message, now);
    }

    /// `receive` as of `now`.
    pub fn receive_at(&self, message: ClaudeInboundMessage, now: SystemTime) {
        let _receipt = self.receipt.lock().unwrap_or_else(|p| p.into_inner());
        if self.try_receive(&message, now).is_err() {
            self.refuse(&message, "the desktop app could not store the message", now);
        }
    }

    fn try_receive(&self, message: &ClaudeInboundMessage, now: SystemTime) -> Result<()> {
        // Already known: re-ack its state (held and pending included, so a
        // lost first ack is recovered) instead of queueing again. Read and
        // acked under the ack lock, so a worker transition cannot land
        // between them and be followed by this older state.
        {
            let _acks = self.acks();
            if let Some(existing) = self.delivery.message(&message.id)? {
                self.send_ack_for(&existing);
                return Ok(());
            }
        }
        if !is_claude_session_id(&message.session_id) {
            self.refuse(message, "not a Claude session id", now);
            return Ok(());
        }
        if self.is_paused() {
            return self.refuse_for_now(message, "incoming messages are paused", now);
        }
        let recent = self.delivery.enqueued_count(
            Some(&message.sender.id),
            Some(&message.session_id),
            now - RATE_WINDOW,
        )?;
        if recent >= RATE_LIMIT {
            return self.refuse_for_now(
                message,
                "rate limit reached for this sender and session",
                now,
            );
        }
        match self.policy.decide(
            &message.session_id,
            self.is_unrestricted(&message.session_id),
        ) {
            CodexSharingDecision::Deny => {
                self.refuse_for_now(message, "session is not shared for incoming messages", now)
            }
            CodexSharingDecision::Hold => self.enqueue_and_ack(message, true, now),
            CodexSharingDecision::Deliver => self.enqueue_and_ack(message, false, now),
        }
    }

    /// Approves a held message. Returns whether one was waiting, and acks
    /// `queued` so the cloud stops showing "waiting for approval".
    pub fn approve(&self, id: &str) -> Result<bool> {
        // Under the ack lock so the worker's `delivered` cannot overtake
        // this `queued`, which is acked as itself rather than read back.
        let _acks = self.acks();
        let approved = self.delivery.approve(id)?;
        if approved {
            self.send_ack(CodexInboundAck::new(
                id,
                AckStatus::Queued,
                self.delivery.now(),
            ));
        }
        Ok(approved)
    }

    /// Declines a held message and acks it rejected.
    pub fn reject(&self, id: &str, reason: Option<&str>) -> Result<bool> {
        self.delivery.reject(id, reason)
    }

    pub fn held_messages(&self) -> Result<Vec<CodexOutboxMessage>> {
        self.delivery.held_messages()
    }

    /// Stores the message and sends its first ack as one step, so the
    /// worker's acks for it can only come after.
    fn enqueue_and_ack(
        &self,
        message: &ClaudeInboundMessage,
        held: bool,
        now: SystemTime,
    ) -> Result<()> {
        let _acks = self.acks();
        // The cloud's expiry only ever shortens the app's own maximum, which
        // runs from when the message was sent, as for Codex.
        let latest = message.created_at + DEFAULT_LIFETIME;
        let expiry = message
            .expires_at
            .unwrap_or(latest)
            .min(latest)
            .min(now + DEFAULT_LIFETIME);
        let lifetime = expiry.duration_since(now).unwrap_or(Duration::ZERO);
        self.delivery
            .enqueue(&self.entry(message), held, lifetime)?;
        let status = if held {
            AckStatus::HeldForApproval
        } else {
            AckStatus::Queued
        };
        self.send_ack(CodexInboundAck::new(message.id.clone(), status, now));
        Ok(())
    }

    /// Refuses for a reason that may not hold later, and records it so a
    /// repeat of the id after things change gets the same answer.
    fn refuse_for_now(
        &self,
        message: &ClaudeInboundMessage,
        reason: &str,
        now: SystemTime,
    ) -> Result<()> {
        self.delivery
            .record_rejected(&self.entry(message), reason)?;
        self.refuse(message, reason, now);
        Ok(())
    }

    /// Prepends who sent the message, so neither the user nor the model
    /// reads it as the user's own input.
    fn entry(&self, message: &ClaudeInboundMessage) -> NewMessage {
        NewMessage {
            id: message.id.clone(),
            thread_id: message.session_id.clone(),
            text: format!(
                "[via Agent Relay — from {}]\n\n{}",
                message_ref::single_line(&message.sender.display_name),
                message.text
            ),
            sender_id: Some(message.sender.id.clone()),
            sender_name: Some(message.sender.display_name.clone()),
        }
    }

    fn refuse(&self, message: &ClaudeInboundMessage, reason: &str, now: SystemTime) {
        let mut ack = CodexInboundAck::new(message.id.clone(), AckStatus::Rejected, now);
        ack.error = Some(reason.to_string());
        self.send_ack(ack);
    }

    /// The ack for a message's current state. A finished hand-off is stored
    /// `completed` but acked `delivered`; `sending` is not yet confirmed and
    /// may still fail, so it stays `queued`.
    fn send_ack_for(&self, message: &CodexOutboxMessage) {
        let status = match message.state {
            OutboxState::Held => AckStatus::HeldForApproval,
            OutboxState::Pending | OutboxState::Sending => AckStatus::Queued,
            OutboxState::Delivered | OutboxState::Completed => AckStatus::Delivered,
            OutboxState::Aborted => AckStatus::Aborted,
            OutboxState::Failed => AckStatus::Failed,
            OutboxState::Expired => AckStatus::Expired,
            OutboxState::Rejected => AckStatus::Rejected,
        };
        let mut ack = CodexInboundAck::new(message.id.clone(), status, self.delivery.now());
        ack.error = message.last_error.clone();
        self.send_ack(ack);
    }

    fn send_ack(&self, ack: CodexInboundAck) {
        if let Some(sink) = read(&self.ack_sink) {
            sink(ack);
        }
    }
}
