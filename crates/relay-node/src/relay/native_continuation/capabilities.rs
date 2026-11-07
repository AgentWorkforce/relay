//! Readiness is a bounded background observation, never a prerequisite for
//! unrelated queue polling or heartbeats. Submission always checks live proof.
use super::*;
use futures_util::{stream, StreamExt};
use std::collections::{BTreeMap, HashSet};
use std::time::{Duration, Instant};

const REFRESH: Duration = Duration::from_secs(15);
const MAX_AGE: Duration = Duration::from_secs(60);
const PARALLEL: usize = 4;

struct Observation {
    registration: Registration,
    account: CloudAccount,
    enabled: bool,
    at: Instant,
}

#[derive(Default)]
pub(crate) struct Capabilities {
    observations: BTreeMap<String, Observation>,
    running: bool,
    next: Option<Instant>,
}

impl Capabilities {
    pub(super) fn invalidate(&mut self) {
        self.observations.clear();
        self.next = None;
    }
}

impl Core {
    /// Single flight with bounded provider concurrency. Blocking probes keep
    /// their slot until they finish; dropping a timeout must not accumulate
    /// detached blocking work on the next presence pass.
    pub(crate) fn refresh_native_continuation_capabilities(&self) {
        let Some(core) = self.arc() else {
            return;
        };
        let Some(account) = self.native_continuation_account() else {
            return;
        };
        let registrations = self.store.read(|store| {
            store
                .registrations
                .iter()
                .filter(|row| eligible(row))
                .cloned()
                .collect::<Vec<_>>()
        });
        {
            let mut state = self
                .delivery
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let cache = &mut state.native_continuation_capabilities;
            if cache.running || cache.next.is_some_and(|next| Instant::now() < next) {
                return;
            }
            cache.running = true;
            cache.next = Some(Instant::now() + REFRESH);
        }
        tokio::spawn(async move {
            let ids: HashSet<_> = registrations
                .iter()
                .map(|row| row.agent_id.clone())
                .collect();
            stream::iter(registrations)
                .map(|registration| {
                    let core = core.clone();
                    let account = account.clone();
                    async move {
                        let enabled = core.native_continuation_capable(&registration).await;
                        core.publish_native_capability(registration, account, enabled);
                    }
                })
                .buffer_unordered(PARALLEL)
                .collect::<Vec<_>>()
                .await;
            let mut state = core
                .delivery
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let cache = &mut state.native_continuation_capabilities;
            cache.observations.retain(|id, _| ids.contains(id));
            cache.running = false;
            cache.next = Some(Instant::now() + REFRESH);
        });
    }

    fn publish_native_capability(
        &self,
        registration: Registration,
        account: CloudAccount,
        enabled: bool,
    ) {
        let enabled = enabled
            && self.native_account_current(&account)
            && self
                .native_continuation_registration(&registration)
                .as_ref()
                == Some(&registration);
        let changed = {
            let mut state = self
                .delivery
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let cache = &mut state.native_continuation_capabilities;
            let previous = cache.observations.insert(
                registration.agent_id.clone(),
                Observation {
                    registration: registration.clone(),
                    account: account.clone(),
                    enabled,
                    at: Instant::now(),
                },
            );
            previous.is_none_or(|old| {
                old.enabled != enabled || old.registration != registration || old.account != account
            })
        };
        if changed {
            self.mobile_handoff_changed(&registration);
        }
    }

    pub(crate) async fn native_continuation_metadata(
        &self,
        registration: &Registration,
    ) -> serde_json::Map<String, serde_json::Value> {
        self.refresh_native_continuation_capabilities();
        let current = self.native_continuation_registration(registration);
        let account = self.native_continuation_account();
        let enabled = self
            .delivery
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .native_continuation_capabilities
            .observations
            .get(&registration.agent_id)
            .is_some_and(|cached| {
                cached.enabled
                    && cached.at.elapsed() < MAX_AGE
                    && current.as_ref() == Some(&cached.registration)
                    && account.as_ref() == Some(&cached.account)
            });
        serde_json::json!({
            "mobile_native_continuation_enabled": enabled,
            "mobile_native_continuation_approvals": if enabled && self.codex_mobile_approvals_ready(registration) { "command_file" } else if enabled { "desktop" } else { "" },
        })
        .as_object()
        .cloned()
        .unwrap_or_default()
    }
}
