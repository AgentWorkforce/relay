//! Ring buffer for WS event replay on reconnect.
//!
//! Stores recent broadcast events with monotonic sequence numbers so that
//! reconnecting WS clients can request events they missed via `?since_seq=N`.

use std::collections::HashMap;
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
///
/// The buffer is purely capacity-bound FIFO and **kind-agnostic**: it has no
/// notion of "important" vs. "ephemeral" events, so every call to [`push`]
/// counts equally against the shared `capacity`. That means callers are
/// responsible for keeping high-frequency, replay-insensitive event kinds
/// (e.g. `worker_stream`, which is raw per-chunk PTY output re-rendered from
/// the terminal's own separate buffer, not something a reconnecting
/// dashboard client needs replayed) out of this buffer entirely — otherwise a
/// burst of them can evict low-frequency, durability-sensitive events (e.g.
/// `relay_inbound`) before a reconnecting client ever gets a chance to
/// request them. See `listen_api::broadcast_if_relevant` for the filtering
/// policy the broker's dashboard WS pipeline applies before calling
/// [`push`].
///
/// [`push`]: ReplayBuffer::push
#[derive(Clone)]
pub struct ReplayBuffer {
    inner: Arc<RwLock<ReplayBufferInner>>,
    seq_counter: Arc<AtomicU64>,
}

struct ReplayBufferInner {
    entries: VecDeque<ReplayEntry>,
    agent_event_entries: HashMap<String, VecDeque<Value>>,
    agent_event_high_water: HashMap<String, u64>,
    capacity: usize,
}

#[derive(Debug, Clone)]
pub struct AgentEventReplaySnapshot {
    pub events: Vec<Value>,
    pub high_water_sequence: u64,
    pub oldest_available_sequence: Option<u64>,
    pub gap: bool,
}

impl ReplayBuffer {
    /// Create a new replay buffer with the given capacity.
    pub fn new(capacity: usize) -> Self {
        Self {
            inner: Arc::new(RwLock::new(ReplayBufferInner {
                entries: VecDeque::with_capacity(capacity),
                agent_event_entries: HashMap::new(),
                agent_event_high_water: HashMap::new(),
                capacity,
            })),
            seq_counter: Arc::new(AtomicU64::new(0)),
        }
    }

    /// Push a new event into the buffer. Returns `(seq, event_with_seq)`.
    /// The event JSON is annotated with a `"seq"` field before storage.
    pub async fn push(&self, mut event: Value) -> anyhow::Result<(u64, Value)> {
        let mut inner = self.inner.write().await;
        let event_kind = event.get("kind").and_then(Value::as_str);
        if matches!(event_kind, Some("agent_released" | "agent_exited")) {
            if let Some(name) = event.get("name").and_then(Value::as_str) {
                inner.agent_event_entries.remove(name);
                inner.agent_event_high_water.remove(name);
            }
        }
        if event_kind == Some("agent_event") {
            let name = event
                .get("name")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("agent event missing agent name"))?
                .to_string();
            let agent_event_sequence = event
                .get("sequence")
                .and_then(Value::as_u64)
                .filter(|sequence| *sequence > 0)
                .ok_or_else(|| anyhow::anyhow!("agent event missing positive sequence"))?;
            if inner
                .agent_event_high_water
                .get(&name)
                .is_some_and(|high_water| agent_event_sequence <= *high_water)
            {
                anyhow::bail!(
                    "agent-event sequence for '{name}' is not monotonic: {agent_event_sequence}"
                );
            }
            inner
                .agent_event_high_water
                .insert(name.clone(), agent_event_sequence);
            let capacity = inner.capacity;
            let history = inner.agent_event_entries.entry(name).or_default();
            if history.len() >= capacity {
                history.pop_front();
            }
            history.push_back(event.clone());
        }
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

    /// Clear the agent-event replay state belonging to a previous runtime
    /// generation of `name`.
    ///
    /// Callers must invoke this before launching the replacement worker. A
    /// later `agent_spawned` broadcast is only an observation that launch
    /// succeeded; using it as the reset boundary races startup events emitted
    /// by an already-running native harness sidecar and can erase current-generation
    /// history.
    pub async fn reset_agent_event_history(&self, name: &str) {
        let mut inner = self.inner.write().await;
        inner.agent_event_entries.remove(name);
        inner.agent_event_high_water.remove(name);
    }

    /// Retrieve all events with seq > since_seq.
    /// Returns `(events, had_gap)` where `had_gap` is true if events the
    /// caller needed (i.e. with seq in `(since_seq, oldest)`) have already
    /// been evicted from the buffer.
    ///
    /// Note the strict `since_seq + 1 < oldest` comparison rather than
    /// `since_seq < oldest`: sequence numbers are 1-based (the first event
    /// ever pushed gets seq 1), so a brand-new client requesting
    /// `since_seq = 0` against a buffer that has never evicted anything
    /// (`oldest == 1`) is not missing anything — there is no seq 0 to have
    /// lost. Using the looser comparison would falsely report a gap on
    /// every first-time connection as soon as a single durable event had
    /// ever been recorded.
    ///
    /// `since_seq` is bumped via `saturating_add(1)` rather than a plain
    /// `+ 1`: it's untrusted, client-supplied input (e.g. a `sinceSeq` query
    /// param), and `since_seq == u64::MAX` would otherwise overflow —
    /// panicking in debug/overflow-checked builds and wrapping to 0 in
    /// release, which would falsely report a gap for a cursor that is
    /// actually ahead of everything retained.
    pub async fn replay_since(&self, since_seq: u64) -> (Vec<ReplayEntry>, Option<u64>) {
        let inner = self.inner.read().await;
        let oldest_seq = inner.entries.front().map(|e| e.seq);

        let gap = match oldest_seq {
            Some(oldest) if since_seq.saturating_add(1) < oldest => Some(oldest),
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

    /// Replay one native harness agent's sidecar-sequenced event history. This is separate
    /// from the global dashboard ring so unrelated broker traffic cannot evict
    /// an active transcript or erase its high-water cursor.
    pub async fn replay_agent_events_since(
        &self,
        name: &str,
        since: u64,
    ) -> AgentEventReplaySnapshot {
        let inner = self.inner.read().await;
        let history = inner.agent_event_entries.get(name);
        let oldest = history
            .and_then(|entries| entries.front())
            .and_then(|event| event.get("sequence"))
            .and_then(Value::as_u64);
        let events = history
            .into_iter()
            .flat_map(|entries| entries.iter())
            .filter(|event| {
                event
                    .get("sequence")
                    .and_then(Value::as_u64)
                    .is_some_and(|sequence| sequence > since)
            })
            .cloned()
            .collect();
        AgentEventReplaySnapshot {
            events,
            high_water_sequence: inner.agent_event_high_water.get(name).copied().unwrap_or(0),
            oldest_available_sequence: oldest,
            gap: oldest.is_some_and(|oldest| since.saturating_add(1) < oldest),
        }
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

    /// Regression test for an off-by-one in gap detection: sequence numbers
    /// are 1-based, so a brand-new dashboard client's default cursor
    /// (`since_seq = 0`, i.e. "I have no cursor yet, replay everything")
    /// must not be treated as a gap just because nothing has ever been
    /// evicted. Before this fix, `since_seq < oldest` was `0 < 1` (true) as
    /// soon as a single durable event existed, so *every* first-time
    /// connection would receive a spurious `replay_gap` frame even though
    /// nothing was actually lost.
    #[tokio::test]
    async fn since_zero_is_not_a_gap_when_nothing_has_been_evicted() {
        let buf = ReplayBuffer::new(16);

        buf.push(json!({"kind": "relay_inbound", "body": "first ever event"}))
            .await
            .unwrap();

        let (events, gap) = buf.replay_since(0).await;
        assert!(
            gap.is_none(),
            "no eviction ever happened, so since_seq=0 must not be reported as a gap"
        );
        assert_eq!(events.len(), 1);
    }

    /// Complement to the above: if a client's cursor already points at the
    /// event immediately before the oldest retained one (i.e. they already
    /// have everything up to and including that point), there is still no
    /// gap even though `since_seq < oldest` in the old, looser sense.
    #[tokio::test]
    async fn since_seq_immediately_before_oldest_is_not_a_gap() {
        let buf = ReplayBuffer::new(3);

        for i in 0..5 {
            buf.push(json!({"kind": format!("event_{}", i)}))
                .await
                .unwrap();
        }
        // Capacity 3, so entries with seq 3, 4, 5 remain (oldest = 3).
        let (events, gap) = buf.replay_since(2).await;
        assert!(
            gap.is_none(),
            "client already has everything through seq 2; nothing after that was evicted"
        );
        assert_eq!(events.len(), 3);
        assert_eq!(events[0].seq, 3);
    }

    /// Regression test for an integer-overflow bug flagged in review: a
    /// client-supplied `since_seq` is untrusted input, and `u64::MAX` would
    /// overflow a plain `since_seq + 1` — panicking in debug/overflow-checked
    /// builds and wrapping to 0 in release, which would falsely report a gap
    /// for a cursor that is actually ahead of everything retained. Must not
    /// panic, and a cursor beyond every retained seq is not a gap.
    #[tokio::test]
    async fn since_seq_of_u64_max_does_not_overflow_or_panic() {
        let buf = ReplayBuffer::new(4);

        buf.push(json!({"kind": "relay_inbound", "body": "only"}))
            .await
            .unwrap();

        let (events, gap) = buf.replay_since(u64::MAX).await;
        assert!(
            gap.is_none(),
            "since_seq=u64::MAX is ahead of every retained seq, not a gap"
        );
        assert!(events.is_empty());
    }

    /// `ReplayBuffer` itself has no concept of event "kind" — it is a plain
    /// capacity-bound FIFO, and every `push` (whatever its `kind`) counts
    /// against the same shared `capacity`. This test locks in that raw
    /// eviction contract using realistic kind names: if a caller pushes
    /// `worker_stream` chunks directly into this buffer alongside a durable
    /// `relay_inbound` event, the flood *will* evict it once capacity is
    /// exceeded. That's precisely why callers (see
    /// `listen_api::broadcast_if_relevant`) must filter high-frequency
    /// ephemeral kinds out *before* calling `push`, rather than relying on
    /// this buffer to do it. Regression coverage for that filtering itself
    /// lives in `listen_api.rs`'s `worker_stream_flood_does_not_evict_earlier_relay_inbound`.
    #[tokio::test]
    async fn raw_buffer_is_kind_agnostic_and_will_evict_anything_once_full() {
        let buf = ReplayBuffer::new(4);

        buf.push(json!({"kind": "relay_inbound", "body": "important"}))
            .await
            .unwrap();
        for i in 0..10 {
            buf.push(json!({"kind": "worker_stream", "data": format!("chunk-{i}")}))
                .await
                .unwrap();
        }

        let (events, gap) = buf.replay_since(0).await;
        assert!(gap.is_some(), "oldest entry (relay_inbound) was evicted");
        assert!(
            events.iter().all(|e| e.event["kind"] != "relay_inbound"),
            "the buffer does not distinguish event kinds, so relay_inbound was evicted \
             along with everything else once capacity was exceeded"
        );
    }

    #[tokio::test]
    async fn agent_event_history_is_per_agent_bounded_and_reports_gap() {
        let buf = ReplayBuffer::new(2);
        for sequence in 1..=3 {
            buf.push(json!({
                "kind": "agent_event",
                "name": "A",
                "protocol_version": 1,
                "sequence": sequence,
                "timestamp": "now",
                "event": {"kind": "text.delta", "delta": sequence.to_string()}
            }))
            .await
            .unwrap();
            buf.push(json!({"kind": "unrelated", "sequence": sequence}))
                .await
                .unwrap();
        }
        let snapshot = buf.replay_agent_events_since("A", 0).await;
        assert_eq!(snapshot.events.len(), 2);
        assert_eq!(snapshot.oldest_available_sequence, Some(2));
        assert_eq!(snapshot.high_water_sequence, 3);
        assert!(snapshot.gap);
    }

    #[tokio::test]
    async fn agent_event_history_rejects_duplicate_sequence_and_resets_before_replacement() {
        let buf = ReplayBuffer::new(4);
        let event = json!({
            "kind": "agent_event", "name": "A", "protocol_version": 1,
            "sequence": 1, "timestamp": "now", "event": {"kind": "turn.started"}
        });
        buf.push(event.clone()).await.unwrap();
        assert!(buf.push(event).await.is_err());
        buf.reset_agent_event_history("A").await;
        buf.push(json!({
            "kind": "agent_event", "name": "A", "protocol_version": 1,
            "sequence": 1, "timestamp": "later", "event": {"kind": "turn.started"}
        }))
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn native_startup_events_before_spawn_broadcast_remain_replayable() {
        let buf = ReplayBuffer::new(8);

        // The reset is the replacement-generation boundary. The new sidecar
        // may then emit startup events before the HTTP spawn path gets around
        // to broadcasting agent_spawned.
        buf.push(json!({
            "kind": "agent_event", "name": "A", "protocol_version": 1,
            "sequence": 9, "timestamp": "old", "event": {"kind": "session.stopped"}
        }))
        .await
        .unwrap();
        buf.reset_agent_event_history("A").await;
        let cleared = buf.replay_agent_events_since("A", 0).await;
        assert!(cleared.events.is_empty());
        assert_eq!(cleared.high_water_sequence, 0);

        buf.push(json!({
            "kind": "agent_event", "name": "A", "protocol_version": 1,
            "sequence": 1, "timestamp": "now", "event": {"kind": "session.starting"}
        }))
        .await
        .unwrap();
        buf.push(json!({
            "kind": "agent_event", "name": "A", "protocol_version": 1,
            "sequence": 2, "timestamp": "now", "event": {"kind": "session.started"}
        }))
        .await
        .unwrap();
        buf.push(json!({"kind": "agent_spawned", "name": "A"}))
            .await
            .unwrap();

        let snapshot = buf.replay_agent_events_since("A", 0).await;
        assert_eq!(snapshot.events.len(), 2);
        assert_eq!(snapshot.events[0]["sequence"], 1);
        assert_eq!(snapshot.events[1]["sequence"], 2);
        assert_eq!(snapshot.high_water_sequence, 2);
        assert!(!snapshot.gap);
    }

    #[tokio::test]
    async fn agent_event_history_is_pruned_when_agent_lifecycle_ends() {
        for lifecycle_kind in ["agent_released", "agent_exited"] {
            let buf = ReplayBuffer::new(4);
            buf.push(json!({
                "kind": "agent_event", "name": "A", "protocol_version": 1,
                "sequence": 1, "timestamp": "now", "event": {"kind": "turn.started"}
            }))
            .await
            .unwrap();

            buf.push(json!({"kind": lifecycle_kind, "name": "A"}))
                .await
                .unwrap();

            let snapshot = buf.replay_agent_events_since("A", 0).await;
            assert!(snapshot.events.is_empty());
            assert_eq!(snapshot.high_water_sequence, 0);
        }
    }
}
