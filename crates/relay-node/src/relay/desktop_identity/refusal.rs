//! Backoff for an identity snapshot Cloud refused (403) or could not verify
//! right now (503).

use super::DesktopIdentitySync;
use crate::relay::cloud_session::CloudAccount;
use serde_json::Value;
use std::time::{Duration, Instant};

const RETRY_BASE: Duration = Duration::from_secs(5 * 60);
const RETRY_MAX: Duration = Duration::from_secs(60 * 60);

/// One credential-bearing snapshot Cloud refused. Supervision sees it every
/// minute, so unchanged retries back off; a new sign-in, changed account, or
/// changed identity set is tried immediately.
pub(super) struct RefusedSnapshot {
    account: CloudAccount,
    generation: u64,
    body: Value,
    failures: u32,
    retry_at: Instant,
}

impl DesktopIdentitySync {
    pub(super) fn wait_for_refusal_retry(
        &self,
        account: &CloudAccount,
        generation: u64,
        body: &Value,
    ) -> bool {
        let mut refused = self
            .refused
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match refused.as_ref() {
            Some(snapshot)
                if snapshot.account == *account
                    && snapshot.generation == generation
                    && snapshot.body == *body =>
            {
                snapshot.retry_at > Instant::now()
            }
            Some(_) => {
                *refused = None;
                false
            }
            None => false,
        }
    }

    /// Remembers a 403 or 503 and returns whether this snapshot was refused for the
    /// first time. Later probes back off to an hour without repeating the
    /// activity warning.
    pub(super) fn remember_refusal(
        &self,
        account: CloudAccount,
        generation: u64,
        body: Value,
    ) -> bool {
        let mut refused = self
            .refused
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let failures = refused
            .as_ref()
            .filter(|snapshot| {
                snapshot.account == account
                    && snapshot.generation == generation
                    && snapshot.body == body
            })
            .map_or(1, |snapshot| snapshot.failures.saturating_add(1));
        let first = failures == 1;
        let wait = RETRY_BASE
            .saturating_mul(1 << failures.saturating_sub(1).min(4))
            .min(RETRY_MAX);
        *refused = Some(RefusedSnapshot {
            account,
            generation,
            body,
            failures,
            retry_at: Instant::now() + wait,
        });
        first
    }

    pub(super) fn forget_refusal(&self) {
        *self
            .refused
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    }
}
