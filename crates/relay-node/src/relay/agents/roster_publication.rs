//! Roster metadata and presence publication, independent of admission policy.

use super::*;

/// Settling a registration's rejected saved workspace key.
#[path = "rejected_keys.rs"]
pub(super) mod rejected_keys;

#[cfg(test)]
#[path = "session_end_tests.rs"]
mod session_end_tests;

/// The registrations whose session runs now: the ones heartbeated and
/// pushed to. A registration marked `missing_since` keeps its name and its
/// queue, but is not present on the relay until its session runs again.
pub(crate) fn present_registration_names(store: &Store) -> Vec<String> {
    store
        .registrations
        .iter()
        .filter(|registration| registration.missing_since.is_none())
        // One name per session: only the current one is announced present.
        .map(|registration| registration.display_name().to_owned())
        .collect()
}

/// Whether `registration` leaves the relay by itself once its session has
/// been gone for the grace period: an automatic one, and one Agent Relay
/// spawned, taken over or not (its session ran for the relay; one that runs
/// again after it left is a new agent, and its unread messages go with the
/// old one, as decided for spawned agents). A hand-added one stays, without
/// a channel, so its name and queue wait for its session.
pub(crate) fn leaves_after_grace(registration: &Registration) -> bool {
    registration.auto_activated == Some(true) || registration.spawn.is_some()
}

/// Whether `registration` gets a push channel of its own: only while its
/// session runs. A spawned agent's presence is its node's.
pub(crate) fn heartbeats(registration: &Registration) -> bool {
    registration.missing_since.is_none() && registration.spawn.is_none()
}

/// How long an ended agent's registration waits for a final answer it owes
/// its sender before leaving anyway.
const REPLY_WAIT_SECONDS: i64 = 60 * 60;

/// Whether `registration` still owes a final answer and has been gone for
/// less than `REPLY_WAIT_SECONDS`: leaving now would drop the answer unsent.
fn awaits_reply(
    store: &Store,
    registration: &Registration,
    now: chrono::DateTime<chrono::Utc>,
) -> bool {
    let owed = store
        .replies
        .iter()
        .flatten()
        .any(|reply| reply.agent_id == registration.agent_id && reply.claimed != Some(true));
    owed && registration
        .missing_since
        .as_deref()
        .and_then(parse_time)
        .is_none_or(|gone| now.signed_duration_since(gone).num_seconds() < REPLY_WAIT_SECONDS)
}

impl Core {
    /// Drops the push state of every agent with no channel wanted and no
    /// registration left: one unregistered, or released while its node
    /// mirrored it, must not stay listed as connected. Returns `targets`.
    pub(super) fn forget_stale_push(&self, targets: Vec<PushTarget>) -> Vec<PushTarget> {
        let kept: HashSet<String> = self.store.read(|store| {
            store
                .registrations
                .iter()
                .filter(|registration| registration.spawn.is_some())
                .map(|registration| registration.name.clone())
                .chain(targets.iter().map(|target| target.agent.clone()))
                .collect()
        });
        self.hub
            .update(|status| status.push.retain(|name, _| kept.contains(name)));
        targets
    }

    /// The due agents that may leave now. A spawned one leaves only once
    /// this core has seen its session end: after a restart, nothing spawned
    /// is taken off before its first look. One whose final answer is still
    /// owed to its sender waits for it, for up to `REPLY_WAIT_SECONDS`.
    fn settled_leavers(&self, due: Vec<String>) -> Vec<String> {
        let ended = self.spawned_seen_ended();
        let now = chrono::Utc::now();
        let held: HashSet<String> = self.store.read(|store| {
            store
                .registrations
                .iter()
                .filter(|r| r.archived_at.is_none())
                .filter(|r| {
                    (r.spawn.is_some() && !ended.contains(&r.name)) || awaits_reply(store, r, now)
                })
                .map(|r| r.name.clone())
                .collect()
        });
        due.into_iter()
            .filter(|name| !held.contains(name))
            .collect()
    }

    /// Moves each agent whose Claude Code conversation `/clear` replaced to
    /// the conversation now running in its process, unless that one is on
    /// the relay already: the name stays with the terminal the person works
    /// in, as Claude Code's own session name and inbox do. When it happened
    /// is kept (`Registration::cleared`), so a message sent before is
    /// refused rather than delivered into the new conversation. Returns the
    /// conversations agents moved to: eligible for presence, but not to be
    /// activated again.
    pub(super) fn follow_cleared(&self, cleared: &[(Target, Target, i64)]) -> Vec<Target> {
        if cleared.is_empty() {
            return Vec::new();
        }
        let moved = self.store.update(|store| {
            let mut moved = Vec::new();
            for (old, new, at_ms) in cleared {
                let Some(mut registration) = store.registration_for(old).cloned() else {
                    continue;
                };
                if store.registration_for(new).is_some() {
                    continue;
                }
                registration.target = new.clone();
                registration.cleared = Some(*at_ms);
                registration.missing_since = None;
                moved.push((registration.display_name().to_owned(), new.clone()));
                store.update(registration);
            }
            moved
        });
        match moved {
            Ok(moved) if !moved.is_empty() => {
                let names: Vec<&str> = moved.iter().map(|(name, _)| name.as_str()).collect();
                self.hub.activity(
                    Level::Info,
                    format!(
                        "Conversation cleared: @{} moved to the new conversation in the same Claude Code session. Messages sent before /clear are not delivered into it.",
                        names.join(", @")
                    ),
                );
                self.hub.invalidated(Listing::Agents);
                moved.into_iter().map(|(_, target)| target).collect()
            }
            Ok(_) => Vec::new(),
            Err(error) => {
                self.hub.activity(
                    Level::Warning,
                    format!(
                        "Could not move an agent to its cleared Claude Code conversation: {error}"
                    ),
                );
                Vec::new()
            }
        }
    }

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
        let due = self.settled_leavers(due);
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
    pub(crate) async fn announce_pending_presence(&self) {
        self.refresh_native_continuation_capabilities();
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
            let roster_status = self.roster_status(&registration, &name);
            // A workspace out of reach has nothing to be told.
            let (base, agent) = (registration.base_url.as_str(), name.as_str());
            let (result, unreachable) = self
                .write_with_saved_key(&registration, &key, |key| async move {
                    client::update_agent_status(base, &key, agent, roster_status).await
                })
                .await;
            if result.is_ok() || unreachable {
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
