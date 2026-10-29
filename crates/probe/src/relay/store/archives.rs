use super::*;
use std::sync::Arc;

impl Store {
    /// Marks `name` archived at `now` and records it, once: returns whether
    /// this was news. Its session is treated as ended from here on, so it
    /// is no longer heartbeated while its removal is pending.
    pub fn mark_archived(&mut self, name: &str, current_prefix: &str, now: &str) -> bool {
        let Some(registration) = self.registrations.iter_mut().find(|r| r.name == name) else {
            return false;
        };
        if registration.archived_at.is_some() {
            return false;
        }
        registration.archived_at = Some(now.to_string());
        if registration.missing_since.is_none() {
            registration.missing_since = Some(now.to_string());
        }
        let entry = ArchivedSession {
            name: registration.name.clone(),
            address: registration.direct_address(current_prefix),
            target: registration.target.clone(),
            title: registration.title.clone(),
            archived_at: now.to_string(),
        };
        if self.archived_session_keys.is_empty() {
            self.archived_session_keys = self.complete_archived_keys();
        }
        Arc::make_mut(&mut self.archived_session_keys).insert(
            entry
                .target
                .upload_key()
                .unwrap_or_else(|| entry.target.key()),
        );
        let list = self.archived_sessions.get_or_insert_with(Vec::new);
        list.insert(0, entry);
        list.truncate(ARCHIVED_SESSIONS_KEPT);
        true
    }

    pub fn complete_archived_keys(&self) -> Arc<BTreeSet<String>> {
        if !self.archived_session_keys.is_empty() || self.archived_sessions.is_none() {
            return self.archived_session_keys.clone();
        }
        // Backfill only the bounded legacy recent list. The next normal save
        // persists its identities; ordinary query reads never mutate the store.
        Arc::new(
            self.archived_sessions
                .iter()
                .flatten()
                .map(|entry| {
                    entry
                        .target
                        .upload_key()
                        .unwrap_or_else(|| entry.target.key())
                })
                .collect(),
        )
    }

    pub(super) fn merged_archive_keys(ours: &Store, theirs: &Store) -> Arc<BTreeSet<String>> {
        let ours = ours.complete_archived_keys();
        let theirs = theirs.complete_archived_keys();
        if Arc::ptr_eq(&ours, &theirs) || ours.is_superset(&theirs) {
            ours
        } else if theirs.is_superset(&ours) {
            theirs
        } else {
            Arc::new(ours.union(&theirs).cloned().collect())
        }
    }
}
