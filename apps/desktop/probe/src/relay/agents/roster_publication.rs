//! Roster metadata and presence publication, independent of admission policy.

use super::*;

impl Core {
    /// Commit titles and lifecycle from one inventory together, then notify
    /// clients only after the new titles are durably stored.
    pub(super) fn reconcile_discovered_registrations(
        &self,
        sessions: &[DiscoveredSession],
        revision: u64,
        eligible: &HashSet<Target>,
        live: &HashSet<Target>,
        now: chrono::DateTime<chrono::Utc>,
    ) -> Result<Vec<String>, crate::relay::store::StoreError> {
        let mut titles_changed = false;
        let due = self.store.update(|store| {
            titles_changed = self.refresh_discovered_titles(store, sessions, revision);
            reconcile_lifecycle(store, eligible, live, now)
        })?;
        if titles_changed {
            self.hub.invalidated(Listing::Agents);
        }
        // Runtime changes must clear previously published mobile readiness
        // even when the person sends no further message to this session.
        self.refresh_mobile_claude_plugin();
        let _ = self.prune_mobile_handoff_runtimes();
        Ok(due)
    }

    /// Native setters advance the revision under the same store lock. A scan
    /// begun before a native rename retries title discovery on the next pass.
    fn refresh_discovered_titles(
        &self,
        store: &mut Store,
        sessions: &[DiscoveredSession],
        revision: u64,
    ) -> bool {
        if self
            .roster_revision
            .load(std::sync::atomic::Ordering::SeqCst)
            != revision
        {
            return false;
        }
        let mut changed = false;
        for session in sessions {
            changed |= aliases::update_registered_title(
                store,
                session.target.kind.source(),
                &session.target.id,
                &session.title,
            );
        }
        changed
    }

    /// Tells Relaycast every presence change it has not confirmed yet. A
    /// change for a registration that is gone is dropped; one that fails
    /// stays pending for the next pass.
    pub(super) async fn announce_pending_presence(&self) {
        let pending: Vec<(String, &'static str)> = self
            .presence_pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter()
            .map(|(name, status)| (name.clone(), *status))
            .collect();
        for (name, _) in pending {
            let lock = self.roster_locks.get(&name);
            let _publishing = lock.lock().await;
            let Some(status) = self
                .presence_pending
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .get(&name)
                .copied()
            else {
                continue;
            };
            let registration = self
                .store
                .read(|s| s.registration_answering(&name).cloned());
            let Some(registration) = registration else {
                self.presence_pending
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .remove(&name);
                continue;
            };
            let Some(key) = self.key_for(&registration) else {
                continue;
            };
            let workspace = self.relaycast_scope(&registration.base_url, &key);
            if !self.relaycast_write_allowed(&workspace) {
                continue;
            }
            let result = client::update_agent_status(
                &registration.base_url,
                &key,
                &name,
                self.roster_status(&registration, &name),
            )
            .await;
            self.observe_relaycast_write_result(&workspace, &result);
            if result.is_ok() {
                let mut pending = self
                    .presence_pending
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                if pending.get(&name) == Some(&status) {
                    pending.remove(&name);
                }
            }
        }
    }
}
