//! A message already admitted as a peer must never acquire a second native turn.
use super::*;

impl CodexRouter {
    pub(super) fn claim_mode(
        &self,
        path: &Path,
        key: &str,
        thread: &str,
        id: &str,
        text: &str,
    ) -> Result<Entry, String> {
        let peer = self.peer_evidence(thread, id);
        journal::edit(path, |store| {
            store.claim(key, id, &digest(text.as_bytes()))?;
            let entry = store
                .entry(key, id)
                .ok_or("The Codex receipt disappeared.")?;
            if peer && entry.state == State::Unsent {
                entry.state = State::Peer;
            }
            Ok(entry.clone())
        })
    }

    pub(super) fn peer_evidence(&self, thread: &str, id: &str) -> bool {
        let reference = MessageRef::of(id);
        self.routes.recorded(thread, &reference)
            || self.routes.queue_waiting(thread, &reference) == Some(true)
            || self.routes.hidden_waiting(thread, &reference)
            || crate::relay::codex::compact::held(thread, id).is_some()
            || self
                .handed_off
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .contains_key(id)
            || self
                .stop_hook
                .as_ref()
                .is_some_and(|inbox| inbox.is_held(id) || inbox.taken_at(id).is_some())
            || self.turn_hook_has(id)
    }

    pub(super) fn observe_peer(&self, thread: &str, id: &str) -> InjectOutcome {
        let reference = MessageRef::of(id);
        if self.routes.recorded(thread, &reference) || self.routes.native_recorded(thread, id) {
            return self.delivered(thread, id, &reference);
        }
        if let Some(outcome) = self.turn_hook_claim(id) {
            return outcome;
        }
        match self.routes.queue_waiting(thread, &reference) {
            Some(true) => return self.handed(thread, id),
            None => {
                self.remember_once(id);
                return InjectOutcome::Accepted(QUEUE_UNREADABLE.into());
            }
            Some(false) => {}
        }
        if self.routes.hidden_waiting(thread, &reference) {
            return InjectOutcome::Accepted(
                "The original peer message is already in Codex's history; waiting for its turn."
                    .into(),
            );
        }
        // Queue removal can precede the rollout receipt, including after a
        // restart. Observe the same bounded grace as an ordinary peer handoff.
        self.missing_handoff_outcome(id)
    }

    /// A durable native choice survives transient capability loss. The core
    /// must still verify current owner, workspace and opt-in before retrying it.
    /// Corrupt existing storage fails closed into the native observation path.
    pub fn native_choice(&self, thread: &str, id: &str) -> bool {
        if !queue::is_thread_id(thread) {
            return false;
        }
        let Some(root) = self.routes.native_receipts() else {
            return false;
        };
        let path = receipt_path(&root, thread, id);
        match std::fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return false,
            Err(_) => return true,
            Ok(_) => {}
        }
        journal::edit(&path, |store| {
            let key = thread.to_ascii_lowercase();
            store.validate_scope(&key, id)?;
            Ok(store
                .entry(&key, id)
                .is_some_and(|entry| entry.state != State::Peer))
        })
        .unwrap_or(true)
    }
}
