//! A durable, bounded native-input queue. Taking text is irreversible: a
//! lost acknowledgement never makes it eligible for another submission.

use crate::relay::outbox::{create_private_dir, write_atomic};
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
    },
}

impl Journal {
    pub fn enqueue(
        &mut self,
        binding: Binding,
        id: &str,
        text: &str,
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
            return Ok(outcome(&entry.state));
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
        });
        Ok(Outcome::Waiting)
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
        Some(outcome(&entry.state))
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
        match self.entries.iter().rev().find(|entry| entry.binding.scope == scope).map(|entry| &entry.state) {
            Some(State::Unavailable) => "Restart or reload Claude to enable mobile control, then send the message again. This message was not submitted.",
            Some(State::Failed | State::InDoubt) => "Claude's mobile connection could not be confirmed. Check the message status before sending again.",
            _ => "",
        }
    }

    pub fn prune(&mut self, handled: impl Fn(&str) -> bool) {
        self.entries.retain(|entry| !handled(&entry.delivery_id));
    }

    pub fn poll(&mut self, binding: &Binding, runtime: &Runtime, now: i64) -> Option<Action> {
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
        })
    }

    pub fn ack(
        &mut self,
        binding: &Binding,
        runtime: &Runtime,
        lease: &str,
        started: bool,
        now: i64,
    ) -> bool {
        let Some(entry) = self.entries.iter_mut().find(|entry| {
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
        }) else {
            return false;
        };
        expire(entry, now);
        entry.state = match (&entry.state, started) {
            (State::Submitting { .. }, true) => State::Started,
            (State::Submitting { .. }, false) => State::Failed,
            _ => return false,
        };
        entry.text.clear();
        if started {
            for active in &mut self.active {
                if active.binding == *binding
                    && (active.runtime.pid, active.runtime.start) == (runtime.pid, runtime.start)
                {
                    active.confirmed = true;
                }
            }
        }
        true
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

fn outcome(state: &State) -> Outcome {
    match state {
        State::Started => Outcome::Started,
        State::Failed => Outcome::Failed,
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
