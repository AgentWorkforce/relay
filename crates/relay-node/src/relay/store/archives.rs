use super::*;
use std::sync::Arc;

fn archived_keys(target: &Target) -> impl Iterator<Item = String> {
    let mut keys = vec![target.upload_key().unwrap_or_else(|| target.key())];
    // A Claude cloud target does not retain whether it came from the Claude
    // app or Claude Code on the web. Preserve both possible identities: the
    // app-only row uses the target key, while a web row joins its history key.
    if target.kind == SessionKind::ClaudeCloud {
        let id =
            crate::relay::claude_web::web_session_id(target).unwrap_or_else(|| target.id.clone());
        keys.push(format!("{}:{id}", target.kind.source()));
    }
    keys.into_iter()
}

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
        Arc::make_mut(&mut self.archived_session_keys).extend(archived_keys(&entry.target));
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
                .flat_map(|entry| archived_keys(&entry.target))
                .collect(),
        )
    }

    /// Completes the host-aware identity added after older stores had already
    /// persisted their target-only Claude archive keys.
    pub(super) fn migrate_claude_archive_keys(&mut self) -> bool {
        let additions: Vec<_> = self
            .archived_session_keys
            .iter()
            .filter_map(|key| key.strip_prefix("claude-cloud:"))
            .map(|id| {
                let target = Target::new(SessionKind::ClaudeCloud, id);
                crate::relay::claude_web::web_session_id(&target).unwrap_or_else(|| id.to_string())
            })
            .map(|id| format!("claude:{id}"))
            .filter(|key| !self.archived_session_keys.contains(key))
            .collect();
        if additions.is_empty() {
            return false;
        }
        Arc::make_mut(&mut self.archived_session_keys).extend(additions);
        true
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
