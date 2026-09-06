//! Introspection for the node-control inbound path.
//!
//! The broker's only message-delivery path is the `/v1/node/ws` node-control
//! socket: an engine `deliver` frame arrives there, is deserialized into
//! [`crate::fleet_wire::Deliver`], and is dispatched by
//! `BrokerRuntime::handle_fleet_deliver`. Until this module existed, every
//! failure along that path was observable only through `tracing`, and a broker
//! started without `RUST_LOG` emits none of it. That left the most basic
//! question about a silent agent — *did a `deliver` frame reach this broker at
//! all?* — unanswerable on a running process without restarting it, which
//! destroys the in-memory cursors that hold the evidence.
//!
//! This probe is deliberately **state, not logs**: counters and a small ring
//! buffer updated inline on the delivery path and read back over
//! `GET /api/node-delivery`. It is unaffected by `RUST_LOG`.
//!
//! Two properties are load-bearing:
//!
//! 1. **It counts before deserialization.** `ServerToNode` is
//!    `#[serde(tag = "type")]`, so a `deliver` frame carrying a field the
//!    broker cannot parse — or a `type` this build does not know — fails
//!    `from_str` as a whole and is dropped at a `tracing::warn!`. Counting only
//!    successfully-parsed frames would report "no deliver frames arrived" for a
//!    broker that is in fact receiving them and throwing them away. The parse
//!    failure counter and [`ProbeSnapshot::unparsed_frame_types`] distinguish
//!    those two worlds.
//!
//! 2. **It is read without a runtime round trip.** The counters live behind an
//!    `Arc`, so `GET /api/node-delivery` answers straight from shared state
//!    rather than posting a `ListenApiRequest` to the runtime event loop. A
//!    wedged event loop is itself a plausible cause of a deaf agent, and a
//!    diagnostic that hangs in exactly the case it was built to diagnose is
//!    worthless. When the loop is stuck, the frame counters keep climbing while
//!    `cursors_published_at_ms` goes stale — which is the diagnosis.
//!
//! Nothing here records message bodies. Recent-frame entries carry identifiers,
//! sequence numbers and the payload's `type` discriminator only, so the
//! endpoint stays safe to paste into an issue.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use crate::fleet_wire::{Deliver, RelaycastToBroker};
use crate::node_control::DeliveryDecision;

/// How many recent `deliver` frames to retain. Enough to cover a demo-sized
/// burst without letting a busy broker retain unbounded history.
const RECENT_CAPACITY: usize = 32;

/// Cap on distinct `type` values retained for unparseable frames. A malformed
/// engine could otherwise turn this map into an unbounded allocation.
const UNPARSED_TYPE_CAPACITY: usize = 16;

/// Cap on a retained serde error string.
const ERROR_EXCERPT_LIMIT: usize = 300;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// What `handle_fleet_deliver` ultimately did with a frame. Recorded separately
/// from the [`DeliveryDecision`] because a decision of `Deliver` still has
/// several possible ends — injected, held for a manual flush, or failed at the
/// PTY boundary — and "where did it stop" is the whole question this answers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DeliverDisposition {
    /// Crossed the PTY injection boundary; ack withheld pending worker echo.
    Injected,
    /// Surfaced with nothing to verify (ambient receipt/reaction); acked now.
    SurfacedAndAcked,
    /// Received into the volatile FIFO, owned by Relaycast until a flush.
    HeldForManualFlush,
    /// Surfacing returned an error; ack withheld and the frame goes nowhere.
    SurfaceFailed,
    /// Recognized as duplicate/stale/gap: acked without surfacing.
    AckedWithoutSurfacing,
    /// Conflicting agent identity: dropped, ack withheld.
    RejectedIdentity,
    /// The book could not place the frame's sequence. Distinct from an
    /// identity reject: the agent never saw this message and the engine still
    /// owns it, so it must not be reported as the same condition.
    RejectedSequenceGap,
}

impl DeliverDisposition {
    fn as_str(self) -> &'static str {
        match self {
            Self::Injected => "injected",
            Self::SurfacedAndAcked => "surfaced_and_acked",
            Self::HeldForManualFlush => "held_for_manual_flush",
            Self::SurfaceFailed => "surface_failed",
            Self::AckedWithoutSurfacing => "acked_without_surfacing",
            Self::RejectedIdentity => "rejected_identity",
            Self::RejectedSequenceGap => "rejected_sequence_gap",
        }
    }
}

fn decision_label(decision: &DeliveryDecision) -> &'static str {
    match decision {
        DeliveryDecision::Deliver { .. } => "deliver",
        DeliveryDecision::Duplicate { .. } => "duplicate",
        DeliveryDecision::Stale { .. } => "stale",
        DeliveryDecision::Gap { .. } => "gap",
        DeliveryDecision::IdentityReject => "identity_reject",
    }
}

/// One observed `deliver` frame, reduced to non-sensitive fields.
#[derive(Debug, Clone)]
struct RecentDeliver {
    at_ms: u64,
    agent: String,
    agent_id: String,
    delivery_id: String,
    msg_id: String,
    seq: u64,
    payload_type: String,
    decision: &'static str,
    disposition: Option<&'static str>,
}

impl RecentDeliver {
    fn to_json(&self) -> Value {
        json!({
            "at_ms": self.at_ms,
            "agent": self.agent,
            "agent_id": self.agent_id,
            "delivery_id": self.delivery_id,
            "msg_id": self.msg_id,
            "seq": self.seq,
            "payload_type": self.payload_type,
            "decision": self.decision,
            "disposition": self.disposition,
        })
    }
}

/// The last frame the broker could not deserialize. The raw frame is never
/// retained — only its length, its `type` discriminator when one is readable,
/// and a bounded serde error.
#[derive(Debug, Clone)]
struct ParseFailure {
    at_ms: u64,
    error: String,
    frame_type: Option<String>,
    frame_len: usize,
}

/// A published view of the runtime's delivery-book cursors. The book itself
/// lives inside the single-threaded runtime; the runtime republishes this
/// snapshot as it handles frames so the endpoint can read cursors without
/// reaching into the event loop.
#[derive(Debug, Clone, Default)]
pub(crate) struct CursorSnapshot {
    pub(crate) published_at_ms: u64,
    pub(crate) agents: Vec<AgentCursorView>,
}

#[derive(Debug, Clone)]
pub(crate) struct AgentCursorView {
    pub(crate) agent_id: String,
    pub(crate) agent_name: String,
    pub(crate) acked_up_to_seq: u64,
    pub(crate) received_up_to_seq: u64,
    pub(crate) has_sequenced_position: bool,
}

#[derive(Debug, Default)]
struct Counters {
    text_frames: AtomicU64,
    parse_failures: AtomicU64,
    deliver: AtomicU64,
    action_invoke: AtomicU64,
    ping: AtomicU64,
    reply: AtomicU64,
    error: AtomicU64,
    decision_deliver: AtomicU64,
    decision_duplicate: AtomicU64,
    decision_stale: AtomicU64,
    decision_gap: AtomicU64,
    decision_identity_reject: AtomicU64,
    injected: AtomicU64,
    surfaced_and_acked: AtomicU64,
    held_for_manual_flush: AtomicU64,
    surface_failed: AtomicU64,
    acked_without_surfacing: AtomicU64,
    rejected_identity: AtomicU64,
    rejected_sequence_gap: AtomicU64,
    connects: AtomicU64,
    disconnects: AtomicU64,
    last_deliver_at_ms: AtomicU64,
    last_frame_at_ms: AtomicU64,
}

#[derive(Debug, Default)]
struct Retained {
    recent: std::collections::VecDeque<RecentDeliver>,
    last_parse_failure: Option<ParseFailure>,
    unparsed_frame_types: BTreeMap<String, u64>,
    cursors: CursorSnapshot,
}

/// Shared, `RUST_LOG`-independent introspection for the node-control inbound
/// path. Cloned as an `Arc` into the node-control client task, the runtime, and
/// the HTTP API.
#[derive(Debug, Default)]
pub(crate) struct NodeDeliveryProbe {
    counters: Counters,
    retained: Mutex<Retained>,
}

impl NodeDeliveryProbe {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    pub(crate) fn record_connected(&self) {
        self.counters.connects.fetch_add(1, Ordering::Relaxed);
    }

    pub(crate) fn record_disconnected(&self) {
        self.counters.disconnects.fetch_add(1, Ordering::Relaxed);
    }

    /// Called for every inbound WS text frame, before any deserialization.
    /// This is the counter that answers "did anything arrive at all".
    pub(crate) fn record_text_frame(&self) {
        self.counters.text_frames.fetch_add(1, Ordering::Relaxed);
        self.counters
            .last_frame_at_ms
            .store(now_ms(), Ordering::Relaxed);
    }

    /// Called when a text frame failed to deserialize into `ServerToNode`.
    /// `raw` is inspected only to recover the `type` discriminator; it is
    /// never retained.
    pub(crate) fn record_parse_failure(&self, error: &str, raw: &str) {
        self.counters.parse_failures.fetch_add(1, Ordering::Relaxed);
        let frame_type = serde_json::from_str::<Value>(raw).ok().and_then(|value| {
            value
                .get("type")
                .and_then(Value::as_str)
                .map(|found| found.to_string())
        });
        let mut error = error.to_string();
        if error.len() > ERROR_EXCERPT_LIMIT {
            error.truncate(ERROR_EXCERPT_LIMIT);
        }
        let Ok(mut retained) = self.retained.lock() else {
            return;
        };
        if let Some(found) = frame_type.clone() {
            // Bounded: only count a new discriminator while there is room, so a
            // misbehaving peer cannot grow this map without limit. Existing
            // keys keep counting either way.
            let known = retained.unparsed_frame_types.contains_key(&found);
            if known || retained.unparsed_frame_types.len() < UNPARSED_TYPE_CAPACITY {
                *retained.unparsed_frame_types.entry(found).or_insert(0) += 1;
            }
        }
        retained.last_parse_failure = Some(ParseFailure {
            at_ms: now_ms(),
            error,
            frame_type,
            frame_len: raw.len(),
        });
    }

    /// Called for every successfully-deserialized inbound frame.
    pub(crate) fn record_frame(&self, frame: &RelaycastToBroker) {
        let counter = match frame {
            RelaycastToBroker::Deliver(_) => &self.counters.deliver,
            RelaycastToBroker::ActionInvoke(_) => &self.counters.action_invoke,
            RelaycastToBroker::Ping(_) => &self.counters.ping,
            RelaycastToBroker::Reply(_) => &self.counters.reply,
            RelaycastToBroker::Error(_) => &self.counters.error,
        };
        counter.fetch_add(1, Ordering::Relaxed);
        if matches!(frame, RelaycastToBroker::Deliver(_)) {
            self.counters
                .last_deliver_at_ms
                .store(now_ms(), Ordering::Relaxed);
        }
    }

    /// Called by the runtime with the delivery book's verdict on a frame,
    /// before that verdict has been acted on.
    pub(crate) fn record_decision(&self, deliver: &Deliver, decision: &DeliveryDecision) {
        let counter = match decision {
            DeliveryDecision::Deliver { .. } => &self.counters.decision_deliver,
            DeliveryDecision::Duplicate { .. } => &self.counters.decision_duplicate,
            DeliveryDecision::Stale { .. } => &self.counters.decision_stale,
            DeliveryDecision::Gap { .. } => &self.counters.decision_gap,
            DeliveryDecision::IdentityReject => &self.counters.decision_identity_reject,
        };
        counter.fetch_add(1, Ordering::Relaxed);

        let payload_type = deliver
            .payload
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let entry = RecentDeliver {
            at_ms: now_ms(),
            agent: deliver.agent.clone(),
            agent_id: deliver.agent_id.clone(),
            delivery_id: deliver.delivery_id.clone(),
            msg_id: deliver.msg_id.clone(),
            seq: deliver.seq,
            payload_type,
            decision: decision_label(decision),
            disposition: None,
        };
        let Ok(mut retained) = self.retained.lock() else {
            return;
        };
        if retained.recent.len() == RECENT_CAPACITY {
            retained.recent.pop_front();
        }
        retained.recent.push_back(entry);
    }

    /// Called once `handle_fleet_deliver` knows where the frame ended up. The
    /// disposition is stamped onto the matching recent entry so a reader sees
    /// decision and outcome together rather than having to infer the join.
    pub(crate) fn record_disposition(&self, deliver: &Deliver, disposition: DeliverDisposition) {
        let counter = match disposition {
            DeliverDisposition::Injected => &self.counters.injected,
            DeliverDisposition::SurfacedAndAcked => &self.counters.surfaced_and_acked,
            DeliverDisposition::HeldForManualFlush => &self.counters.held_for_manual_flush,
            DeliverDisposition::SurfaceFailed => &self.counters.surface_failed,
            DeliverDisposition::AckedWithoutSurfacing => &self.counters.acked_without_surfacing,
            DeliverDisposition::RejectedIdentity => &self.counters.rejected_identity,
            DeliverDisposition::RejectedSequenceGap => &self.counters.rejected_sequence_gap,
        };
        counter.fetch_add(1, Ordering::Relaxed);
        let Ok(mut retained) = self.retained.lock() else {
            return;
        };
        if let Some(entry) = retained
            .recent
            .iter_mut()
            .rev()
            .find(|entry| entry.delivery_id == deliver.delivery_id)
        {
            entry.disposition = Some(disposition.as_str());
        }
    }

    /// Republish the runtime's delivery-book cursors. Called from the runtime,
    /// which owns the book.
    pub(crate) fn publish_cursors(&self, agents: Vec<AgentCursorView>) {
        let Ok(mut retained) = self.retained.lock() else {
            return;
        };
        retained.cursors = CursorSnapshot {
            published_at_ms: now_ms(),
            agents,
        };
    }

    /// Render the probe for `GET /api/node-delivery`.
    ///
    /// `connected` is derived from the probe's own connect/disconnect tallies
    /// rather than read from the runtime, so the endpoint needs nothing from
    /// the event loop to answer.
    pub(crate) fn snapshot_with_token(&self, token_present: bool) -> Value {
        let connected = self.counters.connects.load(Ordering::Relaxed)
            > self.counters.disconnects.load(Ordering::Relaxed);
        self.snapshot(connected, token_present)
    }

    fn snapshot(&self, connected: bool, token_present: bool) -> Value {
        let c = &self.counters;
        let load = |a: &AtomicU64| a.load(Ordering::Relaxed);
        let (recent, parse_failure, unparsed, cursors) = match self.retained.lock() {
            Ok(retained) => (
                retained
                    .recent
                    .iter()
                    .map(RecentDeliver::to_json)
                    .collect::<Vec<_>>(),
                retained.last_parse_failure.clone(),
                retained.unparsed_frame_types.clone(),
                retained.cursors.clone(),
            ),
            // A poisoned lock must not take the diagnostic offline; the
            // counters are still meaningful on their own.
            Err(_) => (Vec::new(), None, BTreeMap::new(), CursorSnapshot::default()),
        };

        json!({
            "connected": connected,
            "token_present": token_present,
            "now_ms": now_ms(),
            "socket": {
                "connects": load(&c.connects),
                "disconnects": load(&c.disconnects),
                "text_frames": load(&c.text_frames),
                "parse_failures": load(&c.parse_failures),
                "last_frame_at_ms": non_zero(load(&c.last_frame_at_ms)),
            },
            "frames": {
                "deliver": load(&c.deliver),
                "action_invoke": load(&c.action_invoke),
                "ping": load(&c.ping),
                "reply": load(&c.reply),
                "error": load(&c.error),
                "last_deliver_at_ms": non_zero(load(&c.last_deliver_at_ms)),
            },
            "decisions": {
                "deliver": load(&c.decision_deliver),
                "duplicate": load(&c.decision_duplicate),
                "stale": load(&c.decision_stale),
                "gap": load(&c.decision_gap),
                "identity_reject": load(&c.decision_identity_reject),
            },
            "dispositions": {
                "injected": load(&c.injected),
                "surfaced_and_acked": load(&c.surfaced_and_acked),
                "held_for_manual_flush": load(&c.held_for_manual_flush),
                "surface_failed": load(&c.surface_failed),
                "acked_without_surfacing": load(&c.acked_without_surfacing),
                "rejected_identity": load(&c.rejected_identity),
                "rejected_sequence_gap": load(&c.rejected_sequence_gap),
            },
            "recent_delivers": recent,
            "unparsed_frame_types": unparsed,
            "last_parse_failure": parse_failure.map(|failure| json!({
                "at_ms": failure.at_ms,
                "error": failure.error,
                "frame_type": failure.frame_type,
                "frame_len": failure.frame_len,
            })),
            "cursors_published_at_ms": non_zero(cursors.published_at_ms),
            "cursors": cursors.agents.iter().map(|agent| json!({
                "agent_id": agent.agent_id,
                "agent_name": agent.agent_name,
                "acked_up_to_seq": agent.acked_up_to_seq,
                "received_up_to_seq": agent.received_up_to_seq,
                "has_sequenced_position": agent.has_sequenced_position,
            })).collect::<Vec<_>>(),
        })
    }
}

/// Render a never-set timestamp as `null` rather than `0`, so a reader cannot
/// mistake "no frame has ever arrived" for "a frame arrived at the epoch".
fn non_zero(value: u64) -> Option<u64> {
    (value != 0).then_some(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fleet_wire::{DeliveryMode, FleetWireVersion};
    use serde_json::json;

    fn deliver(agent: &str, agent_id: &str, delivery_id: &str, seq: u64) -> Deliver {
        Deliver {
            v: FleetWireVersion,
            agent: agent.to_string(),
            agent_id: agent_id.to_string(),
            delivery_id: delivery_id.to_string(),
            msg_id: format!("msg_{delivery_id}"),
            seq,
            mode: DeliveryMode::Wait,
            payload: json!({ "type": "message.created", "body": "unused" }),
        }
    }

    /// The property the whole module exists for: a `deliver` frame the broker
    /// cannot deserialize must still be counted as having ARRIVED. Counting
    /// only parsed frames would report "nothing reached this broker" for a
    /// broker that is receiving deliveries and discarding them — the exact
    /// wrong answer to the question the endpoint is asked.
    #[test]
    fn unparseable_deliver_still_counts_as_arrived() {
        let probe = NodeDeliveryProbe::new();
        // A frame the wire enum does not know. `ServerToNode` is
        // `#[serde(tag = "type")]`, so this fails `from_str` as a whole.
        let raw = r#"{"type":"deliver.v2","agent":"a","seq":9}"#;
        probe.record_text_frame();
        probe.record_parse_failure("unknown variant `deliver.v2`", raw);

        let snapshot = probe.snapshot_with_token(true);
        assert_eq!(snapshot["socket"]["text_frames"], 1);
        assert_eq!(snapshot["socket"]["parse_failures"], 1);
        // Parsed-frame counters stay zero: the frame arrived and was lost.
        assert_eq!(snapshot["frames"]["deliver"], 0);
        assert_eq!(snapshot["unparsed_frame_types"]["deliver.v2"], 1);
        assert_eq!(
            snapshot["last_parse_failure"]["frame_type"],
            json!("deliver.v2")
        );
        assert_eq!(snapshot["last_parse_failure"]["frame_len"], raw.len());
    }

    /// A parse failure must never retain the frame itself — a `deliver`
    /// payload carries message bodies, and this endpoint is meant to be safe
    /// to paste into an issue.
    #[test]
    fn parse_failure_does_not_retain_the_frame_body() {
        let probe = NodeDeliveryProbe::new();
        let raw = r#"{"type":"mystery","payload":{"body":"hunter2-secret-body"}}"#;
        probe.record_parse_failure("unknown variant `mystery`", raw);

        let rendered = probe.snapshot_with_token(true).to_string();
        assert!(
            !rendered.contains("hunter2-secret-body"),
            "probe leaked a frame body: {rendered}"
        );
    }

    /// Likewise for the recent-frame ring: identifiers and the payload's own
    /// `type` discriminator, never the message text.
    #[test]
    fn recent_delivers_record_ids_but_not_message_bodies() {
        let probe = NodeDeliveryProbe::new();
        let mut frame = deliver("worker", "ag_1", "del_1", 1);
        frame.payload = json!({ "type": "dm.received", "body": "hunter2-secret-body" });
        probe.record_decision(&frame, &DeliveryDecision::Deliver { up_to_seq: 1 });

        let snapshot = probe.snapshot_with_token(true);
        let entry = &snapshot["recent_delivers"][0];
        assert_eq!(entry["agent"], "worker");
        assert_eq!(entry["delivery_id"], "del_1");
        assert_eq!(entry["seq"], 1);
        assert_eq!(entry["payload_type"], "dm.received");
        assert!(!snapshot.to_string().contains("hunter2-secret-body"));
    }

    /// "Where did it stop" is the second half of the question, so the decision
    /// and the disposition must be readable together on one entry rather than
    /// left for the reader to join by hand.
    #[test]
    fn disposition_lands_on_the_matching_recent_entry() {
        let probe = NodeDeliveryProbe::new();
        let first = deliver("worker", "ag_1", "del_1", 1);
        let second = deliver("worker", "ag_1", "del_2", 2);
        probe.record_decision(&first, &DeliveryDecision::Deliver { up_to_seq: 1 });
        probe.record_decision(&second, &DeliveryDecision::IdentityReject);
        probe.record_disposition(&first, DeliverDisposition::Injected);
        probe.record_disposition(&second, DeliverDisposition::RejectedIdentity);

        let snapshot = probe.snapshot_with_token(true);
        let recent = snapshot["recent_delivers"].as_array().expect("array");
        assert_eq!(recent.len(), 2);
        assert_eq!(recent[0]["delivery_id"], "del_1");
        assert_eq!(recent[0]["decision"], "deliver");
        assert_eq!(recent[0]["disposition"], "injected");
        assert_eq!(recent[1]["delivery_id"], "del_2");
        assert_eq!(recent[1]["decision"], "identity_reject");
        assert_eq!(recent[1]["disposition"], "rejected_identity");
        assert_eq!(snapshot["decisions"]["deliver"], 1);
        assert_eq!(snapshot["decisions"]["identity_reject"], 1);
        assert_eq!(snapshot["dispositions"]["injected"], 1);
        assert_eq!(snapshot["dispositions"]["rejected_identity"], 1);
    }

    /// A long-running broker must not accumulate frame history without bound.
    #[test]
    fn recent_delivers_are_capped() {
        let probe = NodeDeliveryProbe::new();
        for seq in 0..(RECENT_CAPACITY as u64 + 10) {
            let frame = deliver("worker", "ag_1", &format!("del_{seq}"), seq);
            probe.record_decision(&frame, &DeliveryDecision::Deliver { up_to_seq: seq });
        }
        let snapshot = probe.snapshot_with_token(true);
        let recent = snapshot["recent_delivers"].as_array().expect("array");
        assert_eq!(recent.len(), RECENT_CAPACITY);
        // Oldest evicted, newest retained.
        assert_eq!(recent[0]["delivery_id"], "del_10");
        assert_eq!(
            recent[RECENT_CAPACITY - 1]["delivery_id"],
            format!("del_{}", RECENT_CAPACITY + 9)
        );
        // The counter still reflects every frame, not just the retained ones.
        assert_eq!(
            snapshot["decisions"]["deliver"],
            RECENT_CAPACITY as u64 + 10
        );
    }

    /// A peer emitting endless distinct `type` values must not grow this map
    /// without limit; counts for already-known types keep advancing.
    #[test]
    fn unparsed_frame_type_map_is_bounded() {
        let probe = NodeDeliveryProbe::new();
        for index in 0..(UNPARSED_TYPE_CAPACITY + 25) {
            probe.record_parse_failure("boom", &format!(r#"{{"type":"kind{index}"}}"#));
        }
        // A type recorded while there was room keeps counting after the cap.
        probe.record_parse_failure("boom", r#"{"type":"kind0"}"#);

        let snapshot = probe.snapshot_with_token(true);
        let map = snapshot["unparsed_frame_types"]
            .as_object()
            .expect("object");
        assert_eq!(map.len(), UNPARSED_TYPE_CAPACITY);
        assert_eq!(map["kind0"], 2);
        // Every failure is still counted even when its type is not retained.
        assert_eq!(
            snapshot["socket"]["parse_failures"],
            (UNPARSED_TYPE_CAPACITY + 26) as u64
        );
    }

    /// A never-set timestamp renders as null, so "no frame has ever arrived"
    /// cannot be misread as "a frame arrived at the unix epoch".
    #[test]
    fn absent_timestamps_render_as_null() {
        let snapshot = NodeDeliveryProbe::new().snapshot_with_token(false);
        assert_eq!(snapshot["frames"]["last_deliver_at_ms"], Value::Null);
        assert_eq!(snapshot["socket"]["last_frame_at_ms"], Value::Null);
        assert_eq!(snapshot["cursors_published_at_ms"], Value::Null);
        assert_eq!(snapshot["connected"], false);
    }

    /// `connected` is derived from the probe's own tallies, so the endpoint
    /// needs nothing from the runtime event loop to report it.
    #[test]
    fn connected_tracks_connect_and_disconnect_tallies() {
        let probe = NodeDeliveryProbe::new();
        assert_eq!(probe.snapshot_with_token(true)["connected"], false);
        probe.record_connected();
        assert_eq!(probe.snapshot_with_token(true)["connected"], true);
        probe.record_disconnected();
        assert_eq!(probe.snapshot_with_token(true)["connected"], false);
        probe.record_connected();
        assert_eq!(probe.snapshot_with_token(true)["connected"], true);
    }

    #[test]
    fn published_cursors_are_rendered() {
        let probe = NodeDeliveryProbe::new();
        probe.publish_cursors(vec![AgentCursorView {
            agent_id: "ag_1".into(),
            agent_name: "worker".into(),
            acked_up_to_seq: 4,
            received_up_to_seq: 6,
            has_sequenced_position: true,
        }]);
        let snapshot = probe.snapshot_with_token(true);
        assert_eq!(snapshot["cursors"][0]["agent_name"], "worker");
        assert_eq!(snapshot["cursors"][0]["acked_up_to_seq"], 4);
        assert_eq!(snapshot["cursors"][0]["received_up_to_seq"], 6);
        assert!(snapshot["cursors_published_at_ms"].is_u64());
    }
}
