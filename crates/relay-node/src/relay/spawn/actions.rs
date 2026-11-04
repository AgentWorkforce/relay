//! Serializing repeated spawn invocations and release with a running launch.

use super::invoke::SpawnError;
use super::wire::{HarnessId, SpawnRequest};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};

/// Locks live only as long as an action holds or waits for them. Completed
/// invocation IDs do not accumulate in the ledger for the core's lifetime.
#[derive(Default)]
pub(super) struct ActionLocks(
    Mutex<HashMap<String, Weak<tokio::sync::Mutex<Option<CompletedSpawn>>>>>,
);

impl ActionLocks {
    pub(super) fn get(&self, key: String) -> Arc<tokio::sync::Mutex<Option<CompletedSpawn>>> {
        let mut locks = self.0.lock().unwrap_or_else(|error| error.into_inner());
        locks.retain(|_, lock| lock.strong_count() > 0);
        match locks.get(&key).and_then(Weak::upgrade) {
            Some(lock) => lock,
            None => {
                let lock = Arc::new(tokio::sync::Mutex::new(None));
                locks.insert(key, Arc::downgrade(&lock));
                lock
            }
        }
    }
}

/// Concurrent replays keep the first result alive even if a release removes
/// the registration before they resume. A completed failure is shared too.
pub(super) struct CompletedSpawn {
    pub(super) name: String,
    pub(super) harness: HarnessId,
    pub(super) result: Result<Value, SpawnError>,
}

impl CompletedSpawn {
    pub(super) fn replay(&self, request: &SpawnRequest) -> Result<Value, SpawnError> {
        if self.name != request.name || self.harness != request.harness {
            return Err(format!(
                "spawn_invalid_input: invocation {} already spawned @{} ({})",
                request.invocation_id,
                self.name,
                self.harness.name()
            )
            .into());
        }
        self.result.clone()
    }
}
