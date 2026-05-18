use serde::{Deserialize, Serialize};

use crate::protocol::MessageInjectionMode;

/// Per-worker session mode controlling how inbound relay messages are
/// dispatched into the wrapped agent's PTY.
///
/// - [`SessionMode::Relay`] (default) preserves the broker's pre-#864
///   behaviour: inbound messages are injected directly into the worker.
/// - [`SessionMode::Human`] holds inbound messages in a per-worker pending
///   queue so a human-driven client (the `agent-relay drive` verb landing
///   in sub-PR 3 of #864) can decide when to flush them.
///
/// Mode is broker-side state only; the worker process does not observe it.
/// It resets to [`SessionMode::Relay`] on broker restart — there is no
/// disk persistence in this PR.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionMode {
    /// Inbound messages auto-inject into the worker's PTY.
    #[default]
    Relay,
    /// Inbound messages append to the per-worker pending queue and wait
    /// for an explicit flush.
    Human,
}

impl SessionMode {
    pub fn as_wire_str(&self) -> &'static str {
        match self {
            SessionMode::Relay => "relay",
            SessionMode::Human => "human",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "relay" => Some(SessionMode::Relay),
            "human" => Some(SessionMode::Human),
            _ => None,
        }
    }
}

/// A relay message that arrived while a worker was in
/// [`SessionMode::Human`] and therefore got parked in the per-worker
/// pending queue instead of being injected. Drained in FIFO order by
/// `POST /api/spawned/{name}/flush` or the auto-drain on a
/// `human → relay` mode transition.
///
/// The full delivery context is captured at queue time so a drain
/// later produces a byte-for-byte equivalent of the original delivery
/// — channel-targeted messages stay channel-targeted, threaded replies
/// stay threaded, workspace attribution survives, and the original
/// priority + injection mode are preserved. Without all of these a
/// flushed `#general` message would be re-injected as a direct
/// message to the worker (since `target` would fall back to the
/// worker's name), which would change agent behaviour silently.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingRelayMessage {
    pub from: String,
    pub body: String,
    /// Original delivery target — channel (`#general`), DM recipient
    /// name, or sentinel like `"thread"`. Used as the `target` arg to
    /// `queue_and_try_delivery_raw` on drain so the re-injected
    /// message matches the original routing.
    pub target: String,
    /// Original thread id, when the inbound was a thread reply.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    /// Original workspace id, when known. Channel + DM routing both
    /// depend on this; dropping it would attribute the flushed
    /// message to the wrong workspace.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    /// Original workspace alias (display name), when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_alias: Option<String>,
    /// Original delivery priority. 0 = P0, …, 4 = P4. Defaults to 2
    /// (P2) when the source didn't carry a priority.
    #[serde(default = "default_priority")]
    pub priority: u8,
    /// Original `wait` vs `steer` injection mode.
    #[serde(default)]
    pub mode: MessageInjectionMode,
    /// Unix millis when the broker queued the message. Matches the
    /// existing timestamp style elsewhere in this module.
    pub queued_at_ms: u64,
    /// Inbound event_id when the source carried one. Preserved for
    /// telemetry / dedup parity with the auto-inject path.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event_id: Option<String>,
}

fn default_priority() -> u8 {
    2
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RelayPriority {
    P0,
    P1,
    P2,
    P3,
    P4,
}

impl RelayPriority {
    pub fn as_u8(self) -> u8 {
        match self {
            RelayPriority::P0 => 0,
            RelayPriority::P1 => 1,
            RelayPriority::P2 => 2,
            RelayPriority::P3 => 3,
            RelayPriority::P4 => 4,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InboundKind {
    MessageCreated,
    DmReceived,
    ThreadReply,
    GroupDmReceived,
    Presence,
    ReactionReceived,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SenderKind {
    Agent,
    Human,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InboundRelayEvent {
    pub event_id: String,
    pub workspace_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_alias: Option<String>,
    pub kind: InboundKind,
    pub from: String,
    pub sender_agent_id: Option<String>,
    pub sender_kind: SenderKind,
    pub target: String,
    pub text: String,
    pub thread_id: Option<String>,
    pub priority: RelayPriority,
}

/// A command invocation event received over WebSocket.
/// Relaycast emits these as `type: "command.invoked"` when an agent invokes
/// a registered command (e.g. `/spawn`, `/release`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrokerCommandEvent {
    /// The slash command name (e.g. "/spawn", "/release").
    pub command: String,
    pub workspace_id: String,
    pub workspace_alias: Option<String>,
    /// Channel the command was invoked in.
    pub channel: String,
    /// Agent ID or name of the invoker.
    pub invoked_by: String,
    /// Target command handler agent ID, when provided by Relaycast.
    pub handler_agent_id: Option<String>,
    /// Structured parameters for the command.
    pub payload: BrokerCommandPayload,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SpawnParams {
    pub name: String,
    pub cli: String,
    #[serde(default)]
    pub args: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReleaseParams {
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BrokerCommandPayload {
    Spawn(SpawnParams),
    Release(ReleaseParams),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InjectRequest {
    pub id: String,
    pub workspace_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_alias: Option<String>,
    pub from: String,
    pub target: String,
    pub body: String,
    pub priority: RelayPriority,
    pub attempts: u32,
}

/// Per-worker session bookkeeping owned by the broker. Tracks the
/// current [`SessionMode`] plus the FIFO pending queue for messages
/// captured while in [`SessionMode::Human`]. The broker keeps one of
/// these per spawned worker in a parallel `HashMap<String, SessionState>`
/// so the existing `WorkerHandle` (which holds OS-level process state)
/// doesn't have to grow.
#[derive(Debug, Default)]
pub struct SessionState {
    pub mode: SessionMode,
    pub pending: std::collections::VecDeque<PendingRelayMessage>,
}

/// Per-worker cap on the pending queue. Prevents unbounded growth when a
/// human-mode session is left open for hours; oldest message is evicted
/// with a `tracing::warn!` (see [`SessionState::push_pending`]).
pub const MAX_PENDING_PER_WORKER: usize = 256;

/// Outcome of dispatching one inbound relay message through the session
/// gate. Returned by [`SessionState::accept_inbound`] so the broker can
/// log + telemetry consistently.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionDispatch {
    /// Worker is in [`SessionMode::Relay`]; the broker should run the
    /// existing inject path.
    Inject,
    /// Worker is in [`SessionMode::Human`]; the message was queued.
    /// `queue_len` is the queue size *after* the push.
    Queued { queue_len: usize },
    /// Worker is in [`SessionMode::Human`] but the queue was full, so
    /// the oldest entry was evicted to make room. `queue_len` is the
    /// queue size *after* the eviction + push (always equal to the cap).
    QueuedEvicted {
        queue_len: usize,
        dropped_from: String,
    },
}

impl SessionState {
    pub fn new(mode: SessionMode) -> Self {
        Self {
            mode,
            pending: std::collections::VecDeque::new(),
        }
    }

    /// Push a pending message, evicting the oldest entry when the
    /// per-worker cap would be exceeded. Returns whether an eviction
    /// happened plus the evicted message's `from` field (for logging).
    fn push_pending(&mut self, msg: PendingRelayMessage) -> Option<String> {
        let mut evicted_from = None;
        if self.pending.len() >= MAX_PENDING_PER_WORKER {
            if let Some(dropped) = self.pending.pop_front() {
                evicted_from = Some(dropped.from);
            }
        }
        self.pending.push_back(msg);
        evicted_from
    }

    /// Gate an inbound relay message through the current session mode.
    ///
    /// In [`SessionMode::Relay`] the message is *not* enqueued; the
    /// caller runs the existing inject path. In [`SessionMode::Human`]
    /// the message is appended (with FIFO eviction at the cap) and the
    /// caller acks the sender without touching the worker's PTY.
    pub fn accept_inbound(&mut self, msg: PendingRelayMessage) -> SessionDispatch {
        match self.mode {
            SessionMode::Relay => SessionDispatch::Inject,
            SessionMode::Human => {
                let evicted = self.push_pending(msg);
                let queue_len = self.pending.len();
                match evicted {
                    Some(dropped_from) => SessionDispatch::QueuedEvicted {
                        queue_len,
                        dropped_from,
                    },
                    None => SessionDispatch::Queued { queue_len },
                }
            }
        }
    }

    /// Drain the pending queue in FIFO order. Used by `POST /api/flush`
    /// and by the auto-drain that runs on a `human → relay` transition.
    pub fn drain_pending(&mut self) -> Vec<PendingRelayMessage> {
        self.pending.drain(..).collect()
    }

    /// Snapshot the pending queue without modifying it.
    pub fn pending_snapshot(&self) -> Vec<PendingRelayMessage> {
        self.pending.iter().cloned().collect()
    }
}

#[cfg(test)]
mod session_tests {
    use super::*;

    fn msg(from: &str, body: &str) -> PendingRelayMessage {
        PendingRelayMessage {
            from: from.to_string(),
            body: body.to_string(),
            // Target defaults to the sender's name in tests that don't
            // care about routing — the gating logic only inspects mode
            // / queue length, not the routing fields.
            target: "worker".to_string(),
            thread_id: None,
            workspace_id: None,
            workspace_alias: None,
            priority: 2,
            mode: MessageInjectionMode::Wait,
            queued_at_ms: 0,
            event_id: None,
        }
    }

    #[test]
    fn session_mode_wire_format_matches_serde_round_trip() {
        // Guard against `as_wire_str` / `parse` drifting from the
        // `#[serde(rename_all = "snake_case")]` representation.
        for variant in [SessionMode::Relay, SessionMode::Human] {
            let serialized = serde_json::to_string(&variant)
                .expect("SessionMode serializes")
                .trim_matches('"')
                .to_string();
            assert_eq!(serialized, variant.as_wire_str());

            let parsed = SessionMode::parse(&serialized).expect("wire form parses");
            assert_eq!(parsed, variant);

            let from_serde: SessionMode =
                serde_json::from_str(&format!("\"{serialized}\"")).expect("serde round-trips");
            assert_eq!(from_serde, variant);
        }
    }

    #[test]
    fn pending_message_preserves_full_routing_context() {
        // Direct regression for the P1 review comment: a channel
        // message queued and surfaced via the pending snapshot must
        // round-trip its target / thread / workspace / priority / mode
        // unchanged, so a drain re-injects with the original routing.
        let queued = PendingRelayMessage {
            from: "Bob".to_string(),
            body: "ship it".to_string(),
            target: "#general".to_string(),
            thread_id: Some("thr_abc".to_string()),
            workspace_id: Some("ws_demo".to_string()),
            workspace_alias: Some("Demo".to_string()),
            priority: 1,
            mode: MessageInjectionMode::Steer,
            queued_at_ms: 123_456,
            event_id: Some("evt_xyz".to_string()),
        };
        let mut state = SessionState::new(SessionMode::Human);
        state.accept_inbound(queued.clone());
        let drained = state.drain_pending();
        assert_eq!(drained, vec![queued]);
    }

    #[test]
    fn default_mode_is_relay() {
        let state = SessionState::default();
        assert_eq!(state.mode, SessionMode::Relay);
        assert!(state.pending.is_empty());
    }

    #[test]
    fn relay_mode_does_not_queue() {
        let mut state = SessionState::new(SessionMode::Relay);
        let outcome = state.accept_inbound(msg("Alice", "hi"));
        assert_eq!(outcome, SessionDispatch::Inject);
        assert!(state.pending.is_empty());
    }

    #[test]
    fn human_mode_queues_in_fifo_order() {
        let mut state = SessionState::new(SessionMode::Human);
        assert_eq!(
            state.accept_inbound(msg("Alice", "one")),
            SessionDispatch::Queued { queue_len: 1 }
        );
        assert_eq!(
            state.accept_inbound(msg("Bob", "two")),
            SessionDispatch::Queued { queue_len: 2 }
        );
        let drained = state.drain_pending();
        assert_eq!(drained.len(), 2);
        assert_eq!(drained[0].from, "Alice");
        assert_eq!(drained[0].body, "one");
        assert_eq!(drained[1].from, "Bob");
        assert!(state.pending.is_empty());
    }

    #[test]
    fn human_mode_caps_queue_with_fifo_eviction() {
        let mut state = SessionState::new(SessionMode::Human);
        for i in 0..MAX_PENDING_PER_WORKER {
            assert!(matches!(
                state.accept_inbound(msg(&format!("u{i}"), "x")),
                SessionDispatch::Queued { .. }
            ));
        }
        // Cap reached — next push evicts the oldest ("u0").
        let outcome = state.accept_inbound(msg("overflow", "y"));
        match outcome {
            SessionDispatch::QueuedEvicted {
                queue_len,
                dropped_from,
            } => {
                assert_eq!(queue_len, MAX_PENDING_PER_WORKER);
                assert_eq!(dropped_from, "u0");
            }
            other => panic!("expected QueuedEvicted, got {other:?}"),
        }
        // Newest entry is at the tail; oldest surviving is "u1".
        let drained = state.drain_pending();
        assert_eq!(drained.len(), MAX_PENDING_PER_WORKER);
        assert_eq!(drained[0].from, "u1");
        assert_eq!(drained.last().expect("non-empty").from, "overflow");
    }

    #[test]
    fn pending_snapshot_does_not_mutate() {
        let mut state = SessionState::new(SessionMode::Human);
        state.accept_inbound(msg("Alice", "hi"));
        let snap = state.pending_snapshot();
        assert_eq!(snap.len(), 1);
        assert_eq!(state.pending.len(), 1, "snapshot must not drain");
    }

    #[test]
    fn parse_round_trips_wire_strings() {
        assert_eq!(SessionMode::parse("relay"), Some(SessionMode::Relay));
        assert_eq!(SessionMode::parse("HUMAN"), Some(SessionMode::Human));
        assert_eq!(SessionMode::parse(" human "), Some(SessionMode::Human));
        assert_eq!(SessionMode::parse("drive"), None);
        assert_eq!(SessionMode::Relay.as_wire_str(), "relay");
        assert_eq!(SessionMode::Human.as_wire_str(), "human");
    }
}
