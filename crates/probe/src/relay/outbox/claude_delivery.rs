//! `ClaudeDelivery`: durable delivery of messages into Claude cloud
//! sessions, on the same outbox store (its own file; `thread_id` holds the
//! Claude session id).
//!
//! Claude confirms the hand-off of a message and nothing later, so a
//! confirmed message is finished — `completed`, with no reply. For the same
//! reason a send cut short cannot be checked afterwards: it is failed rather
//! than re-sent, because a teammate's prompt running twice is worse than it
//! not running. Delivery is at most once.
//!
//! ```text
//! each pass:  expire ─▶ finish confirmed sends ─▶ fail interrupted sends
//!                    ─▶ send the oldest due message of every session
//! ```
//!
//! Passes run immediately on enqueue or approval, straight away again after
//! a pass that finished a message (freeing the next in its line), every 5 s
//! while anything is unfinished or held, and 30 s after a failed pass.

use super::effects::{ClaudeBridgeError, ClaudeDeliveryEffects};
use super::messages::is_claude_session_id;
use super::sharing::CodexSharingDecision;
use super::store::{CodexOutbox, CodexOutboxMessage, NewMessage, OutboxState};
use super::worker::Worker;
use super::{Clock, Result, DEFAULT_LIFETIME};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, SystemTime};

const RECHECK_INTERVAL: Duration = Duration::from_secs(5);
/// How long one `claude --print --cloud` send may take before it is stopped.
pub const CLAUDE_SEND_TIMEOUT: Duration = Duration::from_secs(60);
/// A `sending` message is left alone this long before it counts as
/// interrupted, so a pass never fails a send still in flight.
const IN_DOUBT_GRACE: Duration = Duration::from_secs(CLAUDE_SEND_TIMEOUT.as_secs() + 30);
const MAX_ATTEMPTS: u32 = 3;
const FINISHED_RETENTION: Duration = Duration::from_secs(7 * 24 * 60 * 60);

type Authorize = Arc<dyn Fn(&str) -> CodexSharingDecision + Send + Sync>;
type OnChange = Arc<dyn Fn(&CodexOutboxMessage) + Send + Sync>;

/// The Claude delivery worker over one outbox file.
pub struct ClaudeDelivery {
    store_path: PathBuf,
    store: Mutex<Option<Arc<CodexOutbox>>>,
    effects: Arc<dyn ClaudeDeliveryEffects>,
    clock: Clock,
    authorize: RwLock<Authorize>,
    on_change: RwLock<Option<OnChange>>,
    pass: Mutex<()>,
    worker: Worker,
}

impl ClaudeDelivery {
    /// A delivery over the outbox at `store_path`. Until an inbox wires the
    /// sharing policy, delivery is authorized.
    pub fn new(
        store_path: impl AsRef<Path>,
        effects: Arc<dyn ClaudeDeliveryEffects>,
        clock: Clock,
    ) -> Arc<Self> {
        Arc::new(ClaudeDelivery {
            store_path: store_path.as_ref().to_path_buf(),
            store: Mutex::new(None),
            effects,
            clock,
            authorize: RwLock::new(Arc::new(|_| CodexSharingDecision::Deliver)),
            on_change: RwLock::new(None),
            pass: Mutex::new(()),
            worker: Worker::default(),
        })
    }

    // MARK: Wiring

    /// Re-checked for every message just before it is sent: `Deny` fails it
    /// closed, and `Hold` takes it back out of line to wait for the local
    /// user — unless they already approved this very message.
    pub fn set_authorize(
        &self,
        authorize: impl Fn(&str) -> CodexSharingDecision + Send + Sync + 'static,
    ) {
        *self.authorize.write().unwrap_or_else(|p| p.into_inner()) = Arc::new(authorize);
    }

    /// Called whenever a message changes state, on the pass's thread.
    pub fn set_on_change(&self, on_change: impl Fn(&CodexOutboxMessage) + Send + Sync + 'static) {
        *self.on_change.write().unwrap_or_else(|p| p.into_inner()) = Some(Arc::new(on_change));
    }

    fn authorize(&self, session_id: &str) -> CodexSharingDecision {
        let authorize = self
            .authorize
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        authorize(session_id)
    }

    pub fn now(&self) -> SystemTime {
        (self.clock)()
    }

    // MARK: API

    /// Starts the worker, picking up whatever an earlier run left
    /// unfinished. Later calls ask for a pass now.
    pub fn start(self: &Arc<Self>) {
        self.worker.start(
            "claude-delivery",
            Arc::downgrade(self),
            |delivery: &Self| {
                let _ = delivery.run_pass();
            },
        );
    }

    /// Stops the worker for good, waiting for a pass in progress.
    pub fn stop(&self) {
        self.worker.stop();
    }

    /// Asks the worker for a pass now, if it is running.
    pub fn wake(&self) {
        self.worker.schedule(Duration::ZERO);
    }

    /// The outbox, opened on first use.
    pub fn store(&self) -> Result<Arc<CodexOutbox>> {
        let mut store = self.store.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(store) = store.as_ref() {
            return Ok(store.clone());
        }
        let opened = Arc::new(CodexOutbox::open(&self.store_path)?);
        *store = Some(opened.clone());
        Ok(opened)
    }

    /// Durably queues a message for a Claude session (`thread_id` is the
    /// session id). A repeat id does nothing and returns `false`.
    pub fn enqueue(&self, message: &NewMessage, held: bool, lifetime: Duration) -> Result<bool> {
        let now = self.now();
        let is_new = self.store()?.enqueue(message, held, now + lifetime, now)?;
        if is_new {
            self.wake();
        }
        Ok(is_new)
    }

    /// `enqueue` with the default 24 h lifetime.
    pub fn enqueue_default(&self, message: &NewMessage, held: bool) -> Result<bool> {
        self.enqueue(message, held, DEFAULT_LIFETIME)
    }

    /// Approves a held message. Returns whether one was waiting.
    pub fn approve(&self, id: &str) -> Result<bool> {
        let approved = self.store()?.approve(id, self.now())?;
        if approved {
            self.wake();
        }
        Ok(approved)
    }

    /// Records a message refused on arrival, so a repeat of its id gets the
    /// same answer. Returns `false` when the id is already stored.
    pub fn record_rejected(&self, message: &NewMessage, reason: &str) -> Result<bool> {
        self.store()?.record_rejected(message, reason, self.now())
    }

    /// Declines a held message; it never goes to Claude. Returns whether one
    /// was waiting.
    pub fn reject(&self, id: &str, reason: Option<&str>) -> Result<bool> {
        let store = self.store()?;
        let rejected = store.reject(id, reason, self.now())?;
        if rejected {
            if let Some(message) = store.message(id)? {
                self.notify(&message);
            }
            // A rejected head frees the next message in its session.
            self.wake();
        }
        Ok(rejected)
    }

    pub fn held_messages(&self) -> Result<Vec<CodexOutboxMessage>> {
        self.store()?.messages_in(OutboxState::Held)
    }

    pub fn enqueued_count(
        &self,
        sender_id: Option<&str>,
        session_id: Option<&str>,
        since: SystemTime,
    ) -> Result<usize> {
        self.store()?.enqueued_count(sender_id, session_id, since)
    }

    pub fn message(&self, id: &str) -> Result<Option<CodexOutboxMessage>> {
        self.store()?.message(id)
    }

    // MARK: The pass

    /// Runs one pass now and schedules the next.
    pub fn run_pass(&self) -> Result<()> {
        let _pass = self.pass.lock().unwrap_or_else(|p| p.into_inner());
        match self.pass_once() {
            Ok((more, finished_any)) => {
                if more {
                    self.worker.schedule(if finished_any {
                        Duration::ZERO
                    } else {
                        RECHECK_INTERVAL
                    });
                }
                Ok(())
            }
            Err(error) => {
                self.worker.schedule(RECHECK_INTERVAL * 6);
                Err(error)
            }
        }
    }

    fn pass_once(&self) -> Result<(bool, bool)> {
        let store = self.store()?;
        for message in store.expire(self.now())? {
            self.notify(&message);
        }
        // Confirmed by Claude just before the app stopped, ahead of being
        // marked finished.
        for message in store.messages_in(OutboxState::Delivered)? {
            self.finish(&store, &message, OutboxState::Completed, None)?;
        }
        // Interrupted mid-send: Claude keeps no record this app can check.
        for message in store.messages_in(OutboxState::Sending)? {
            if message
                .last_attempt_at
                .is_some_and(|last| last + IN_DOUBT_GRACE > self.now())
            {
                continue;
            }
            self.finish(
                &store,
                &message,
                OutboxState::Failed,
                Some("the send was interrupted; it may or may not have reached the session"),
            )?;
        }
        let finished_any = self.deliver(&store)?;
        store.prune(self.now() - FINISHED_RETENTION)?;
        Ok((
            store.has_unfinished_messages()? || store.has_held_messages()?,
            finished_any,
        ))
    }

    /// Sends the oldest due message of every session. Returns whether any
    /// reached a final state, which frees the next one in its line.
    fn deliver(&self, store: &CodexOutbox) -> Result<bool> {
        let ready = store.deliverable_heads(self.now())?;
        // Everything stays queued, attempts unspent, until Claude is there.
        if ready.is_empty() || !self.effects.is_available() {
            return Ok(false);
        }
        for message in &ready {
            // A stored id that is not a session id is refused, never passed
            // to a command line.
            if !is_claude_session_id(&message.thread_id) {
                self.finish(
                    store,
                    message,
                    OutboxState::Rejected,
                    Some("not a Claude session id"),
                )?;
                continue;
            }
            match self.authorize(&message.thread_id) {
                CodexSharingDecision::Deny => {
                    self.finish(
                        store,
                        message,
                        OutboxState::Rejected,
                        Some("session is no longer shared for incoming messages"),
                    )?;
                    continue;
                }
                CodexSharingDecision::Hold if message.approved_at.is_none() => {
                    if store.hold(&message.id, self.now())? {
                        self.notify_stored(store, &message.id)?;
                    }
                    continue;
                }
                CodexSharingDecision::Hold | CodexSharingDecision::Deliver => {}
            }
            store.mark_sending(&message.id, None, self.now())?;
            match self.effects.send(&message.thread_id, &message.text) {
                Ok(()) => {
                    store.mark_delivered(&message.id, None, self.now())?;
                    self.finish(store, message, OutboxState::Completed, None)?;
                }
                // Nothing went out: queue it again.
                Err(error @ ClaudeBridgeError::ClaudeNotInstalled) => {
                    store.mark_unsent(
                        &message.id,
                        Some(&error.to_string()),
                        self.now() + RECHECK_INTERVAL * 12,
                        self.now(),
                    )?;
                }
                Err(ClaudeBridgeError::Refused(reason)) => {
                    self.finish(store, message, OutboxState::Failed, Some(&reason))?;
                }
                Err(ClaudeBridgeError::Failed(reason)) => self.retry_or_fail(store, message, &reason)?,
                // In doubt: the message may have landed before the stop.
                Err(ClaudeBridgeError::TimedOut) => self.finish(
                    store,
                    message,
                    OutboxState::Failed,
                    Some("claude did not answer in time; the message may or may not have reached the session"),
                )?,
            }
        }
        for message in &ready {
            if store
                .message(&message.id)?
                .is_none_or(|stored| stored.state.is_final())
            {
                return Ok(true);
            }
        }
        Ok(false)
    }

    fn retry_or_fail(
        &self,
        store: &CodexOutbox,
        message: &CodexOutboxMessage,
        error: &str,
    ) -> Result<()> {
        // `message` predates this attempt being counted: ask the store.
        let attempts = store
            .message(&message.id)?
            .map_or(message.attempts, |stored| stored.attempts);
        if attempts >= MAX_ATTEMPTS {
            self.finish(store, message, OutboxState::Failed, Some(error))
        } else {
            let backoff = RECHECK_INTERVAL * 2u32.pow(attempts);
            store.mark_pending(&message.id, Some(error), self.now() + backoff, self.now())
        }
    }

    fn finish(
        &self,
        store: &CodexOutbox,
        message: &CodexOutboxMessage,
        state: OutboxState,
        error: Option<&str>,
    ) -> Result<()> {
        store.mark_finished(&message.id, state, None, error, self.now())?;
        self.notify_stored(store, &message.id)
    }

    fn notify_stored(&self, store: &CodexOutbox, id: &str) -> Result<()> {
        if let Some(message) = store.message(id)? {
            self.notify(&message);
        }
        Ok(())
    }

    fn notify(&self, message: &CodexOutboxMessage) {
        let on_change = self
            .on_change
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        if let Some(on_change) = on_change {
            on_change(message);
        }
    }
}

impl Drop for ClaudeDelivery {
    fn drop(&mut self) {
        self.worker.release();
    }
}
