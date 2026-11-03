//! `CodexDelivery`: durable delivery of messages into Codex threads.
//!
//! `enqueue` commits a message and returns; the worker then delivers it when
//! the thread can take it, and keeps trying across restarts until it is
//! delivered, refused, or expired. Per thread, messages go in order, one
//! turn at a time. App-server and window hosts wait for the active turn to
//! finish. A live terminal may accept it into Codex's queue while busy.
//!
//! ```text
//! each pass:  expire ─▶ settle delivered (read Codex's reply)
//!                    ─▶ settle interrupted sends (did Codex record it?)
//!                    ─▶ hand the oldest due message to every open thread
//!                         app-server (loaded) ─▶ window socket (open) ─▶ codex queue (live TUI)
//! ```
//!
//! Passes run immediately on enqueue or approval, every 5 s while anything
//! is unfinished or held, and 30 s after a failed pass.

use super::effects::{
    compact, CodexAppServerError, CodexBridgeError, CodexDeliveryEffects, CodexQueueError,
    RolloutSummary, TurnOutcome, WindowSessionError,
};
use super::messages::{is_codex_thread_id, message_ref};
use super::sharing::CodexSharingDecision;
use super::store::{CodexOutbox, CodexOutboxMessage, NewMessage, OutboxState};
use super::worker::Worker;
use super::{Clock, OutboxError, Result, DEFAULT_LIFETIME};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, SystemTime};

/// How soon to look again while messages wait on Codex.
const RECHECK_INTERVAL: Duration = Duration::from_secs(5);
/// A send with no recorded outcome is left alone this long, so Codex has
/// time to write it to the session file before it counts as never landed.
const IN_DOUBT_GRACE: Duration = Duration::from_secs(30);
/// Codex takes a message off its queue a moment before the session file
/// records it. A handed-over message must be missing from both this long
/// before it counts as lost — re-sending inside that gap would run it twice.
const MISSING_GRACE: Duration = Duration::from_secs(45);
/// Stop waiting for the outcome of a delivered turn after this long.
const OUTCOME_WAIT: Duration = Duration::from_secs(12 * 60 * 60);
const MAX_ATTEMPTS: u32 = 3;
const FINISHED_RETENTION: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const WAITING_FOR_HOST: &str = "Waiting — session not running";

/// How messages get into Codex.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CodexRoute {
    /// Host-aware: managed app-server, the window socket, then Codex's queue
    /// only for a live terminal TUI.
    Queue,
    /// The Codex app's window socket only: app threads open in a window.
    WindowSocket,
}

impl CodexRoute {
    /// The name recorded with each send.
    pub fn as_str(self) -> &'static str {
        match self {
            CodexRoute::Queue => "queue",
            CodexRoute::WindowSocket => "windowSocket",
        }
    }
}

type Authorize = Arc<dyn Fn(&str) -> CodexSharingDecision + Send + Sync>;
type Gate = Arc<dyn Fn() -> bool + Send + Sync>;
type OnChange = Arc<dyn Fn(&CodexOutboxMessage) + Send + Sync>;

/// The Codex delivery worker over one outbox file.
pub struct CodexDelivery {
    store_path: PathBuf,
    store: Mutex<Option<Arc<CodexOutbox>>>,
    effects: Arc<dyn CodexDeliveryEffects>,
    clock: Clock,
    authorize: RwLock<Authorize>,
    is_paused: RwLock<Gate>,
    on_change: RwLock<Option<OnChange>>,
    route: RwLock<CodexRoute>,
    /// When each handed-over message was first seen neither in Codex's
    /// queue nor in the session file.
    missing_since: Mutex<HashMap<String, SystemTime>>,
    pass: Mutex<()>,
    worker: Worker,
}

impl CodexDelivery {
    /// A delivery over the outbox at `store_path` (opened journaled on first
    /// use). Until an inbox wires them, every thread is denied and delivery
    /// is paused.
    pub fn new(
        store_path: impl AsRef<Path>,
        effects: Arc<dyn CodexDeliveryEffects>,
        clock: Clock,
    ) -> Arc<Self> {
        Arc::new(CodexDelivery {
            store_path: store_path.as_ref().to_path_buf(),
            store: Mutex::new(None),
            effects,
            clock,
            authorize: RwLock::new(Arc::new(|_| CodexSharingDecision::Deny)),
            is_paused: RwLock::new(Arc::new(|| true)),
            on_change: RwLock::new(None),
            route: RwLock::new(CodexRoute::Queue),
            missing_since: Mutex::new(HashMap::new()),
            pass: Mutex::new(()),
            worker: Worker::default(),
        })
    }

    // MARK: Wiring

    /// Re-checked for every message just before it is sent, so a thread
    /// unshared (or a policy reset by a restart) after queueing cannot still
    /// deliver. A denial fails the message closed.
    pub fn set_authorize(
        &self,
        authorize: impl Fn(&str) -> CodexSharingDecision + Send + Sync + 'static,
    ) {
        *self.authorize.write().unwrap_or_else(|p| p.into_inner()) = Arc::new(authorize);
    }

    pub fn set_is_paused(&self, is_paused: impl Fn() -> bool + Send + Sync + 'static) {
        *self.is_paused.write().unwrap_or_else(|p| p.into_inner()) = Arc::new(is_paused);
    }

    /// Called whenever a message changes state, on the pass's thread.
    pub fn set_on_change(&self, on_change: impl Fn(&CodexOutboxMessage) + Send + Sync + 'static) {
        *self.on_change.write().unwrap_or_else(|p| p.into_inner()) = Some(Arc::new(on_change));
    }

    pub fn set_route(&self, route: CodexRoute) {
        *self.route.write().unwrap_or_else(|p| p.into_inner()) = route;
    }

    pub fn route(&self) -> CodexRoute {
        *self.route.read().unwrap_or_else(|p| p.into_inner())
    }

    pub fn is_paused(&self) -> bool {
        let gate = self
            .is_paused
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        gate()
    }

    fn authorize(&self, thread_id: &str) -> CodexSharingDecision {
        let authorize = self
            .authorize
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        authorize(thread_id)
    }

    pub fn now(&self) -> SystemTime {
        (self.clock)()
    }

    // MARK: API

    /// Starts the worker, picking up whatever an earlier run left
    /// unfinished. Call once at launch; later calls ask for a pass now.
    pub fn start(self: &Arc<Self>) {
        self.worker
            .start("codex-delivery", Arc::downgrade(self), |delivery: &Self| {
                let _ = delivery.run_pass();
            });
    }

    /// Stops the worker for good, waiting for a pass in progress.
    pub fn stop(&self) {
        self.worker.stop();
    }

    /// Asks the worker for a pass now, if it is running.
    pub fn wake(&self) {
        self.worker.schedule(Duration::ZERO);
    }

    /// The outbox, opened (journaled) on first use.
    pub fn store(&self) -> Result<Arc<CodexOutbox>> {
        let mut store = self.store.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(store) = store.as_ref() {
            return Ok(store.clone());
        }
        let opened = Arc::new(CodexOutbox::open_journaled(&self.store_path)?);
        *store = Some(opened.clone());
        Ok(opened)
    }

    /// Durably queues a message. Enqueueing the same id again does nothing
    /// and returns `false`, so a sender may safely repeat itself. A `held`
    /// message waits for `approve`.
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

    /// Declines a held message; it never goes to Codex. Returns whether one
    /// was waiting.
    pub fn reject(&self, id: &str, reason: Option<&str>) -> Result<bool> {
        let store = self.store()?;
        let rejected = store.reject(id, reason, self.now())?;
        if rejected {
            if let Some(message) = store.message(id)? {
                self.notify(&message);
            }
            // A rejected head frees the next message in its thread.
            self.wake();
        }
        Ok(rejected)
    }

    /// Messages awaiting the local user's approval.
    pub fn held_messages(&self) -> Result<Vec<CodexOutboxMessage>> {
        self.store()?.messages_in(OutboxState::Held)
    }

    /// How many messages were queued since `since`, for rate limiting.
    pub fn enqueued_count(
        &self,
        sender_id: Option<&str>,
        thread_id: Option<&str>,
        since: SystemTime,
    ) -> Result<usize> {
        self.store()?.enqueued_count(sender_id, thread_id, since)
    }

    pub fn message(&self, id: &str) -> Result<Option<CodexOutboxMessage>> {
        self.store()?.message(id)
    }

    // MARK: The pass

    /// Runs one pass now and schedules the next.
    pub fn run_pass(&self) -> Result<()> {
        let _pass = self.pass.lock().unwrap_or_else(|p| p.into_inner());
        match self.pass_once() {
            Ok(more) => {
                // Held messages wait on the user, not the worker, but they
                // still expire, so passes continue while any remain.
                if more {
                    self.worker.schedule(RECHECK_INTERVAL);
                }
                Ok(())
            }
            Err(error) => {
                self.worker.schedule(RECHECK_INTERVAL * 6);
                Err(error)
            }
        }
    }

    fn pass_once(&self) -> Result<bool> {
        let store = self.store()?;
        let mut rollouts = RolloutCache::default();
        for message in store.expire(self.now())? {
            self.notify(&message);
        }
        self.settle_delivered(&store, &mut rollouts)?;
        self.settle_interrupted_sends(&store, &mut rollouts)?;
        self.deliver(&store, &mut rollouts)?;
        store.prune(self.now() - FINISHED_RETENTION)?;
        Ok(store.has_unfinished_messages()? || store.has_held_messages()?)
    }

    /// Reads how the turn of each delivered message ended.
    fn settle_delivered(&self, store: &CodexOutbox, rollouts: &mut RolloutCache) -> Result<()> {
        for message in store.messages_in(OutboxState::Delivered)? {
            let rollout = rollouts.summary(&*self.effects, &message.thread_id);
            let turn = message.turn_id.clone().or_else(|| {
                rollout.and_then(|summary| summary.turn_for(&message.id).map(str::to_string))
            });
            let outcome = turn
                .and_then(|turn| rollout.and_then(|summary| summary.outcomes.get(&turn).cloned()));
            match outcome {
                Some(TurnOutcome::Completed { reply }) => {
                    self.finish(
                        store,
                        &message,
                        OutboxState::Completed,
                        reply.as_deref(),
                        None,
                    )?;
                }
                Some(TurnOutcome::Aborted { reason }) => {
                    let error = format!("the turn was {}", reason.as_deref().unwrap_or("aborted"));
                    self.finish(store, &message, OutboxState::Aborted, None, Some(&error))?;
                }
                None => {
                    // No recorded outcome after the wait: failed, never
                    // completed — the cloud must not hear that Codex
                    // answered when no reply was captured.
                    if message.updated_at + OUTCOME_WAIT < self.now() {
                        self.finish(
                            store,
                            &message,
                            OutboxState::Failed,
                            None,
                            Some("no turn outcome was recorded within the wait window"),
                        )?;
                    }
                }
            }
        }
        Ok(())
    }

    /// A message still `sending` was interrupted mid-send (a timeout, or the
    /// app quit). Codex records the id it was sent with, so the session
    /// file says whether it landed.
    fn settle_interrupted_sends(
        &self,
        store: &CodexOutbox,
        rollouts: &mut RolloutCache,
    ) -> Result<()> {
        for message in store.messages_in(OutboxState::Sending)? {
            // Recorded: the turn has started. For the queue route this is
            // the normal way a message becomes delivered.
            if let Some(turn) = rollouts
                .summary(&*self.effects, &message.thread_id)
                .and_then(|summary| summary.turn_for(&message.id))
            {
                store.mark_delivered(&message.id, Some(turn), self.now())?;
                self.notify_stored(store, &message.id)?;
                continue;
            }
            if message.route.as_deref() == Some(CodexRoute::Queue.as_str())
                && self.withdraw_if_unauthorized(store, &message)?
            {
                continue;
            }
            if message
                .last_attempt_at
                .is_some_and(|last| last + IN_DOUBT_GRACE > self.now())
            {
                continue;
            }
            // Absence is evidence only when the rollout could be read; a
            // permissions or I/O failure never becomes a resend.
            if !self.effects.rollout_readable(&message.thread_id) {
                if message.expires_at <= self.now() {
                    self.finish(
                        store,
                        &message,
                        OutboxState::Failed,
                        None,
                        Some("the message outcome could not be read before it expired"),
                    )?;
                }
                continue;
            }
            // Settled by the route this send took, not the one available
            // now: a message in Codex's queue can sit there long after the
            // `codex` that put it there is gone, and must not be sent again
            // through the socket while Codex's copy can still run.
            if message.route.as_deref() != Some(CodexRoute::Queue.as_str()) {
                // Window socket: Codex records the send at once, so an
                // unrecorded one after the grace never landed.
                self.retry_or_fail(store, &message, "the send was interrupted")?;
                continue;
            }
            // Still in Codex's queue means handed over and waiting; an
            // unreadable queue counts as waiting, since re-sending on doubt
            // could run the message twice.
            let waiting = self
                .effects
                .queue_waiting(&message.thread_id, &message_ref::for_message(&message.id))
                .unwrap_or(true);
            let mut missing = self.missing_since.lock().unwrap_or_else(|p| p.into_inner());
            if waiting {
                missing.remove(&message.id);
            }
            if message.expires_at < self.now() {
                missing.remove(&message.id);
                drop(missing);
                let error = if waiting {
                    // Codex's copy could still run once the thread is idle.
                    self.effects
                        .queue_cleanup(&message.thread_id, &message_ref::for_message(&message.id));
                    "Codex never picked the message up before it expired; its queued copy was withdrawn"
                } else {
                    "the message's outcome in Codex could not be determined before it expired"
                };
                self.finish(store, &message, OutboxState::Failed, None, Some(error))?;
                continue;
            }
            if waiting {
                continue;
            }
            // In neither place — also what the moment between Codex
            // dequeuing it and recording it looks like, so wait that out.
            let first_missing = *missing
                .entry(message.id.clone())
                .or_insert_with(|| self.now());
            if first_missing + MISSING_GRACE > self.now() {
                continue;
            }
            missing.remove(&message.id);
            drop(missing);
            self.retry_or_fail(store, &message, "the message did not reach Codex's queue")?;
        }
        // Forget messages that are no longer `sending`.
        let sending: HashSet<String> = store
            .messages_in(OutboxState::Sending)?
            .into_iter()
            .map(|message| message.id)
            .collect();
        self.missing_since
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .retain(|id, _| sending.contains(id));
        Ok(())
    }

    fn deliver(&self, store: &CodexOutbox, rollouts: &mut RolloutCache) -> Result<()> {
        if self.is_paused() {
            return Ok(());
        }
        let route = self.route();
        let mut ready = Vec::new();
        for message in store.deliverable_heads(self.now())? {
            // A pending message can already be in Codex after an interrupted
            // handoff. A recorded turn wins over another send.
            let summary = rollouts.summary(&*self.effects, &message.thread_id);
            compact::recover_from(summary, &message.thread_id, &message.id);
            if let Some(turn) = summary.and_then(|summary| summary.turn_for(&message.id)) {
                store.mark_delivered(&message.id, Some(turn), self.now())?;
                self.notify_stored(store, &message.id)?;
            } else if (self.effects.idle(&message.thread_id) || route == CodexRoute::Queue)
                && self
                    .effects
                    .queue_waiting(&message.thread_id, &message_ref::for_message(&message.id))
                    != Some(true)
            {
                ready.push(message);
            }
        }
        if ready.is_empty() {
            return Ok(());
        }

        let loaded = if route == CodexRoute::Queue {
            self.effects.app_server_loaded()
        } else {
            HashSet::new()
        };
        let host_route = Some(CodexRoute::WindowSocket.as_str());
        let mut remaining = Vec::new();
        for message in ready {
            if !loaded.contains(&message.thread_id) {
                remaining.push(message);
                continue;
            }
            // A loaded host must wait here, not fall through to another
            // route that could inject into its current turn.
            if !self.may_start_host_turn(store, &message)? {
                continue;
            }
            store.mark_sending(&message.id, host_route, self.now())?;
            match self
                .effects
                .app_server_send(&message.thread_id, &message.text, &message.id)
            {
                Ok(true) => {
                    store.mark_delivered(&message.id, None, self.now())?;
                    self.notify_stored(store, &message.id)?;
                    self.effects
                        .queue_cleanup(&message.thread_id, &message_ref::for_message(&message.id));
                }
                Ok(false) => {
                    store.mark_unsent(
                        &message.id,
                        Some(WAITING_FOR_HOST),
                        self.now() + RECHECK_INTERVAL,
                        self.now(),
                    )?;
                }
                Err(CodexAppServerError::Refused(reason)) => {
                    self.retry_or_fail(store, &message, &reason)?;
                }
                // Left `sending` for rollout reconciliation; the pass ends.
                Err(CodexAppServerError::InDoubt(reason)) => {
                    return Err(OutboxError::Effect(reason))
                }
            }
        }
        if remaining.is_empty() {
            return Ok(());
        }

        let mut owners: HashMap<String, String> = HashMap::new();
        let session = self.effects.with_window_session(&mut |session| {
            let thread_ids: Vec<String> = remaining
                .iter()
                .map(|message| message.thread_id.clone())
                .collect();
            owners = session.owners(&thread_ids)?;
            for message in &remaining {
                let Some(owner) = owners.get(&message.thread_id) else {
                    continue;
                };
                // Re-checked at delivery time: the thread may have been
                // unshared, or the policy reset, after queueing.
                // Re-check after owner discovery, before attempting a turn.
                // Keep the owner in `owners` so a busy window never falls
                // through to the terminal queue below.
                if !self.may_start_host_turn(store, message)? {
                    continue;
                }
                store.mark_sending(&message.id, host_route, self.now())?;
                match session.start_turn(&message.thread_id, &message.text, &message.id, owner) {
                    Ok(turn) => {
                        store.mark_delivered(&message.id, turn.as_deref(), self.now())?;
                        self.notify_stored(store, &message.id)?;
                    }
                    Err(CodexBridgeError::Rejected(reason)) => {
                        self.retry_or_fail(store, message, &reason)?;
                    }
                    // Any other failure leaves the message `sending`, to be
                    // settled against the session file on a later pass.
                    Err(error) => return Err(error.into()),
                }
            }
            Ok(())
        });
        match session {
            // Codex not running keeps everything queued until it is back;
            // other bridge failures end the window route for this pass.
            Ok(()) | Err(WindowSessionError::Bridge(_)) => {}
            Err(WindowSessionError::Store(error)) => return Err(error),
        }
        // Only a live terminal TUI drains `codex queue`. App-server threads
        // and stopped threads remain pending in this outbox.
        if route == CodexRoute::Queue && self.effects.queue_available() {
            let through_queue: Vec<_> = remaining
                .into_iter()
                .filter(|message| {
                    !owners.contains_key(&message.thread_id)
                        && self.effects.terminal_live(&message.thread_id)
                })
                .collect();
            self.deliver_through_queue(store, through_queue)?;
        }
        Ok(())
    }

    /// Hands each ready message to Codex's queue. It stays `sending` —
    /// acked as queued — until the session file shows its turn started.
    fn deliver_through_queue(
        &self,
        store: &CodexOutbox,
        ready: Vec<CodexOutboxMessage>,
    ) -> Result<()> {
        for message in ready {
            if !self.may_deliver(store, &message)? {
                continue;
            }
            store.mark_sending(&message.id, Some(CodexRoute::Queue.as_str()), self.now())?;
            // The reference finds the turn again; an injected message goes as its line.
            let text = message_ref::ensuring(&message.text, &message.id);
            let text = compact::after_injection(&message.thread_id, &message.id, &text);
            match self.effects.queue_send(&message.thread_id, &text) {
                Ok(()) => {}
                Err(CodexQueueError::Failed(reason)) => {
                    self.retry_or_fail(store, &message, &reason)?
                }
                Err(error @ CodexQueueError::CodexNotInstalled) => {
                    store.mark_unsent(
                        &message.id,
                        Some(&error.to_string()),
                        self.now() + RECHECK_INTERVAL * 12,
                        self.now(),
                    )?;
                }
                // Left `sending`: the queue and session file say what happened.
                Err(CodexQueueError::TimedOut) => {}
            }
        }
        Ok(())
    }

    /// A message handed to Codex's queue waits there until the thread is
    /// idle, so sharing revoked or tightened in the meantime takes it back:
    /// denied, it is withdrawn and rejected; held for approval it did not
    /// have, it is withdrawn and held. Returns whether it was withdrawn. A
    /// copy Codex dequeued just before the withdrawal still runs, and its
    /// recorded turn is what settles a held message later.
    fn withdraw_if_unauthorized(
        &self,
        store: &CodexOutbox,
        message: &CodexOutboxMessage,
    ) -> Result<bool> {
        let decision = self.authorize(&message.thread_id);
        let hold = decision == CodexSharingDecision::Hold && message.approved_at.is_none();
        if decision != CodexSharingDecision::Deny && !hold {
            return Ok(false);
        }
        self.effects
            .queue_cleanup(&message.thread_id, &message_ref::for_message(&message.id));
        self.missing_since
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&message.id);
        if hold {
            store.mark_pending(&message.id, None, self.now(), self.now())?;
            store.hold(&message.id, self.now())?;
            self.notify_stored(store, &message.id)?;
        } else {
            self.finish(
                store,
                message,
                OutboxState::Rejected,
                None,
                Some("thread is no longer shared for incoming messages"),
            )?;
        }
        Ok(true)
    }

    /// Starting a host turn requires both an idle thread and current permission.
    /// Busy messages remain untouched, including their attempt count.
    fn may_start_host_turn(
        &self,
        store: &CodexOutbox,
        message: &CodexOutboxMessage,
    ) -> Result<bool> {
        Ok(self.effects.idle(&message.thread_id) && self.may_deliver(store, message)?)
    }

    fn may_deliver(&self, store: &CodexOutbox, message: &CodexOutboxMessage) -> Result<bool> {
        if self.is_paused() {
            return Ok(false);
        }
        if message.expires_at <= self.now() {
            self.finish(
                store,
                message,
                OutboxState::Expired,
                None,
                Some("expired before delivery"),
            )?;
            return Ok(false);
        }
        if !is_codex_thread_id(&message.thread_id) {
            self.finish(
                store,
                message,
                OutboxState::Rejected,
                None,
                Some("not a Codex thread UUID"),
            )?;
            return Ok(false);
        }
        match self.authorize(&message.thread_id) {
            CodexSharingDecision::Deny => {
                self.finish(
                    store,
                    message,
                    OutboxState::Rejected,
                    None,
                    Some("thread is no longer shared for incoming messages"),
                )?;
                Ok(false)
            }
            CodexSharingDecision::Hold if message.approved_at.is_none() => {
                if store.hold(&message.id, self.now())? {
                    self.notify_stored(store, &message.id)?;
                }
                Ok(false)
            }
            CodexSharingDecision::Hold | CodexSharingDecision::Deliver => Ok(true),
        }
    }

    fn retry_or_fail(
        &self,
        store: &CodexOutbox,
        message: &CodexOutboxMessage,
        error: &str,
    ) -> Result<()> {
        // `message` may predate this attempt being counted: ask the store.
        let attempts = store
            .message(&message.id)?
            .map_or(message.attempts, |stored| stored.attempts);
        if message.expires_at <= self.now() || attempts >= MAX_ATTEMPTS {
            self.finish(store, message, OutboxState::Failed, None, Some(error))
        } else {
            let backoff = RECHECK_INTERVAL * 2u32.pow(attempts);
            store.mark_pending(&message.id, Some(error), self.now() + backoff, self.now())?;
            self.notify_stored(store, &message.id)
        }
    }

    fn finish(
        &self,
        store: &CodexOutbox,
        message: &CodexOutboxMessage,
        state: OutboxState,
        reply: Option<&str>,
        error: Option<&str>,
    ) -> Result<()> {
        store.mark_finished(&message.id, state, reply, error, self.now())?;
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

impl Drop for CodexDelivery {
    fn drop(&mut self) {
        self.worker.release();
    }
}

/// Session files read during one pass, so each is read once.
#[derive(Default)]
struct RolloutCache {
    summaries: HashMap<String, Option<RolloutSummary>>,
}

impl RolloutCache {
    fn summary(
        &mut self,
        effects: &dyn CodexDeliveryEffects,
        thread_id: &str,
    ) -> Option<&RolloutSummary> {
        self.summaries
            .entry(thread_id.to_string())
            .or_insert_with(|| effects.rollout(thread_id))
            .as_ref()
    }
}
