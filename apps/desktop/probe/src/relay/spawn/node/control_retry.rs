//! The gateway's `d1_pressure` means no mutation was admitted. Only that
//! explicit correlated refusal permits repeating an agent.register request;
//! a timeout or disconnect may have committed and is never replayed here.
//! One-way action results need an id so a refusal can be correlated as
//! well: `Results` keeps each until Relaycast took it.

use super::{wire, NodeLink};
use crate::relay::push::{backoff, random_jitter};
use crate::relay::store::random_uuid;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::MutexGuard;
use std::time::{Duration, Instant};
use tokio::sync::oneshot;

#[derive(Clone, Copy)]
struct Policy {
    initial: Duration,
    max_delay: Duration,
    retries: u32,
    budget: Duration,
}

impl Policy {
    const DEFAULT: Self = Self {
        initial: Duration::from_secs(1),
        max_delay: Duration::from_secs(8),
        retries: 5,
        budget: Duration::from_secs(25),
    };

    fn delay(self, attempt: u32, started: Instant, now: Instant) -> Option<Duration> {
        let delay = (self.initial * (1u32 << attempt.min(3))).min(self.max_delay);
        (attempt < self.retries && now.checked_add(delay)? <= started + self.budget)
            .then_some(delay)
    }
}

fn pressure(frame: &Value, id: &str) -> bool {
    matches!(wire::reply_to(frame, id), Some(Err(refusal)) if refusal.code == "d1_pressure")
}

impl NodeLink {
    pub fn send(&self, mut frame: Value) -> bool {
        if frame["type"] == "action.result" {
            if frame["id"].as_str().is_none() {
                frame["id"] = format!("action_result_{}", random_uuid()).into();
            }
            self.results()
                .track(frame.clone(), &self.node.node_id, Instant::now());
            if let (Some(id), Err(_)) = (frame["id"].as_str(), self.outgoing.send(frame.clone())) {
                self.results().unsent(id, Instant::now());
                return false;
            }
            return true;
        }
        self.outgoing.send(frame).is_ok()
    }

    /// Uses the broker's five-retry, 25-second budget, and reuses the exact
    /// frame and request id. Only a proven pre-admission refusal is retried.
    pub async fn request(&self, id: &str, frame: Value, timeout: Duration) -> Option<Value> {
        self.request_with_policy(id, frame, timeout, Policy::DEFAULT)
            .await
    }

    /// As `request`, but each send's answer is waited for `late` past
    /// `timeout`, so a late `d1_pressure` is still retried, and one that
    /// has not come by then is handed back to be waited for however late
    /// it comes (`Asked::Late`).
    pub(crate) async fn request_answer(
        &self,
        id: &str,
        frame: Value,
        timeout: Duration,
        late: Duration,
    ) -> Asked {
        self.ask_with_policy(id, frame, timeout, late, Policy::DEFAULT)
            .await
    }

    async fn request_with_policy(
        &self,
        id: &str,
        frame: Value,
        timeout: Duration,
        policy: Policy,
    ) -> Option<Value> {
        match self
            .ask_with_policy(id, frame, timeout, Duration::ZERO, policy)
            .await
        {
            Asked::Answered(reply) => Some(reply),
            Asked::Late(_) => {
                self.forget_request(id);
                None
            }
            Asked::NotSent | Asked::Closed => None,
        }
    }

    async fn ask_with_policy(
        &self,
        id: &str,
        frame: Value,
        timeout: Duration,
        late: Duration,
        policy: Policy,
    ) -> Asked {
        let started = Instant::now();
        let mut attempt = 0;
        loop {
            let remaining = (started + policy.budget).saturating_duration_since(Instant::now());
            let wait = if attempt == 0 {
                timeout
            } else {
                timeout.min(remaining)
            };
            let reply = match self.request_once(id, frame.clone(), wait, late).await {
                Asked::Answered(reply) => reply,
                unanswered => return unanswered,
            };
            if !pressure(&reply, id) {
                return Asked::Answered(reply);
            }
            let Some(delay) = policy.delay(attempt, started, Instant::now()) else {
                let mut exhausted = reply;
                exhausted["message"] =
                    "Node liveness retry pending (d1_pressure retry budget exhausted)".into();
                return Asked::Answered(exhausted);
            };
            attempt += 1;
            tokio::time::sleep(delay).await;
            // A suspended or busy runtime can wake after the budget. Do not
            // dispatch a fresh mutation with a zero-length response window.
            if Instant::now() >= started + policy.budget {
                let mut exhausted = reply;
                exhausted["message"] =
                    "Node liveness retry pending (d1_pressure retry budget exhausted)".into();
                return Asked::Answered(exhausted);
            }
        }
    }

    async fn request_once(
        &self,
        id: &str,
        frame: Value,
        timeout: Duration,
        late: Duration,
    ) -> Asked {
        let Some(mut answer) = self.ask(id, frame) else {
            return Asked::NotSent;
        };
        let waited = match tokio::time::timeout(timeout, &mut answer).await {
            Err(_) if !late.is_zero() => tokio::time::timeout(late, &mut answer).await,
            waited => waited,
        };
        match waited {
            Ok(Ok(reply)) => {
                self.forget_request(id);
                Asked::Answered(reply)
            }
            Ok(Err(_)) => {
                self.forget_request(id);
                Asked::Closed
            }
            Err(_) => Asked::Late(answer),
        }
    }

    /// Sends `frame`, whose `id` is `id`, and hands back the wait for its
    /// answer, which reaches whoever holds it however late it comes.
    /// `None` when the socket ended before it was sent.
    pub(crate) fn ask(&self, id: &str, frame: Value) -> Option<oneshot::Receiver<Value>> {
        let (sender, receiver) = oneshot::channel();
        self.pending().insert(id.to_string(), sender);
        if !self.send(frame) {
            self.forget_request(id);
            return None;
        }
        Some(receiver)
    }

    /// Stops waiting for the answer to `id`.
    pub(crate) fn forget_request(&self, id: &str) {
        self.pending().remove(id);
    }

    fn results(&self) -> MutexGuard<'_, Results> {
        self.results
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }

    /// Whether `frame` was Relaycast's answer to a result or an error no
    /// request waits for; what it said worth noting is in `result_notes`.
    pub(super) fn result_reply(&self, frame: &Value) -> bool {
        self.results()
            .reply(frame, &self.node.node_id, Instant::now())
    }

    pub(super) fn due_results(&self) -> Vec<Value> {
        self.results().due(&self.node.node_id, Instant::now())
    }

    pub(super) fn retained_results(&self) -> Vec<Value> {
        self.results().retained(&self.node.node_id, Instant::now())
    }

    /// `frame` went out again, from a refusal's retry or a new connection.
    pub(super) fn result_resent(&self, frame: &Value) {
        self.results().resent(frame, Instant::now());
    }

    /// The refusals noted since the last call, for the activity log.
    pub(super) fn result_notes(&self) -> Vec<String> {
        std::mem::take(&mut self.results().notes)
    }
}

/// Sends of one result after which it is given up.
const MAX_SENDS: u32 = 8;
/// A result this old is not sent again on a new connection: Relaycast has
/// re-dispatched or expired its invocation by then.
pub(crate) const KEEP: Duration = Duration::from_secs(10 * 60);
/// How often an error no request waits for is noted, per code.
const NOTE_EVERY: Duration = Duration::from_secs(10 * 60);
/// Relaycast's refusal of a result it had already applied.
const SETTLED: &str = "action_result_already_settled";

/// Relaycast's own refusals of a result it read are final (the invocation
/// is gone, settled or another node's); anything else passes.
fn passing(code: &str) -> bool {
    !code.starts_with("action_result_") || code == "action_result_state_changed"
}

fn note(invocation: &str, refusal: &wire::Refusal, again: bool) -> String {
    let then = if again {
        "sending it again"
    } else {
        "not sending it again"
    };
    format!(
        "Agent Relay did not take this computer's answer to {invocation}: {} ({}); {then}.",
        refusal.message, refusal.code
    )
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct Timing {
    /// How long Relaycast has to refuse a sent result before its silence
    /// counts as taken.
    pub(crate) window: Duration,
    /// The backoff unit between sends of a refused result (`push::backoff`).
    pub(crate) unit: Duration,
}

impl Default for Timing {
    fn default() -> Timing {
        Timing {
            window: Policy::DEFAULT.budget,
            unit: Duration::from_secs(1),
        }
    }
}

/// What came of a request whose answer may still be waited for.
pub(crate) enum Asked {
    Answered(Value),
    /// The socket ended before it was sent: nothing reached Relaycast.
    NotSent,
    /// The socket ended before its answer came.
    Closed,
    /// No answer came in time: the wait for it, however late it comes.
    Late(oneshot::Receiver<Value>),
}

struct Pending {
    frame: Value,
    node_id: String,
    created: Instant,
    last_sent: Instant,
    /// Every send of the result, on any connection.
    sends: u32,
    retry_at: Option<Instant>,
    refused: bool,
}

/// The results the node still owes Relaycast, kept across its connections
/// and, held by the ledger, across a restarted node.
///
/// Relaycast answers nothing to a result it applied and an `error` frame
/// with the result's id to one it could not. A passing refusal sends the
/// same frame again after a jittered backoff, up to `MAX_SENDS` sends; one
/// whose socket ended before Relaycast answered is sent again on the next
/// connection; Relaycast's own `action_result_*` refusals are final.
#[derive(Default)]
pub(crate) struct Results {
    pending: HashMap<String, Pending>,
    timing: Timing,
    noted: HashMap<String, Instant>,
    notes: Vec<String>,
}

impl Results {
    #[cfg(test)]
    pub(crate) fn new(timing: Timing) -> Results {
        Results {
            timing,
            ..Results::default()
        }
    }

    /// The ids of the results not yet known to be taken.
    #[cfg(test)]
    pub(super) fn owed(&self) -> Vec<String> {
        self.pending.keys().cloned().collect()
    }

    fn track(&mut self, frame: Value, node_id: &str, now: Instant) {
        let Some(id) = frame["id"].as_str() else {
            return;
        };
        self.pending.entry(id.to_string()).or_insert(Pending {
            frame,
            node_id: node_id.to_string(),
            created: now,
            last_sent: now,
            sends: 1,
            retry_at: None,
            refused: false,
        });
    }

    /// The socket would not take the result: the connection that has it,
    /// or the next one, sends it.
    fn unsent(&mut self, id: &str, now: Instant) {
        if let Some(pending) = self.pending.get_mut(id) {
            pending.sends = pending.sends.saturating_sub(1);
            pending.retry_at = Some(now);
        }
    }

    /// Relaycast's answer on `node_id`'s socket, which settles only that
    /// node's results.
    fn reply(&mut self, frame: &Value, node_id: &str, now: Instant) -> bool {
        let id = frame["id"].as_str().unwrap_or_default();
        let Some(pending) = self
            .pending
            .get_mut(id)
            .filter(|pending| pending.node_id == node_id)
        else {
            return self.unanswered(frame, now);
        };
        let refusal = match wire::reply_to(frame, id) {
            None => return false,
            Some(Ok(_)) => None,
            Some(Err(refusal)) if refusal.code == SETTLED => None,
            Some(Err(refusal)) => Some(refusal),
        };
        let Some(refusal) = refusal else {
            self.pending.remove(id);
            return true;
        };
        let invocation = pending.frame["invocation_id"]
            .as_str()
            .unwrap_or("an action")
            .to_string();
        let again = passing(&refusal.code) && pending.sends < MAX_SENDS;
        if !again {
            self.pending.remove(id);
            self.notes.push(note(&invocation, &refusal, false));
            return true;
        }
        if !pending.refused {
            pending.refused = true;
            self.notes.push(note(&invocation, &refusal, true));
        }
        let delay = backoff(pending.sends, random_jitter());
        pending.retry_at = Some(now + self.timing.unit.mul_f64(delay));
        true
    }

    /// An `error` frame no request or result waits for (a refused
    /// heartbeat, say): noted at most once per code every `NOTE_EVERY`.
    fn unanswered(&mut self, frame: &Value, now: Instant) -> bool {
        if frame["type"] != "error" {
            return false;
        }
        let code = frame["code"].as_str().unwrap_or("refused");
        let recent = self
            .noted
            .get(code)
            .is_some_and(|at| now.saturating_duration_since(*at) < NOTE_EVERY);
        if !recent {
            self.noted.insert(code.to_string(), now);
            let message = frame["message"].as_str().unwrap_or("no reason given");
            self.notes.push(format!(
                "Agent Relay refused a message from this computer's spawn node: {message} ({code})."
            ));
        }
        true
    }

    /// The results of `node_id` to send again on its socket now. Another
    /// node's results are never sent here: a result an older node's action
    /// finished with after a newer node connected waits for that node's
    /// next connection, and the next connection of any other node drops it
    /// (`retained`).
    fn due(&mut self, node_id: &str, now: Instant) -> Vec<Value> {
        // Relaycast says nothing to a result it applied: one sent on a live
        // socket and not refused within the window counts as taken.
        let window = self.timing.window;
        self.pending.retain(|_, p| {
            p.node_id != node_id
                || p.retry_at.is_some()
                || now.saturating_duration_since(p.last_sent) < window
        });
        self.pending
            .values_mut()
            .filter(|pending| pending.node_id == node_id)
            .filter_map(|pending| {
                if pending.retry_at.is_some_and(|at| at <= now) {
                    pending.retry_at = None;
                    Some(pending.frame.clone())
                } else {
                    None
                }
            })
            .collect()
    }

    /// What a new connection sends first: every result the last one did
    /// not see taken, for this node and not too old to matter.
    fn retained(&mut self, node_id: &str, now: Instant) -> Vec<Value> {
        self.pending
            .retain(|_, p| p.node_id == node_id && now.saturating_duration_since(p.created) < KEEP);
        let mut spent = Vec::new();
        self.pending.retain(|_, p| {
            if p.sends < MAX_SENDS {
                return true;
            }
            spent.push(
                p.frame["invocation_id"]
                    .as_str()
                    .unwrap_or("an action")
                    .to_string(),
            );
            false
        });
        for invocation in spent {
            self.notes.push(format!(
                "Agent Relay did not confirm this computer's answer to {invocation} after {MAX_SENDS} sends; not sending it again."
            ));
        }
        self.pending
            .values()
            .map(|pending| pending.frame.clone())
            .collect()
    }

    fn resent(&mut self, frame: &Value, now: Instant) {
        if let Some(pending) = frame["id"].as_str().and_then(|id| self.pending.get_mut(id)) {
            pending.last_sent = now;
            pending.sends += 1;
            pending.retry_at = None;
        }
    }
}

#[cfg(test)]
mod tests;
