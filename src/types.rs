use serde::{Deserialize, Serialize};

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
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingRelayMessage {
    pub from: String,
    pub body: String,
    /// Unix millis when the broker queued the message. Matches the
    /// existing timestamp style elsewhere in this module.
    pub queued_at_ms: u64,
    /// Inbound event_id when the source carried one. Preserved for
    /// telemetry / dedup parity with the auto-inject path.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event_id: Option<String>,
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
            queued_at_ms: 0,
            event_id: None,
        }
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
