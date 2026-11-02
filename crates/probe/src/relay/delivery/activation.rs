//! When a delivery pass reconciles automatic activation: only when what it
//! decides from changed, so an unchanged pass scans no process.

use super::*;
use crate::relay::sessions::DiscoveredSession;

/// What automatic activation decides from: the sessions discovery last
/// published (every field but when each last wrote: its target, title,
/// folder, host, holder and whether it runs), the agent store, and the
/// registered sessions recorded as archived.
#[derive(PartialEq)]
pub(super) struct ActivationInputs {
    sessions: Vec<DiscoveredSession>,
    store: Store,
    archived: Vec<Target>,
}

impl Core {
    /// The inputs automatic activation decides from, as they are now: the
    /// sessions discovery last published, the agent store, and which of the
    /// registered sessions their providers record as archived (a catalog
    /// read, not a process scan).
    async fn activation_inputs(&self) -> ActivationInputs {
        let sessions = self
            .session_snapshot
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .1
            .iter()
            .map(|row| DiscoveredSession {
                updated_at_ms: None,
                ..row.clone()
            })
            .collect();
        let store = self.store.snapshot();
        let targets: Vec<Target> = store
            .registrations
            .iter()
            .filter(|r| r.archived_at.is_none())
            .map(|r| r.target.clone())
            .collect();
        let directory = self.plugins.sessions.clone();
        let mut archived: Vec<Target> =
            tokio::task::spawn_blocking(move || directory.archived(&targets).into_iter().collect())
                .await
                .unwrap_or_default();
        archived.sort_by_key(Target::key);
        ActivationInputs {
            sessions,
            store,
            archived,
        }
    }

    /// Whether a delivery pass reconciles sessions: when discovery
    /// published a change, the store changed or a registered session was
    /// archived since the last reconciliation, and once per refresh
    /// interval for the grace periods that end with time alone. An unchanged
    /// pass scans no process.
    async fn activation_due(&self) -> bool {
        let inputs = self.activation_inputs().await;
        let state = self
            .delivery
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        state.last_activation.as_ref().is_none_or(|(at, seen)| {
            *seen != inputs || at.elapsed() >= self.config.rediscover_every
        })
    }

    /// Automatic activation, reporting a changed set of failures once.
    /// Reconciles automatic activation when its inputs changed. Otherwise
    /// activity and unconfirmed presence keep their own cadence over the
    /// sessions discovery last published.
    pub(super) async fn reconcile_sessions_if_due(self: &Arc<Core>) {
        if self.activation_due().await {
            return self.reconcile_sessions().await;
        }
        let published = self
            .session_snapshot
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .1
            .clone();
        self.refresh_activity(&published).await;
        self.announce_pending_presence().await;
    }

    async fn reconcile_sessions(self: &Arc<Core>) {
        let inputs = self.activation_inputs().await;
        let failures = self.activate_new_sessions().await;
        let report = {
            let mut state = self
                .delivery
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            state.last_activation = Some((Instant::now(), inputs));
            let changed = state.last_activation_failures != failures;
            state.last_activation_failures = failures.clone();
            changed && !failures.is_empty()
        };
        if report {
            self.hub.activity(
                Level::Warning,
                format!(
                    "Could not put new sessions on the relay: {}",
                    failures.join("; ")
                ),
            );
        }
    }
}
