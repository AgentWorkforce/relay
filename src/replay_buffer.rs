//! Ring buffer for WS event replay on reconnect.
//!
//! Stores recent broadcast events with monotonic sequence numbers so that
//! reconnecting WS clients can request events they missed via `?since_seq=N`.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde_json::Value;
use tokio::sync::RwLock;

/// Default maximum number of events retained in the replay buffer.
pub const DEFAULT_REPLAY_CAPACITY: usize = 1000;

/// A single buffered event with its sequence number and JSON payload.
#[derive(Debug, Clone)]
pub struct ReplayEntry {
    pub seq: u64,
    pub event: Value,
}

/// Thread-safe ring buffer that stores recent broadcast events.
#[derive(Clone)]
pub struct ReplayBuffer {
    inner: Arc<RwLock<ReplayBufferInner>>,
    seq_counter: Arc<AtomicU64>,
}

struct ReplayBufferInner {
    entries: VecDeque<ReplayEntry>,
    capacity: usize,
}

impl ReplayBuffer {
    /// Create a new replay buffer with the given capacity.
    pub fn new(capacity: usize) -> Self {
        Self {
            inner: Arc::new(RwLock::new(ReplayBufferInner {
                entries: VecDeque::with_capacity(capacity),
                capacity,
            })),
            seq_counter: Arc::new(AtomicU64::new(0)),
        }
    }

    /// Push a new event into the buffer. Returns `(seq, event_with_seq)`.
    /// The event JSON is annotated with a `"seq"` field before storage.
    pub async fn push(&self, mut event: Value) -> anyhow::Result<(u64, Value)> {
        let mut inner = self.inner.write().await;
        let seq = self.seq_counter.fetch_add(1, Ordering::Relaxed) + 1;
        event
            .as_object_mut()
            .ok_or_else(|| anyhow::anyhow!("broadcast event must be a JSON object"))?
            .insert("seq".to_string(), serde_json::json!(seq));

        let entry = ReplayEntry {
            seq,
            event: event.clone(),
        };

        if inner.entries.len() >= inner.capacity {
            inner.entries.pop_front();
        }
        inner.entries.push_back(entry);

        Ok((seq, event))
    }

    /// Retrieve all events with seq > since_seq.
    /// Returns `(events, had_gap)` where `had_gap` is true if the requested
    /// seq is older than the oldest event in the buffer.
    pub async fn replay_since(&self, since_seq: u64) -> (Vec<ReplayEntry>, Option<u64>) {
        let inner = self.inner.read().await;
        let oldest_seq = inner.entries.front().map(|e| e.seq);

        let gap = match oldest_seq {
            Some(oldest) if since_seq < oldest => Some(oldest),
            _ => None,
        };

        let events: Vec<ReplayEntry> = inner
            .entries
            .iter()
            .filter(|e| e.seq > since_seq)
            .cloned()
            .collect();

        (events, gap)
    }

    /// Current sequence counter value (the last assigned seq).
    pub fn current_seq(&self) -> u64 {
        self.seq_counter.load(Ordering::Relaxed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn buffer_stores_events_and_respects_capacity() {
        let buf = ReplayBuffer::new(3);

        buf.push(json!({"kind": "a"})).await.unwrap();
        buf.push(json!({"kind": "b"})).await.unwrap();
        buf.push(json!({"kind": "c"})).await.unwrap();
        buf.push(json!({"kind": "d"})).await.unwrap();

        let (events, _gap) = buf.replay_since(0).await;
        // Capacity is 3, so "a" (seq=1) should be evicted
        assert_eq!(events.len(), 3);
        assert_eq!(events[0].seq, 2);
        assert_eq!(events[1].seq, 3);
        assert_eq!(events[2].seq, 4);
    }

    #[tokio::test]
    async fn oldest_events_evicted_when_full() {
        let buf = ReplayBuffer::new(2);

        buf.push(json!({"kind": "first"})).await.unwrap();
        buf.push(json!({"kind": "second"})).await.unwrap();
        buf.push(json!({"kind": "third"})).await.unwrap();

        let (events, _) = buf.replay_since(0).await;
        assert_eq!(events.len(), 2);
        assert_eq!(
            events[0].event.get("kind").unwrap().as_str().unwrap(),
            "second"
        );
        assert_eq!(
            events[1].event.get("kind").unwrap().as_str().unwrap(),
            "third"
        );
    }

    #[tokio::test]
    async fn replay_returns_correct_subset_for_given_since_seq() {
        let buf = ReplayBuffer::new(10);

        for i in 0..5 {
            buf.push(json!({"kind": format!("event_{}", i)}))
                .await
                .unwrap();
        }

        // Request events after seq 3
        let (events, gap) = buf.replay_since(3).await;
        assert!(gap.is_none());
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].seq, 4);
        assert_eq!(events[1].seq, 5);
    }

    #[tokio::test]
    async fn replay_with_stale_seq_returns_full_buffer_and_gap_indicator() {
        let buf = ReplayBuffer::new(3);

        for i in 0..5 {
            buf.push(json!({"kind": format!("event_{}", i)}))
                .await
                .unwrap();
        }

        // since_seq=1 is older than oldest in buffer (seq=3)
        let (events, gap) = buf.replay_since(1).await;
        assert!(gap.is_some());
        assert_eq!(gap.unwrap(), 3); // oldest available is seq 3
        assert_eq!(events.len(), 3);
    }

    #[tokio::test]
    async fn seq_numbers_are_monotonically_increasing() {
        let buf = ReplayBuffer::new(100);

        let (s1, _) = buf.push(json!({"kind": "a"})).await.unwrap();
        let (s2, _) = buf.push(json!({"kind": "b"})).await.unwrap();
        let (s3, _) = buf.push(json!({"kind": "c"})).await.unwrap();

        assert_eq!(s1, 1);
        assert_eq!(s2, 2);
        assert_eq!(s3, 3);
        assert!(s1 < s2);
        assert!(s2 < s3);
    }

    #[tokio::test]
    async fn events_include_seq_field_in_json() {
        let buf = ReplayBuffer::new(10);

        buf.push(json!({"kind": "test"})).await.unwrap();

        let (events, _) = buf.replay_since(0).await;
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event.get("seq").unwrap().as_u64().unwrap(), 1);
        assert_eq!(
            events[0].event.get("kind").unwrap().as_str().unwrap(),
            "test"
        );
    }

    #[tokio::test]
    async fn replay_since_current_seq_returns_empty() {
        let buf = ReplayBuffer::new(10);

        buf.push(json!({"kind": "a"})).await.unwrap();
        buf.push(json!({"kind": "b"})).await.unwrap();

        let (events, gap) = buf.replay_since(2).await;
        assert!(gap.is_none());
        assert!(events.is_empty());
    }
}
