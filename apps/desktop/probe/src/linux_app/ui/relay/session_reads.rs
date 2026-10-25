//! Reconcile native listings without replacing a newer title mutation.
use super::*;

impl App {
    /// Keeps a `sessions.list` answer unless a newer read already landed.
    pub(super) fn apply_local(&self, read: u64, sessions: Vec<LocalSession>) -> bool {
        let applied = self.update_state(|state| {
            if read <= state.local_applied {
                return false;
            }
            state.local_applied = read;
            state.local_sessions = sessions;
            true
        });
        if applied {
            self.reconcile_hidden_sessions();
        }
        applied
    }

    pub(super) fn apply_local_after_title_write(
        &self,
        read: u64,
        title_revision: u64,
        sessions: Vec<LocalSession>,
    ) {
        if self.with_state(|state| state.title_write_revision == title_revision) {
            self.apply_local(read, sessions);
        } else {
            self.refresh_local();
        }
    }
}
