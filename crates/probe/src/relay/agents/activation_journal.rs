//! The durable journal of why auto-activation keeps a session off the
//! relay, and its Relaycast mirror: `blocked_sessions` metadata on each
//! registration so workspace tooling sees the blockers without reading
//! the local store.

use super::*;
use crate::relay::store::{ActivationFailure, PublishedJournal};

/// How much admission budget a pass may spend, and the wait reason to
/// journal when the budget is empty. Only the pace is limited: at most
/// `AUTO_ACTIVATE_MAX_PER_WINDOW` new identities a minute, never how many
/// sessions a computer keeps on the relay.
pub(super) fn auto_activation_allowance(
    store: &mut Store,
    now: chrono::DateTime<chrono::Utc>,
) -> (usize, String) {
    let source = store.auto_activation_events.clone().unwrap_or_else(|| {
        store
            .registrations
            .iter()
            .filter(|registration| registration.auto_activated == Some(true))
            .map(|registration| registration.registered_at.clone())
            .collect()
    });
    let recent: Vec<String> = source
        .into_iter()
        .filter(|event| {
            parse_time(event).is_some_and(|event| {
                let age = now.signed_duration_since(event).num_seconds();
                (0..=AUTO_ACTIVATE_WINDOW_SECONDS).contains(&age)
            })
        })
        .collect();
    let allowance = AUTO_ACTIVATE_MAX_PER_WINDOW.saturating_sub(recent.len());
    store.auto_activation_events = (!recent.is_empty()).then_some(recent);
    (
        allowance,
        "Waiting for the auto-activation rate limit.".to_string(),
    )
}

/// One session's outcome in an auto-activation pass.
pub(super) enum ActivationAttempt {
    /// Relaycast writes are paused after an earlier failure, so no
    /// admission was spent and no registration was attempted.
    Paused(String),
    /// The admission could not be journaled; the pass stops here.
    StoreFailed(String),
    /// An admission was spent and registration was attempted.
    Attempted(Result<(), String>),
}

impl Core {
    /// One auto-activation attempt: the write-pause check, the durable
    /// admission record, then the registration itself — refunding the
    /// admission when the fleet was never reached.
    pub(super) async fn auto_activate_session(
        &self,
        session: &DiscoveredSession,
        now_text: &str,
    ) -> ActivationAttempt {
        if self.workspace().is_some_and(|workspace| {
            let scope = self.relaycast_scope(&workspace.base_url, &workspace.key);
            !self.relaycast_write_allowed(&scope)
        }) {
            return ActivationAttempt::Paused(
                "Relaycast writes to the workspace are paused after an earlier failure."
                    .to_string(),
            );
        }
        if let Err(error) = self.store.update(|store| {
            store
                .auto_activation_events
                .get_or_insert_with(Vec::new)
                .push(now_text.to_string())
        }) {
            return ActivationAttempt::StoreFailed(format!(
                "Could not save auto-activation rate state: {error}"
            ));
        }
        match self
            .register_session_with_origin(session, None, None, false, true)
            .await
        {
            Ok(_) => ActivationAttempt::Attempted(Ok(())),
            Err(error) => {
                // Fleet ownership is a preflight refusal: no Relaycast
                // registration was attempted, so it must not spend the
                // outbound admission budget while a broker is unavailable.
                if error.data.kind == ErrorKind::FleetUnavailable {
                    let _ = self.store.update(|store| {
                        if let Some(events) = store.auto_activation_events.as_mut() {
                            if let Some(index) = events.iter().rposition(|event| event == now_text)
                            {
                                events.remove(index);
                            }
                            if events.is_empty() {
                                store.auto_activation_events = None;
                            }
                        }
                    });
                }
                ActivationAttempt::Attempted(Err(error.message))
            }
        }
    }

    /// Attempt each still-unregistered session within the remaining
    /// admission budget, returning the cleared keys and the per-session
    /// blockers to journal. A `StoreFailed` outcome stops the pass: the
    /// journal itself could not be written.
    pub(super) async fn activate_sessions(
        &self,
        sessions: impl IntoIterator<Item = DiscoveredSession>,
        mut remaining: usize,
        wait_reason: &str,
        now_text: &str,
        failures: &mut Vec<String>,
    ) -> (Vec<String>, BTreeMap<String, String>) {
        let mut cleared = Vec::new();
        let mut blocked = BTreeMap::new();
        for session in sessions {
            let key = session.target.key();
            if self
                .store
                .read(|store| store.registration_for(&session.target).is_some())
            {
                continue;
            }
            if remaining == 0 {
                blocked.insert(key, wait_reason.to_string());
                continue;
            }
            match self.auto_activate_session(&session, now_text).await {
                ActivationAttempt::Paused(message) => {
                    blocked.insert(key.clone(), message.clone());
                    failures.push(format!("{key}: {message}"));
                }
                ActivationAttempt::StoreFailed(message) => {
                    failures.push(format!("{key}: {message}"));
                    blocked.insert(
                        key,
                        "Could not save auto-activation rate state.".to_string(),
                    );
                    break;
                }
                ActivationAttempt::Attempted(result) => {
                    remaining -= 1;
                    match result {
                        Ok(()) => cleared.push(key),
                        Err(message) => {
                            failures.push(format!("{key}: {message}"));
                            blocked.insert(key, message);
                        }
                    }
                }
            }
        }
        (cleared, blocked)
    }

    /// Journal the pass's outcomes and mirror the journal onto roster
    /// metadata. `published` is the activation guard's slot — the journal
    /// this daemon last confirmed on Relaycast, `None` when it has not
    /// mirrored yet — so a cleared blocker or a failed patch both leave
    /// the mirror dirty and the next pass republishes.
    pub(super) async fn record_activation_outcomes(
        &self,
        cleared: &[String],
        blocked: &BTreeMap<String, String>,
        now_text: &str,
        failures: &mut Vec<String>,
        published: &mut Option<PublishedJournal>,
    ) {
        if let Err(error) = self
            .store
            .update(|store| store.note_activation_outcomes(cleared, blocked, now_text))
        {
            failures.push(format!("Could not save auto-activation failures: {error}"));
        }
        let journal = self.store.read(|s| s.auto_activation_failures.clone());
        // Only who is blocked and why changes what is mirrored; a timestamp
        // alone never republishes it onto every agent.
        let dirty = published
            .as_ref()
            .is_none_or(|last| !same_blockers(last, &journal));
        if dirty
            && self
                .publish_activation_blockers(journal.as_ref(), failures)
                .await
        {
            *published = Some(journal);
        }
    }

    /// The auto-activation journal, mirrored onto each registration's
    /// Relaycast metadata as `blocked_sessions`, so workspace tooling can
    /// see why a session is not on the relay without reading the local
    /// store. True only when every registration accepted the patch: write
    /// pauses and failures leave the mirror dirty for the next pass.
    async fn publish_activation_blockers(
        &self,
        blocked: Option<&BTreeMap<String, ActivationFailure>>,
        failures: &mut Vec<String>,
    ) -> bool {
        let mut metadata = Map::new();
        metadata.insert(
            "blocked_sessions".into(),
            json!(blocked
                .map(|blocked| blocked
                    .iter()
                    .map(|(session, failure)| json!({
                        "session": session,
                        "reason": failure.message,
                        "since": failure.at,
                    }))
                    .collect::<Vec<_>>())
                .unwrap_or_default()),
        );
        let mut published = true;
        for name in self.store.read(|s| {
            s.registrations
                .iter()
                .map(|r| r.name.clone())
                .collect::<Vec<_>>()
        }) {
            let lock = self.roster_locks.get(&name);
            let _publishing = lock.lock().await;
            let Some(registration) = self
                .store
                .read(|s| s.registration_answering(&name).cloned())
            else {
                continue;
            };
            let Some(key) = self.key_for(&registration) else {
                continue;
            };
            let workspace = self.relaycast_scope(&registration.base_url, &key);
            if !self.relaycast_write_allowed(&workspace) {
                published = false;
                continue;
            }
            // An absent registration stays idle through the update.
            let status = Some(self.roster_status(&registration, &name));
            let result = client::update_agent_metadata(
                &registration.base_url,
                &key,
                &registration.name,
                metadata.clone(),
                status,
            )
            .await;
            self.observe_relaycast_write_result(&workspace, &result);
            if let Err(error) = result {
                published = false;
                failures.push(format!(
                    "{}: could not publish blocked sessions: {error}",
                    registration.name
                ));
            }
        }
        published
    }
}

/// Whether two journals block the same sessions for the same reasons.
fn same_blockers(a: &PublishedJournal, b: &PublishedJournal) -> bool {
    let reasons = |journal: &PublishedJournal| -> Option<Vec<(String, String)>> {
        journal.as_ref().map(|failures| {
            failures
                .iter()
                .map(|(session, failure)| (session.clone(), failure.message.clone()))
                .collect()
        })
    };
    reasons(a) == reasons(b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_timestamp_alone_does_not_change_the_mirrored_journal() {
        let journal = |message: &str, at: &str| -> PublishedJournal {
            Some(BTreeMap::from([(
                "codex:1".to_string(),
                ActivationFailure {
                    message: message.into(),
                    at: at.into(),
                },
            )]))
        };
        let first = journal("At most 20 sessions are live.", "2026-10-17T00:00:00Z");
        assert!(same_blockers(
            &first,
            &journal("At most 20 sessions are live.", "2026-10-17T00:05:00Z")
        ));
        assert!(!same_blockers(
            &first,
            &journal("Plan limit reached.", "2026-10-17T00:00:00Z")
        ));
        assert!(!same_blockers(&first, &Some(BTreeMap::new())));
        assert!(!same_blockers(&first, &None));
    }
}
