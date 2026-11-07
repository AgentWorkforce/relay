//! A durable, bounded native-input queue. Taking text is irreversible: a
//! lost acknowledgement never makes it eligible for another submission.

use super::Refusal;
use crate::platform::fs::{create_private_dir, write_atomic};
use crate::relay::store::random_uuid;
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const MAX_ENTRIES: usize = 256;
const MAX_TEXT: usize = 96 * 1024;
pub(crate) const LEASE_MS: i64 = 120_000;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Runtime {
    pub pid: i32,
    pub start: u64,
    pub idle: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Binding {
    pub scope: String,
    pub owner: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
enum State {
    Queued {
        until: i64,
    },
    Submitting {
        runtime: Runtime,
        lease: String,
        until: i64,
    },
    Started,
    Failed,
    InDoubt,
    Unavailable,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Entry {
    binding: Binding,
    delivery_id: String,
    text: String,
    state: State,
    /// A teammate's direct message, queued under the owner's binding
    /// (`teammate_native_input`): its answer is not forwarded to the owner,
    /// and turning the setting off cancels it while unsent.
    #[serde(default)]
    teammate: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    refusal: Option<Refusal>,
}

#[derive(Serialize, Deserialize)]
struct Active {
    binding: Binding,
    runtime: Runtime,
    confirmed: bool,
    #[serde(default)]
    control_token: String,
}

#[derive(Default, Serialize, Deserialize)]
pub(crate) struct Journal {
    entries: Vec<Entry>,
    #[serde(default)]
    active: Vec<Active>,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Outcome {
    Waiting,
    Started,
    Failed,
    Refused(Refusal),
    InDoubt,
    Unavailable,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub(crate) enum Action {
    Submit {
        delivery_id: String,
        lease_id: String,
        control_token: String,
        text: String,
        /// Whether the turn's answer goes to the owner's phone and engages
        /// the owner's reply subscription: the owner's own messages do, a
        /// teammate's do not.
        forward_answer: bool,
    },
}

impl Journal {
    /// Queues the owner's own message (`enqueue_from` with `teammate` off).
    #[cfg(test)]
    pub fn enqueue(
        &mut self,
        binding: Binding,
        id: &str,
        text: &str,
        now: i64,
    ) -> Result<Outcome, String> {
        self.enqueue_from(binding, id, text, false, now)
    }

    pub fn enqueue_from(
        &mut self,
        binding: Binding,
        id: &str,
        text: &str,
        teammate: bool,
        now: i64,
    ) -> Result<Outcome, String> {
        if let Some(entry) = self
            .entries
            .iter_mut()
            .find(|entry| entry.delivery_id == id)
        {
            if entry.binding != binding || entry.text != text && !entry.text.is_empty() {
                return Err("The queued message no longer matches this session.".into());
            }
            expire(entry, now);
            return Ok(outcome(entry));
        }
        if text.len() > MAX_TEXT || self.entries.len() >= MAX_ENTRIES {
            return Err("The mobile message queue is full.".into());
        }
        self.entries.push(Entry {
            binding,
            delivery_id: id.into(),
            text: text.into(),
            state: State::Queued {
                until: now + LEASE_MS,
            },
            teammate,
            refusal: None,
        });
        Ok(Outcome::Waiting)
    }

    /// Cancels every teammate's message not yet handed over: turning
    /// `teammate_native_input` off must not let one start later. One the
    /// plugin already holds a lease on settles through its acknowledgement,
    /// and the owner's messages and every receipt are left alone.
    pub fn cancel_teammates(&mut self) -> bool {
        let mut changed = false;
        for entry in &mut self.entries {
            if entry.teammate && matches!(entry.state, State::Queued { .. }) {
                cancel(entry);
                changed = true;
            }
        }
        changed
    }

    pub fn cancel(&mut self) {
        for entry in &mut self.entries {
            cancel(entry);
        }
        self.active.clear();
    }

    pub fn cancel_scopes(&mut self, scopes: &std::collections::BTreeSet<String>) {
        for entry in &mut self.entries {
            if scopes.contains(&entry.binding.scope) {
                cancel(entry);
            }
        }
        self.active
            .retain(|active| !scopes.contains(&active.binding.scope));
    }

    pub fn contains_delivery(&self, id: &str) -> bool {
        self.entries.iter().any(|entry| entry.delivery_id == id)
    }

    pub fn previous(
        &mut self,
        scope: &str,
        id: &str,
        authorized: bool,
        now: i64,
    ) -> Option<Outcome> {
        let entry = self
            .entries
            .iter_mut()
            .find(|entry| entry.binding.scope == scope && entry.delivery_id == id)?;
        if !authorized {
            cancel(entry);
        }
        expire(entry, now);
        Some(outcome(entry))
    }

    pub fn pending_binding(&self, scope: &str, delivery_id: &str) -> Option<Binding> {
        self.entries
            .iter()
            .find(|entry| {
                entry.binding.scope == scope
                    && entry.delivery_id == delivery_id
                    && matches!(entry.state, State::Queued { .. } | State::Submitting { .. })
            })
            .map(|entry| entry.binding.clone())
    }

    pub fn active_runtime(&self, binding: &Binding, runtime: &Runtime) -> bool {
        self.active.iter().any(|active| {
            active.binding == *binding
                && (active.runtime.pid, active.runtime.start) == (runtime.pid, runtime.start)
        })
    }

    pub fn control_valid(
        &self,
        binding: &Binding,
        runtime: &Runtime,
        token: &str,
        confirmed: bool,
    ) -> bool {
        !token.is_empty()
            && self.active.iter().any(|active| {
                active.binding == *binding
                    && (active.runtime.pid, active.runtime.start) == (runtime.pid, runtime.start)
                    && active.control_token == token
                    && (!confirmed || active.confirmed)
            })
    }

    #[cfg(test)]
    pub fn confirmed_active_runtime(&self, binding: &Binding, runtime: &Runtime) -> bool {
        self.active_runtime(binding, runtime) && self.confirmed_runtime(&binding.scope).is_some()
    }

    pub fn pending(&self, scope: &str) -> bool {
        self.entries.iter().any(|entry| {
            entry.binding.scope == scope
                && matches!(entry.state, State::Queued { .. } | State::Submitting { .. })
        })
    }

    pub fn prune_active(&mut self, live: impl Fn(&Binding, &Runtime) -> bool) -> Vec<String> {
        // Receipts and leases are independent: removing a dead runtime must
        // never make its previously submitted message eligible for replay.
        let mut removed = Vec::new();
        self.active.retain(|active| {
            let keep = live(&active.binding, &active.runtime);
            if !keep {
                removed.push(active.binding.scope.clone());
            }
            keep
        });
        removed
    }

    pub fn confirmed_runtime(&self, scope: &str) -> Option<Runtime> {
        self.active
            .iter()
            .find(|active| active.binding.scope == scope && active.confirmed)
            .map(|active| active.runtime.clone())
    }

    pub fn status(&self, scope: &str) -> Option<&'static str> {
        let latest = self
            .entries
            .iter()
            .rev()
            .find(|entry| entry.binding.scope == scope);
        match latest.map(|entry| &entry.state) {
            Some(State::Failed | State::InDoubt | State::Unavailable) => Some("failed"),
            Some(State::Submitting { .. }) => Some("connecting"),
            Some(State::Started) => Some("ready"),
            _ if self
                .active
                .iter()
                .any(|active| active.binding.scope == scope && active.confirmed) =>
            {
                Some("ready")
            }
            _ => None,
        }
    }

    pub fn notice(&self, scope: &str) -> &'static str {
        if let Some(reason) = self
            .entries
            .iter()
            .rev()
            .find(|entry| entry.binding.scope == scope)
            .filter(|entry| matches!(entry.state, State::Failed))
            .and_then(|entry| entry.refusal)
        {
            return reason.notice();
        }
        match self.entries.iter().rev().find(|entry| entry.binding.scope == scope).map(|entry| &entry.state) {
            Some(State::Unavailable) => "Restart or reload Claude to enable mobile control, then send the message again. This message was not submitted.",
            Some(State::Failed | State::InDoubt) => "Claude's mobile connection could not be confirmed. Check the message status before sending again.",
            _ => "",
        }
    }

    pub fn prune(&mut self, handled: impl Fn(&str) -> bool) {
        self.entries.retain(|entry| !handled(&entry.delivery_id));
    }

    /// Keeps an unsent message waiting, as a poll would, while the
    /// session's plugin holds its doorbell open: a busy session may run
    /// longer than one lease without its plugin asking.
    pub fn keep_waiting(&mut self, scope: &str, id: &str, now: i64) {
        for entry in self
            .entries
            .iter_mut()
            .filter(|entry| entry.binding.scope == scope && entry.delivery_id == id)
        {
            expire(entry, now);
            if let State::Queued { until } = &mut entry.state {
                if *until - now < LEASE_MS / 2 {
                    *until = now + LEASE_MS;
                }
            }
        }
    }

    /// Moves every queued message's lease `by` milliseconds closer to its
    /// end, as if that much time had passed with nobody asking.
    #[cfg(test)]
    pub fn age_queued(&mut self, by: i64) {
        for entry in &mut self.entries {
            if let State::Queued { until } = &mut entry.state {
                *until -= by;
            }
        }
    }

    /// Whether message `id` waits for a plugin to collect it.
    pub fn uncollected(&self, scope: &str, id: &str) -> bool {
        self.entries.iter().any(|entry| {
            entry.binding.scope == scope
                && entry.delivery_id == id
                && matches!(entry.state, State::Queued { .. })
        })
    }

    /// Whether the binding has a message no plugin has collected yet whose
    /// lease has not passed at `now` (expiry is lazy, so a lapsed one may
    /// still read `Queued`).
    pub fn queued(&self, binding: &Binding, now: i64) -> bool {
        self.entries.iter().any(|entry| {
            entry.binding == *binding
                && matches!(entry.state, State::Queued { until } if until > now)
        })
    }

    /// `poll_allowing` with teammates' messages allowed.
    #[cfg(test)]
    pub fn poll(&mut self, binding: &Binding, runtime: &Runtime, now: i64) -> Option<Action> {
        self.poll_allowing(binding, runtime, true, now)
    }

    /// The next message for the session's plugin to submit. With
    /// `teammates` off, a teammate's unsent message is cancelled instead of
    /// handed over, so a setting turned off between queueing and polling
    /// still holds.
    pub fn poll_allowing(
        &mut self,
        binding: &Binding,
        runtime: &Runtime,
        teammates: bool,
        now: i64,
    ) -> Option<Action> {
        if !teammates {
            self.cancel_teammates();
        }
        if !self
            .active
            .iter()
            .any(|active| active.binding.scope == binding.scope)
            && self.active.len() >= MAX_ENTRIES
        {
            return None;
        }
        let entry = self.entries.iter_mut().find(|entry| {
            entry.binding == *binding
                && matches!(entry.state, State::Queued { .. } | State::Submitting { .. })
        })?;
        expire(entry, now);
        if let State::Queued { until } = &mut entry.state {
            // A verified installed mod can keep an idle-wait alive. An absent
            // mod cannot leave a phone message queued forever.
            if *until - now < LEASE_MS / 2 {
                *until = now + LEASE_MS;
            }
        } else {
            return None;
        }
        if !runtime.idle {
            return None;
        }
        let lease_id = random_uuid();
        let delivery_id = entry.delivery_id.clone();
        let text = entry.text.clone();
        let forward_answer = !entry.teammate;
        entry.state = State::Submitting {
            runtime: runtime.clone(),
            lease: lease_id.clone(),
            until: now + LEASE_MS,
        };
        if !self.active_runtime(binding, runtime) {
            self.active
                .retain(|active| active.binding.scope != binding.scope);
            self.active.push(Active {
                binding: binding.clone(),
                runtime: runtime.clone(),
                confirmed: false,
                control_token: random_uuid(),
            });
        }
        let control_token = self
            .active
            .iter()
            .find(|active| active.binding == *binding)
            .map(|active| active.control_token.clone())?;
        Some(Action::Submit {
            delivery_id,
            lease_id,
            control_token,
            text,
            forward_answer,
        })
    }

    pub fn ack(
        &mut self,
        binding: &Binding,
        runtime: &Runtime,
        lease: &str,
        started: bool,
        now: i64,
    ) -> Option<String> {
        let entry = self.entries.iter_mut().find(|entry| {
            entry.binding == *binding
                && match &entry.state {
                    State::Submitting {
                        runtime: claimed,
                        lease: key,
                        ..
                    } => {
                        key == lease && (claimed.pid, claimed.start) == (runtime.pid, runtime.start)
                    }
                    _ => false,
                }
        })?;
        expire(entry, now);
        entry.state = match (&entry.state, started) {
            (State::Submitting { .. }, true) => State::Started,
            (State::Submitting { .. }, false) => State::Failed,
            _ => return None,
        };
        entry.text.clear();
        let delivery_id = entry.delivery_id.clone();
        if started {
            for active in &mut self.active {
                if active.binding == *binding
                    && (active.runtime.pid, active.runtime.start) == (runtime.pid, runtime.start)
                {
                    active.confirmed = true;
                }
            }
        } else {
            // Provisional control exists only so the first submission can
            // ask for approval before its acknowledgement. A refusal ends
            // that authority. A previously confirmed generation, however,
            // still belongs to the earlier accepted turn.
            self.active.retain(|active| {
                active.binding != *binding
                    || (active.runtime.pid, active.runtime.start) != (runtime.pid, runtime.start)
                    || active.confirmed
            });
        }
        Some(delivery_id)
    }

    /// Called only after this lease's authenticated failed acknowledgement.
    /// It adds an explanation, never a second submission or retry path.
    pub fn record_refusal(&mut self, delivery_id: &str, refusal: Refusal) {
        if let Some(entry) = self
            .entries
            .iter_mut()
            .find(|entry| entry.delivery_id == delivery_id && matches!(entry.state, State::Failed))
        {
            entry.refusal = Some(refusal);
        }
    }
}

fn cancel(entry: &mut Entry) {
    entry.state = match entry.state {
        State::Queued { .. } => State::Failed,
        State::Submitting { .. } => State::InDoubt,
        _ => return,
    };
    entry.text.clear();
}

fn expire(entry: &mut Entry, now: i64) {
    match &entry.state {
        State::Queued { until } if now >= *until => entry.state = State::Unavailable,
        State::Submitting { until, .. } if now >= *until => entry.state = State::InDoubt,
        _ => return,
    }
    entry.text.clear();
}

fn outcome(entry: &Entry) -> Outcome {
    match &entry.state {
        State::Started => Outcome::Started,
        State::Failed => entry
            .refusal
            .map(Outcome::Refused)
            .unwrap_or(Outcome::Failed),
        State::InDoubt => Outcome::InDoubt,
        State::Unavailable => Outcome::Unavailable,
        _ => Outcome::Waiting,
    }
}

/// Cross-process lock and synced atomic replacement: no payload is returned
/// unless its non-replayable lease reached disk first.
pub(crate) fn edit<T>(
    data: &Path,
    action: impl FnOnce(&mut Journal) -> Result<T, String>,
) -> Result<T, String> {
    let directory = data.join("mobile-claude-handoff");
    create_private_dir(&directory)
        .map_err(|_| "Could not open the mobile message queue.".to_string())?;
    let path = directory.join("queue.json");
    let lock_path: PathBuf = directory.join("queue.lock");
    let lock = crate::platform::fs::private(
        std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true),
    )
    .open(lock_path)
    .map_err(|_| "Could not lock the mobile message queue.".to_string())?;
    lock.lock_exclusive()
        .map_err(|_| "Could not lock the mobile message queue.".to_string())?;
    let mut journal = match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|_| "The mobile message queue could not be read.".to_string())?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Journal::default(),
        Err(_) => return Err("The mobile message queue could not be read.".into()),
    };
    let before = serde_json::to_vec(&journal)
        .map_err(|_| "Could not encode the mobile message queue.".to_string())?;
    let result = action(&mut journal)?;
    let bytes = serde_json::to_vec(&journal)
        .map_err(|_| "Could not encode the mobile message queue.".to_string())?;
    if bytes != before {
        write_atomic(&path, &bytes)
            .map_err(|_| "Could not save the mobile message queue.".to_string())?;
    }
    Ok(result)
}

#[cfg(test)]
mod tests;
