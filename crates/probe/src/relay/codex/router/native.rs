//! Native input goes through the exact existing window, which keeps its own
//! permission UI. No queue, model-context injection, resume, or approval driver.
use super::*;
use sha2::{Digest, Sha256};
mod journal;
mod peer;
use journal::{Entry, State};

pub(super) fn receipts(config: &CodexConfig) -> PathBuf {
    // SQLite homes can share a Codex home; neither may borrow the other's
    // native receipts. The path contains no user prompt or credentials.
    let home = digest(config.home.as_os_str().as_encoded_bytes());
    config
        .sqlite_home
        .join("agent-relay-native-input")
        .join(home)
}

pub(super) fn recorded(config: &CodexConfig, thread: &str, message_id: &str) -> bool {
    rollout::rollout_path(config, thread)
        .and_then(|path| rollout::RolloutSummary::read(&path))
        .is_some_and(|summary| summary.turn_by_client_message.contains_key(message_id))
}

fn receipt_path(root: &Path, thread: &str, id: &str) -> PathBuf {
    root.join(digest(thread.to_ascii_lowercase().as_bytes()))
        .join(format!("{}.json", digest(id.as_bytes())))
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn valid_input(thread: &str, id: &str, text: &str) -> bool {
    queue::is_thread_id(thread)
        && !id.is_empty()
        && id.len() <= 1024
        && !text.trim().is_empty()
        && text.len() <= 96 * 1024
}

fn outcome(state: &State) -> Option<InjectOutcome> {
    match state {
        State::Unsent => None,
        State::Peer => Some(InjectOutcome::InDoubt(
            "A prior peer handoff must be reconciled without a new native turn.".into(),
        )),
        State::Started => Some(InjectOutcome::Delivered),
        State::InDoubt => Some(InjectOutcome::InDoubt(
            "Codex has not confirmed this native message; it will not be sent again.".into(),
        )),
        State::Refused => Some(InjectOutcome::Refused(
            "The native Codex message was cancelled or its original window became unavailable."
                .into(),
        )),
    }
}

impl CodexRouter {
    pub(crate) fn mobile_control(&self, config: &CodexConfig, thread: &str, message: &str) -> Option<Box<dyn crate::relay::codex_mobile::provider::Control>> {
        let path=receipt_path(&self.routes.native_receipts()?, thread, message);
        let owner=journal::edit(&path, |store| {
            store.validate_scope(&thread.to_ascii_lowercase(), message)?;
            Ok(store.entry(&thread.to_ascii_lowercase(), message)
                .filter(|entry| entry.state == State::Started).and_then(|entry|entry.owner.clone()))
        }).ok()??;
        let window=crate::relay::codex_mobile::provider::Window::open(config.clone(), thread, message, &owner)?;
        Some(Box::new(window))
    }
    /// A loaded app-server can outlive its final UI subscriber. Only the
    /// window-owner protocol proves a UI still owns this exact conversation.
    /// Windows has no verified window-router transport and reports false.
    pub fn native_continuation(&self, thread: &str) -> bool {
        queue::is_thread_id(thread)
            && self.routes.native_receipts().is_some()
            && !self.routes.terminal_live(thread)
            && !self.routes.conductor_owned(thread)
            && self.routes.native_window_owner(thread).is_some()
    }

    /// Called before every peer route, including after opt-out or restart.
    /// A previously native message cannot acquire peer framing or enter a
    /// different provider transport, even if its first attempt was unsent.
    pub(super) fn previous_native(&self, thread: &str, id: &str) -> Option<InjectOutcome> {
        let path = receipt_path(&self.routes.native_receipts()?, thread, id);
        match std::fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
            Err(_) => {
                return Some(InjectOutcome::InDoubt(
                    "Native Codex receipts are unavailable.".into(),
                ))
            }
            Ok(_) => {}
        }
        let recorded = self.routes.native_recorded(thread, id);
        match journal::edit(&path, |store| {
            store.validate_scope(&thread.to_ascii_lowercase(), id)?;
            let Some(entry) = store.entry(&thread.to_ascii_lowercase(), id) else {
                return Ok(None);
            };
            if recorded && entry.state != State::Peer {
                entry.state = State::Started;
            }
            if entry.state == State::Unsent {
                entry.state = State::Refused;
            }
            Ok(Some(entry.state.clone()))
        }) {
            Ok(Some(State::Peer)) => Some(self.observe_peer(thread, id)),
            Ok(value) => value.and_then(|state| outcome(&state)),
            Err(error) => Some(InjectOutcome::InDoubt(error)),
        }
    }

    #[cfg(test)]
    pub fn inject_native_existing(&self, thread: &str, id: &str, text: &str) -> InjectOutcome {
        self.inject_native_existing_guarded(thread, id, text, &|| true)
    }

    pub fn inject_native_existing_guarded(
        &self,
        thread: &str,
        id: &str,
        text: &str,
        admit: &(dyn Fn() -> bool + Send + Sync),
    ) -> InjectOutcome {
        match self.native_attempt(thread, id, text, admit) {
            Ok(outcome) => outcome,
            Err(error) => InjectOutcome::InDoubt(error),
        }
    }

    fn native_attempt(
        &self,
        thread: &str,
        id: &str,
        text: &str,
        admit: &(dyn Fn() -> bool + Send + Sync),
    ) -> Result<InjectOutcome, String> {
        if !valid_input(thread, id, text) {
            return Ok(InjectOutcome::Refused(
                "Invalid native Codex message.".into(),
            ));
        }
        if let Some(outcome) = self.turn_hook_unknown(id) {
            return Ok(outcome);
        }
        let path = self
            .routes
            .native_receipts()
            .ok_or("Native Codex continuation is unavailable.")?;
        let path = receipt_path(&path, thread, id);
        let key = thread.to_ascii_lowercase();
        let entry = self.claim_mode(&path, &key, thread, id, text)?;
        if entry.state == State::Peer {
            return Ok(self.observe_peer(thread, id));
        }
        if self.routes.native_recorded(thread, id) {
            self.save_native(&path, &key, id, State::Started)?;
            return Ok(InjectOutcome::Delivered);
        }
        if let Some(outcome) = outcome(&entry.state) {
            return Ok(outcome);
        }
        if self.routes.terminal_live(thread) || self.routes.conductor_owned(thread) {
            return self.cancel_unsent_native(&path, &key, id);
        }
        let Some(owner) = self.routes.native_window_owner(thread) else {
            return self.missing_native_owner(&path, &key, id);
        };
        let bound = journal::edit(&path, |store| {
            let entry = store
                .entry(&key, id)
                .ok_or("The native Codex receipt disappeared.")?;
            if entry.state != State::Unsent {
                return Ok(entry.clone());
            }
            if entry
                .owner
                .as_ref()
                .is_some_and(|previous| previous != &owner)
            {
                entry.state = State::Refused;
            } else {
                entry.owner = Some(owner.clone());
            }
            Ok(entry.clone())
        })?;
        if let Some(outcome) = outcome(&bound.state) {
            return Ok(outcome);
        }
        if !self.routes.idle(thread) {
            return Ok(InjectOutcome::WaitingForTurn(BEHIND_TURN.into()));
        }
        if !self.routes.hidden_refs(thread).is_empty() {
            return Ok(InjectOutcome::Waiting(BEHIND_HIDDEN.into()));
        }
        match self.routes.relay_waiting(thread) {
            Some(false) => {}
            Some(true) => {
                return Ok(InjectOutcome::Waiting(
                    "Waiting — earlier Codex queue messages must finish first.".into(),
                ))
            }
            None => return Ok(InjectOutcome::Waiting(QUEUE_UNREADABLE.into())),
        }
        self.submit_native(&path, &key, thread, id, text, &bound, admit)
    }

    fn missing_native_owner(
        &self,
        path: &Path,
        thread: &str,
        id: &str,
    ) -> Result<InjectOutcome, String> {
        journal::edit(path, |store| {
            let entry = store
                .entry(thread, id)
                .ok_or("The native Codex receipt disappeared.")?;
            if let Some(known) = outcome(&entry.state) {
                return Ok(known);
            }
            if entry.owner.is_some() {
                return Ok(InjectOutcome::Waiting(
                    "Waiting — the original Codex window is unavailable.".into(),
                ));
            }
            entry.state = State::Refused;
            Ok(InjectOutcome::Refused(
                "The original Codex window disappeared before the message could be bound.".into(),
            ))
        })
    }

    fn cancel_unsent_native(
        &self,
        path: &Path,
        thread: &str,
        id: &str,
    ) -> Result<InjectOutcome, String> {
        journal::edit(path, |store| {
            let entry = store
                .entry(thread, id)
                .ok_or("The native Codex receipt disappeared.")?;
            if entry.state == State::Unsent {
                entry.state = State::Refused;
            }
            outcome(&entry.state).ok_or("Invalid native Codex receipt.".into())
        })
    }

    fn submit_native(
        &self,
        path: &Path,
        key: &str,
        thread: &str,
        id: &str,
        text: &str,
        bound: &Entry,
        admit: &(dyn Fn() -> bool + Send + Sync),
    ) -> Result<InjectOutcome, String> {
        if !admit() {
            return self.cancel_unsent_native(path, key, id);
        }
        let begun = journal::edit(path, |store| {
            let entry = store
                .entry(key, id)
                .ok_or("The native Codex receipt disappeared.")?;
            if entry.state != State::Unsent || entry.owner != bound.owner {
                return Ok(false);
            }
            entry.state = State::InDoubt;
            Ok(true)
        })?;
        if !begun {
            return Ok(InjectOutcome::InDoubt(
                "Another attempt holds this native Codex message.".into(),
            ));
        }
        let owner = bound
            .owner
            .as_deref()
            .ok_or("The original Codex window is unknown.")?;
        let result = self.routes.native_window(thread, text, id, owner, admit);
        let state = match result {
            Ok(true) => State::Started,
            Ok(false) | Err(TurnError::Refused(_)) => State::Refused,
            Err(TurnError::InDoubt(_)) => State::InDoubt,
        };
        let state = self.save_native(path, key, id, state)?;
        outcome(&state).ok_or("Codex returned an invalid native receipt.".into())
    }

    fn save_native(
        &self,
        path: &Path,
        thread: &str,
        id: &str,
        state: State,
    ) -> Result<State, String> {
        journal::edit(path, |store| {
            let entry = store
                .entry(thread, id)
                .ok_or("The native Codex receipt disappeared.")?;
            // A simultaneous rollout observation is authoritative even if the
            // original sender later loses or rejects its response.
            if entry.state != State::Started {
                entry.state = state;
            }
            Ok(entry.state.clone())
        })
    }
}

#[cfg(test)]
mod tests;
