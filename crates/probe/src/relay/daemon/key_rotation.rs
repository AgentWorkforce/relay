//! Workspace-key rotation bookkeeping for the refresh loop: a displaced
//! key's saved copies (registrations, pending cleanups) follow a verified
//! rotation even across failed verifies, daemon stops and restarts.

use super::Core;
use crate::relay::state::{now_ms, Level, Verification, WorkspaceStatus};
use crate::relay::store::PendingKeyMigration;
use crate::relay::workspace::Workspace;
use std::time::Duration;

/// How long a verified workspace key is trusted before the refresh loop
/// asks Relaycast about it again. Bounds how long a key revoked after it
/// verified (a rotation whose grace lapsed) goes unnoticed when nothing else
/// the core does with it is refused; one workspace GET per interval.
pub(crate) const REVERIFY_VERIFIED_AFTER: Duration = Duration::from_secs(5 * 60);

impl Core {
    /// Rediscovers the workspace. A different key or origin replaces the
    /// status and is verified; an unchanged one is verified again when
    /// Relaycast could not be reached last time, when a call was refused
    /// with it since, or when its last verification is older than
    /// `REVERIFY_VERIFIED_AFTER` — so a key revoked after it verified (a
    /// rotation whose grace lapsed) is recovered without a manual verify.
    pub async fn refresh_workspace(&self) -> WorkspaceStatus {
        let stale = self.verification_is_stale(now_ms());
        // Captured before rediscovery replaces the workspace and resets the
        // status: the displaced key and the workspace id it last VERIFIED to
        // — a discovery-recorded id is a claim, not a verification, so it
        // cannot anchor a migration.
        let displaced = self.workspace.lock().ok().and_then(|w| w.clone());
        let prior = self.status().workspace;
        let prior_workspace_id = match prior.verification {
            Verification::Verified => prior.workspace_id,
            _ => None,
        };
        if self.rediscover_workspace() || stale {
            // Recorded before the network call: a failed verify — or the
            // daemon stopping mid-rotation — leaves the displaced key's saved
            // copies owed a rewrite a later refresh can still perform.
            self.record_pending_key_migration(displaced.as_ref(), prior_workspace_id.as_deref());
            if let Ok(status) = self.verify_workspace().await {
                self.resolve_pending_key_migration(status.workspace_id.as_deref());
            }
        } else if matches!(self.status().workspace.verification, Verification::Verified) {
            // An unchanged, already-verified refresh still resolves a
            // recorded migration whose earlier rewrite could not be saved.
            let verified_id = self.status().workspace.workspace_id;
            self.resolve_pending_key_migration(verified_id.as_deref());
        }
        self.status().workspace
    }

    /// Whether the current key verified longer than
    /// `REVERIFY_VERIFIED_AFTER` before `now`. Only a verified key counts:
    /// a refused one waits for a new key or a sign-in, so a revoked key is
    /// never re-checked in a loop.
    pub(super) fn verification_is_stale(&self, now: i64) -> bool {
        let workspace = self.status().workspace;
        workspace.verification == Verification::Verified
            && workspace.checked_at_ms.is_none_or(|checked| {
                now.saturating_sub(checked) >= REVERIFY_VERIFIED_AFTER.as_millis() as i64
            })
    }

    /// When discovery produced a new key at the SAME origin while the
    /// displaced one had verified to a workspace, a rotation may be
    /// underway: record the displaced key and the workspace id its
    /// replacement must verify to. A different origin or an unchanged key
    /// is not a rotation, and a displaced key that never verified cannot be
    /// told from a switch — nothing is recorded for either.
    ///
    /// The record is remembered, not just updated: a failed save must not
    /// drop the displaced key's context, so the record stays in the
    /// in-memory store until a later write makes it durable.
    pub(super) fn record_pending_key_migration(
        &self,
        displaced: Option<&Workspace>,
        prior_workspace_id: Option<&str>,
    ) {
        let (Some(displaced), Some(workspace_id)) = (displaced, prior_workspace_id) else {
            return;
        };
        let current = self.workspace.lock().ok().and_then(|w| w.clone());
        let Some(current) = current else { return };
        if current.base_url != displaced.base_url || current.key == displaced.key {
            return;
        }
        let migration = PendingKeyMigration {
            base_url: displaced.base_url.clone(),
            old_key: displaced.key.clone(),
            workspace_id: workspace_id.to_string(),
        };
        if let Err(error) = self
            .store
            .remember(|store| store.record_pending_key_migration(migration))
        {
            self.hub.activity(
                Level::Warning,
                format!("Could not record the pending workspace-key migration: {error}"),
            );
        }
    }

    /// Applies recorded rotations once the replacement key has verified to
    /// the SAME workspace id each displaced key belonged to: the saved
    /// copies (registrations, pending cleanups) are rewritten before the
    /// superseded keys' grace lapses. Every matching record resolves in one
    /// store update — an A→B then B→C chain rewrites A's and B's copies
    /// together — and a record for another origin stays owed until that
    /// origin is current again, as does a record whose workspace id the
    /// current key has not verified to. A record whose displaced key is
    /// current again is dropped: the copies it would have rewritten are
    /// correct already. The rewrite and the clears are one update, so a
    /// failed save rolls everything back for the next refresh.
    pub(super) fn resolve_pending_key_migration(&self, verified_workspace_id: Option<&str>) {
        let owed = self
            .store
            .read(|store| store.pending_key_migrations.clone())
            .unwrap_or_default();
        if owed.is_empty() {
            return;
        }
        let current = self.workspace.lock().ok().and_then(|w| w.clone());
        let Some(current) = current else {
            // Signed out mid-rotation: the records stay until a sign-in.
            return;
        };

        let mut resolvable = Vec::new();
        let mut re_adopted = Vec::new();
        for entry in owed {
            if entry.base_url != current.base_url {
                continue;
            }
            if current.key == entry.old_key {
                re_adopted.push(entry);
            } else if verified_workspace_id == Some(entry.workspace_id.as_str()) {
                resolvable.push(entry);
            }
        }
        let settled: Vec<_> = resolvable.iter().chain(&re_adopted).cloned().collect();
        if settled.is_empty() {
            return;
        }

        let new_key = current.key.clone();
        match self.store.update(|store| {
            let mut migrated = 0;
            for entry in &resolvable {
                migrated += store.rotate_workspace_key(&entry.base_url, &entry.old_key, &new_key);
            }
            store.clear_pending_key_migrations(&settled);
            migrated
        }) {
            Ok(0) => {}
            Ok(count) => self.hub.activity(
                Level::Info,
                format!(
                    "Migrated {count} saved key copies to the rotated Agent Relay workspace key."
                ),
            ),
            Err(error) => self.hub.activity(
                Level::Warning,
                format!("Could not save rotated workspace-key copies: {error}"),
            ),
        }
    }
}
