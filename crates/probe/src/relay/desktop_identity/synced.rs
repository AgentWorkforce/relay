//! The identity snapshot Cloud last accepted. Supervision asks for a sync
//! every minute, and Cloud verifies every identity against Relaycast on each
//! one, so an unchanged snapshot is sent again only after `REFRESH`; a new
//! sign-in, changed account, or changed identity set is sent at once.

use super::DesktopIdentitySync;
use crate::relay::cloud_session::CloudAccount;
use serde_json::Value;
use std::time::{Duration, Instant};

const REFRESH: Duration = Duration::from_secs(30 * 60);

pub(super) struct SyncedSnapshot {
    account: CloudAccount,
    generation: u64,
    body: Value,
    at: Instant,
}

impl DesktopIdentitySync {
    /// Whether Cloud already holds exactly this snapshot, accepted less than
    /// `REFRESH` ago.
    pub(super) fn already_synced(
        &self,
        account: &CloudAccount,
        generation: u64,
        body: &Value,
    ) -> bool {
        self.synced
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .as_ref()
            .is_some_and(|snapshot| {
                snapshot.account == *account
                    && snapshot.generation == generation
                    && snapshot.body == *body
                    && snapshot.at.elapsed() < REFRESH
            })
    }

    pub(super) fn remember_synced(&self, account: CloudAccount, generation: u64, body: Value) {
        *self
            .synced
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(SyncedSnapshot {
            account,
            generation,
            body,
            at: Instant::now(),
        });
    }

    pub(super) fn forget_synced(&self) {
        *self
            .synced
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    }
}
