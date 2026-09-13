//! Bounded local custody for fleet action outcomes. A socket flush is the
//! settlement boundary here; this is not a server receipt or crash guarantee.
use crate::fleet_wire::{ActionResult, ActionResultError, ActionResultPayload, FLEET_WIRE_VERSION};
use std::{
    collections::{HashMap, VecDeque},
    sync::Mutex,
};
use tokio::sync::Notify;

const ORDINARY_LIMIT: usize = 256;
const MAX_RESULT_BYTES: usize = 64 * 1024;
const MAX_INVOCATION_ID_BYTES: usize = 4096;

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Admission {
    Accepted,
    Rejected,
    Full,
    Duplicate,
    Invalid,
}
#[derive(Default)]
struct State {
    entries: HashMap<String, Entry>,
    ready: VecDeque<String>,
    rejection: Option<String>,
}
struct Entry {
    result: Option<ActionResult>,
}
#[derive(Default)]
pub(crate) struct FleetResponses {
    state: Mutex<State>,
    changed: Notify,
    capacity_changed: Notify,
    stop_changed: Notify,
    connected: std::sync::atomic::AtomicBool,
    shutdown: std::sync::atomic::AtomicBool,
}
impl FleetResponses {
    pub(crate) fn reserve(&self, id: &str) -> Admission {
        if id.is_empty() || id.len() > MAX_INVOCATION_ID_BYTES {
            return Admission::Invalid;
        }
        let mut state = self.state.lock().unwrap();
        if state.entries.contains_key(id) {
            return Admission::Duplicate;
        }
        let ordinary = state.entries.len() - usize::from(state.rejection.is_some());
        let admission = if ordinary < ORDINARY_LIMIT {
            Admission::Accepted
        } else if state.rejection.is_none() {
            state.rejection = Some(id.into());
            Admission::Rejected
        } else {
            return Admission::Full;
        };
        state.entries.insert(id.into(), Entry { result: None });
        admission
    }
    pub(crate) fn can_admit(&self) -> bool {
        let state = self.state.lock().unwrap();
        state.entries.len() < ORDINARY_LIMIT || state.rejection.is_none()
    }
    /// A reservation is acquired before any validation or mutation. Completion
    /// transfers that same slot to FIFO output; it never waits for a channel.
    pub(crate) fn complete(&self, mut result: ActionResult) {
        if serde_json::to_vec(&result).map_or(true, |bytes| bytes.len() > MAX_RESULT_BYTES) {
            result.result = ActionResultPayload::Error(ActionResultError {
                error: "action_result_too_large".into(),
            });
        }
        let mut state = self.state.lock().unwrap();
        let entry = state
            .entries
            .get_mut(&result.invocation_id)
            .expect("fleet result must own an admission reservation");
        if entry.result.is_some() {
            return;
        } // one terminal decision per admission
        let id = result.invocation_id.clone();
        entry.result = Some(result);
        state.ready.push_back(id);
        drop(state);
        self.changed.notify_one();
    }
    pub(crate) fn front(&self) -> Option<ActionResult> {
        let state = self.state.lock().unwrap();
        state
            .ready
            .front()
            .and_then(|id| state.entries[id].result.clone())
    }
    /// Only the sole node socket writer may settle the FIFO head, after its
    /// successful flush. Failed/ambiguous writes keep the original outcome.
    pub(crate) fn flushed(&self, id: &str) {
        let mut state = self.state.lock().unwrap();
        assert_eq!(state.ready.front().map(String::as_str), Some(id));
        state.ready.pop_front();
        state.entries.remove(id);
        if state.rejection.as_deref() == Some(id) {
            state.rejection = None;
        }
        drop(state);
        self.capacity_changed.notify_one();
    }
    pub(crate) async fn changed(&self) {
        self.changed.notified().await;
    }
    pub(crate) async fn capacity_changed(&self) {
        self.capacity_changed.notified().await;
    }
    pub(crate) async fn stopped(&self) {
        if !self.stopping() {
            self.stop_changed.notified().await;
        }
    }
    pub(crate) fn connected(&self) -> bool {
        self.connected.load(std::sync::atomic::Ordering::Acquire)
    }
    pub(crate) fn set_connected(&self, connected: bool) {
        self.connected
            .store(connected, std::sync::atomic::Ordering::Release);
    }
    pub(crate) fn stop(&self) {
        self.shutdown
            .store(true, std::sync::atomic::Ordering::Release);
        self.stop_changed.notify_one();
    }
    pub(crate) fn stopping(&self) -> bool {
        self.shutdown.load(std::sync::atomic::Ordering::Acquire)
    }
    pub(crate) fn cancel_pending(&self) {
        let ids: Vec<_> = self
            .state
            .lock()
            .unwrap()
            .entries
            .iter()
            .filter(|(_, entry)| entry.result.is_none())
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            self.complete(ActionResult {
                v: FLEET_WIRE_VERSION,
                id: None,
                invocation_id: id,
                result: ActionResultPayload::Error(ActionResultError {
                    error: "broker_shutdown_before_completion".into(),
                }),
            });
        }
    }
    pub(crate) fn checkpoint(&self, root: &std::path::Path) -> std::io::Result<()> {
        use std::io::Write;
        let results = self.unresolved();
        if results.is_empty() {
            return Ok(());
        }
        std::fs::create_dir_all(root)?;
        // Unique immutable evidence: never overwrite an earlier unresolved run.
        let path = root.join(format!(
            "fleet-unconfirmed-results-{}.json",
            uuid::Uuid::new_v4()
        ));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&path)?;
        file.write_all(&serde_json::to_vec(&results)?)?;
        file.sync_all()?;
        tracing::warn!(count = results.len(), path = %path.display(), "retained unconfirmed fleet outcomes; server settlement/reconciliation is not proven");
        Ok(())
    }
    pub(crate) fn unresolved(&self) -> Vec<ActionResult> {
        let state = self.state.lock().unwrap();
        state
            .ready
            .iter()
            .filter_map(|id| state.entries[id].result.clone())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn result(id: &str) -> ActionResult {
        ActionResult {
            v: FLEET_WIRE_VERSION,
            id: None,
            invocation_id: id.into(),
            result: ActionResultPayload::Error(ActionResultError {
                error: "original".into(),
            }),
        }
    }
    #[tokio::test]
    async fn bounded_reservations_preserve_terminal_order_and_rejection_progress() {
        let queue = FleetResponses::default();
        for i in 0..ORDINARY_LIMIT {
            assert_eq!(queue.reserve(&format!("pending-{i}")), Admission::Accepted);
        }
        assert_eq!(queue.reserve("reject"), Admission::Rejected);
        assert_eq!(queue.reserve("held"), Admission::Full);
        queue.complete(result("reject"));
        assert_eq!(
            queue.front().unwrap().invocation_id,
            "reject",
            "ready rejection must not wait behind unfinished work"
        );
        assert_eq!(queue.reserve("pending-0"), Admission::Duplicate);
        queue.flushed("reject");
        assert_eq!(queue.reserve("next-reject"), Admission::Rejected);
        queue.complete(result("pending-2"));
        queue.complete(result("pending-0"));
        assert_eq!(queue.front().unwrap().invocation_id, "pending-2");
        assert_eq!(
            queue.front().unwrap().invocation_id,
            "pending-2",
            "failed writer leaves the original head owned"
        );
        queue.flushed("pending-2");
        assert_eq!(queue.front().unwrap().invocation_id, "pending-0");
        assert_eq!(queue.reserve("new"), Admission::Accepted);
        queue.cancel_pending();
        assert_eq!(queue.unresolved().len(), ORDINARY_LIMIT + 1);
        let directory = tempfile::tempdir().unwrap();
        queue.checkpoint(directory.path()).unwrap();
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
        queue.stop();
        tokio::time::timeout(std::time::Duration::from_millis(100), queue.stopped())
            .await
            .unwrap();
    }
    #[test]
    fn result_bytes_are_bounded_without_losing_correlation() {
        let queue = FleetResponses::default();
        assert_eq!(
            queue.reserve(&"i".repeat(MAX_INVOCATION_ID_BYTES + 1)),
            Admission::Invalid
        );
        assert_eq!(queue.reserve("original-id"), Admission::Accepted);
        let mut response = result("original-id");
        response.result = ActionResultPayload::Error(ActionResultError {
            error: "x".repeat(MAX_RESULT_BYTES + 1),
        });
        queue.complete(response);
        queue.complete(result("original-id"));
        assert_eq!(queue.unresolved().len(), 1);
        assert!(serde_json::to_string(&queue.front().unwrap())
            .unwrap()
            .contains("action_result_too_large"));
    }
}
