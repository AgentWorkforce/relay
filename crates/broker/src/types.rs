use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::ids::{
    AgentId, DeliveryId, EventId, MessageTarget, ThreadId, WorkerName, WorkspaceAlias, WorkspaceId,
};
use crate::protocol::MessageInjectionMode;

/// Per-worker inbound delivery mode controlling how inbound relay messages are
/// drained from the broker-owned pending queue into the wrapped agent's PTY.
///
/// - [`InboundDeliveryMode::AutoInject`] (default) queues inbound messages and
///   drains the queue immediately in the same broker turn.
/// - [`InboundDeliveryMode::ManualFlush`] holds queued inbound messages until a
///   client explicitly flushes them or switches back to auto-inject.
///
/// Mode is broker-side state only; the worker process does not observe it.
/// It resets to [`InboundDeliveryMode::AutoInject`] on broker restart — there
/// is no disk persistence.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InboundDeliveryMode {
    /// Inbound messages queue and immediately drain into the worker's PTY.
    #[default]
    AutoInject,
    /// Inbound messages append to the per-worker pending queue and wait
    /// for an explicit flush.
    ManualFlush,
}

impl InboundDeliveryMode {
    pub fn as_wire_str(&self) -> &'static str {
        match self {
            InboundDeliveryMode::AutoInject => "auto_inject",
            InboundDeliveryMode::ManualFlush => "manual_flush",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "auto_inject" => Some(InboundDeliveryMode::AutoInject),
            "manual_flush" => Some(InboundDeliveryMode::ManualFlush),
            _ => None,
        }
    }
}

/// A relay message captured in the per-worker pending queue before delivery.
/// [`InboundDeliveryMode::AutoInject`] drains these messages immediately;
/// [`InboundDeliveryMode::ManualFlush`] leaves them parked until
/// `POST /api/spawned/{name}/flush` or the auto-drain on a
/// `manual_flush → auto_inject` mode transition.
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
    pub target: MessageTarget,
    /// Original thread id, when the inbound was a thread reply.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    /// Original workspace id, when known. Channel + DM routing both
    /// depend on this; dropping it would attribute the flushed
    /// message to the wrong workspace.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<WorkspaceId>,
    /// Original workspace alias (display name), when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_alias: Option<WorkspaceAlias>,
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
    pub event_id: Option<EventId>,
    /// Relaycast delivery metadata for messages received over node control.
    /// Manual-flush messages retain this receipt until PTY injection so the
    /// broker can advance the cumulative ACK only across an injected prefix.
    #[serde(skip)]
    pub relaycast_receipt: Option<RelaycastDeliveryReceipt>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RelaycastDeliveryReceipt {
    pub agent: WorkerName,
    pub agent_id: AgentId,
    pub delivery_id: DeliveryId,
    pub msg_id: EventId,
    pub seq: u64,
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
    pub event_id: EventId,
    pub workspace_id: WorkspaceId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_alias: Option<WorkspaceAlias>,
    pub kind: InboundKind,
    pub from: String,
    pub sender_agent_id: Option<AgentId>,
    pub sender_kind: SenderKind,
    pub target: MessageTarget,
    pub text: String,
    pub thread_id: Option<ThreadId>,
    pub priority: RelayPriority,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SpawnParams {
    pub name: WorkerName,
    pub cli: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// Optional dispatch context for the worker process.
    ///
    /// Absent context is a strict no-op so existing spawn callers do not gain
    /// git configuration or commit-message behavior.
    #[serde(default)]
    pub metadata: SpawnMetadata,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SpawnMetadata {
    /// Public commit-attribution values supplied by the dispatcher. The broker
    /// installs its git hook only when this complete value is present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attestation: Option<CommitAttestation>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitAttestation {
    pub jti: String,
    pub agent_id: String,
    pub sponsor_id: String,
    /// The ai-hist session UUID for the Claude Code / Codex session in which
    /// the spawned agent is running. When set, the broker injects it as
    /// `RELAY_ATTEST_SESSION_ID` so the embedded `prepare-commit-msg` hook
    /// can stamp a `Session-Id:` git trailer on every commit.
    ///
    /// Populated by the dispatcher (factory) after it has a stable session
    /// reference for the child agent. Absent for agents whose dispatcher does
    /// not yet carry session provenance.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_ref: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReleaseParams {
    pub name: WorkerName,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BrokerCommandPayload {
    Spawn(SpawnParams),
    Release(ReleaseParams),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InjectRequest {
    pub id: String,
    pub workspace_id: WorkspaceId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_alias: Option<WorkspaceAlias>,
    pub from: String,
    pub target: MessageTarget,
    pub body: String,
    pub priority: RelayPriority,
    pub attempts: u32,
}

/// Per-worker inbound delivery bookkeeping owned by the broker. Tracks the
/// current [`InboundDeliveryMode`] plus the FIFO pending queue every inbound
/// relay message passes through. The broker keeps one of these per spawned
/// worker in a parallel `HashMap<String, InboundDeliveryState>` so the existing
/// `WorkerHandle` (which holds OS-level process state) doesn't have to grow.
#[derive(Debug, Default)]
pub struct InboundDeliveryState {
    pub mode: InboundDeliveryMode,
    /// Monotonic generation advanced by every successful mode write, including
    /// same-value writes. Detach restores compare this generation so an ABA
    /// sequence cannot make a concurrent session look unchanged.
    pub revision: u64,
    pub pending: std::collections::VecDeque<PendingRelayMessage>,
}

/// Per-spawn structured result callback configuration. The broker generates a
/// token for agents spawned with a result contract and injects this into that
/// agent's MCP server environment.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentResultMcpConfig {
    pub callback_url: String,
    pub token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<Value>,
}

impl AgentResultMcpConfig {
    pub fn env_pairs(&self) -> Vec<(&'static str, String)> {
        let mut pairs = vec![
            ("AGENT_RELAY_RESULT_URL", self.callback_url.clone()),
            ("AGENT_RELAY_RESULT_TOKEN", self.token.clone()),
        ];
        if let Some(schema) = &self.schema {
            pairs.push(("AGENT_RELAY_RESULT_SCHEMA", schema.to_string()));
        }
        pairs
    }
}

/// Per-worker cap on the pending queue. Prevents unbounded growth when a
/// `manual_flush` delivery mode is left open for hours; oldest message is evicted
/// with a `tracing::warn!` (see [`InboundDeliveryState::push_pending`]).
pub const MAX_PENDING_PER_WORKER: usize = 256;

/// Outcome of appending one inbound relay message to the pending queue.
/// Returned by [`InboundDeliveryState::accept_inbound`] so the broker can
/// log + telemetry consistently.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InboundDeliveryDispatch {
    /// The message was queued. `queue_len` is the queue size *after* the push.
    Queued { queue_len: usize },
    /// The queue was full, so the oldest entry was evicted to make room.
    /// `queue_len` is the queue size *after* the eviction + push (always equal
    /// to the cap).
    QueuedEvicted {
        queue_len: usize,
        dropped_from: String,
    },
}

impl InboundDeliveryState {
    pub fn new(mode: InboundDeliveryMode) -> Self {
        Self {
            mode,
            revision: 0,
            pending: std::collections::VecDeque::new(),
        }
    }

    /// Apply a mode write and advance its generation even when the enum value
    /// is unchanged. Returning the prior mode keeps transition side effects at
    /// the broker runtime boundary.
    pub fn set_mode(&mut self, mode: InboundDeliveryMode) -> InboundDeliveryMode {
        let previous = self.mode;
        self.mode = mode;
        self.revision = self
            .revision
            .checked_add(1)
            .expect("inbound delivery mode revision exhausted");
        previous
    }

    /// Whether a detach restore still owns the exact mode generation it set.
    pub fn matches_mode_guard(&self, mode: InboundDeliveryMode, revision: u64) -> bool {
        self.mode == mode && self.revision == revision
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

    /// Append an inbound relay message to the pending queue.
    ///
    /// The current [`InboundDeliveryMode`] is a drain policy, not an admission
    /// gate: callers should drain immediately in [`InboundDeliveryMode::AutoInject`]
    /// and leave the queue intact in [`InboundDeliveryMode::ManualFlush`].
    pub fn accept_inbound(&mut self, msg: PendingRelayMessage) -> InboundDeliveryDispatch {
        let evicted = self.push_pending(msg);
        let queue_len = self.pending.len();
        match evicted {
            Some(dropped_from) => InboundDeliveryDispatch::QueuedEvicted {
                queue_len,
                dropped_from,
            },
            None => InboundDeliveryDispatch::Queued { queue_len },
        }
    }

    /// Whether queued inbound messages should be drained immediately.
    pub fn should_drain_immediately(&self) -> bool {
        matches!(self.mode, InboundDeliveryMode::AutoInject)
    }

    /// Drain the pending queue in FIFO order. Used by `POST /api/flush`
    /// and by the auto-drain that runs on a `manual_flush → auto_inject`
    /// transition.
    pub fn drain_pending(&mut self) -> Vec<PendingRelayMessage> {
        self.pending.drain(..).collect()
    }

    /// Snapshot the pending queue without modifying it.
    pub fn pending_snapshot(&self) -> Vec<PendingRelayMessage> {
        self.pending.iter().cloned().collect()
    }

    /// Number of queued inbound messages waiting to reach the worker.
    pub fn pending_len(&self) -> usize {
        self.pending.len()
    }
}

#[cfg(test)]
mod inbound_delivery_tests {
    use super::*;

    fn msg(from: &str, body: &str) -> PendingRelayMessage {
        PendingRelayMessage {
            from: from.to_string(),
            body: body.to_string(),
            // Target defaults to the sender's name in tests that don't
            // care about routing — the gating logic only inspects mode
            // / queue length, not the routing fields.
            target: MessageTarget::new("worker"),
            thread_id: None,
            workspace_id: None,
            workspace_alias: None,
            priority: 2,
            mode: MessageInjectionMode::Wait,
            queued_at_ms: 0,
            event_id: None,
            relaycast_receipt: None,
        }
    }

    #[test]
    fn mode_revision_rejects_an_aba_restore() {
        let mut state = InboundDeliveryState::new(InboundDeliveryMode::AutoInject);
        state.set_mode(InboundDeliveryMode::ManualFlush);
        let session_revision = state.revision;
        assert!(state.matches_mode_guard(InboundDeliveryMode::ManualFlush, session_revision));

        state.set_mode(InboundDeliveryMode::AutoInject);
        state.set_mode(InboundDeliveryMode::ManualFlush);

        assert_eq!(state.mode, InboundDeliveryMode::ManualFlush);
        assert!(!state.matches_mode_guard(InboundDeliveryMode::ManualFlush, session_revision));
    }

    #[test]
    fn inbound_delivery_mode_wire_format_matches_serde_round_trip() {
        // Guard against `as_wire_str` / `parse` drifting from the
        // `#[serde(rename_all = "snake_case")]` representation.
        for variant in [
            InboundDeliveryMode::AutoInject,
            InboundDeliveryMode::ManualFlush,
        ] {
            let serialized = serde_json::to_string(&variant)
                .expect("InboundDeliveryMode serializes")
                .trim_matches('"')
                .to_string();
            assert_eq!(serialized, variant.as_wire_str());

            let parsed = InboundDeliveryMode::parse(&serialized).expect("wire form parses");
            assert_eq!(parsed, variant);

            let from_serde: InboundDeliveryMode =
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
            target: MessageTarget::new("#general"),
            thread_id: Some(ThreadId::new("thr_abc")),
            workspace_id: Some(WorkspaceId::new("ws_demo")),
            workspace_alias: Some(WorkspaceAlias::new("Demo")),
            priority: 1,
            mode: MessageInjectionMode::Steer,
            queued_at_ms: 123_456,
            event_id: Some(EventId::new("evt_xyz")),
            relaycast_receipt: None,
        };
        let mut state = InboundDeliveryState::new(InboundDeliveryMode::ManualFlush);
        state.accept_inbound(queued.clone());
        let drained = state.drain_pending();
        assert_eq!(drained, vec![queued]);
    }

    #[test]
    fn default_mode_is_auto_inject() {
        let state = InboundDeliveryState::default();
        assert_eq!(state.mode, InboundDeliveryMode::AutoInject);
        assert!(state.pending.is_empty());
    }

    #[test]
    fn auto_inject_mode_queues_for_immediate_drain() {
        let mut state = InboundDeliveryState::new(InboundDeliveryMode::AutoInject);
        let outcome = state.accept_inbound(msg("Alice", "hi"));
        assert_eq!(outcome, InboundDeliveryDispatch::Queued { queue_len: 1 });
        assert!(state.should_drain_immediately());
        let drained = state.drain_pending();
        assert_eq!(drained.len(), 1);
        assert_eq!(drained[0].from, "Alice");
        assert!(state.pending.is_empty());
    }

    #[test]
    fn manual_flush_mode_queues_in_fifo_order() {
        let mut state = InboundDeliveryState::new(InboundDeliveryMode::ManualFlush);
        assert!(!state.should_drain_immediately());
        assert_eq!(
            state.accept_inbound(msg("Alice", "one")),
            InboundDeliveryDispatch::Queued { queue_len: 1 }
        );
        assert_eq!(
            state.accept_inbound(msg("Bob", "two")),
            InboundDeliveryDispatch::Queued { queue_len: 2 }
        );
        let drained = state.drain_pending();
        assert_eq!(drained.len(), 2);
        assert_eq!(drained[0].from, "Alice");
        assert_eq!(drained[0].body, "one");
        assert_eq!(drained[1].from, "Bob");
        assert!(state.pending.is_empty());
    }

    #[test]
    fn manual_flush_mode_caps_queue_with_fifo_eviction() {
        let mut state = InboundDeliveryState::new(InboundDeliveryMode::ManualFlush);
        for i in 0..MAX_PENDING_PER_WORKER {
            assert!(matches!(
                state.accept_inbound(msg(&format!("u{i}"), "x")),
                InboundDeliveryDispatch::Queued { .. }
            ));
        }
        // Cap reached — next push evicts the oldest ("u0").
        let outcome = state.accept_inbound(msg("overflow", "y"));
        match outcome {
            InboundDeliveryDispatch::QueuedEvicted {
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
        let mut state = InboundDeliveryState::new(InboundDeliveryMode::ManualFlush);
        state.accept_inbound(msg("Alice", "hi"));
        let snap = state.pending_snapshot();
        assert_eq!(snap.len(), 1);
        assert_eq!(state.pending.len(), 1, "snapshot must not drain");
    }

    #[test]
    fn parse_round_trips_wire_strings() {
        assert_eq!(
            InboundDeliveryMode::parse("auto_inject"),
            Some(InboundDeliveryMode::AutoInject)
        );
        assert_eq!(
            InboundDeliveryMode::parse("MANUAL_FLUSH"),
            Some(InboundDeliveryMode::ManualFlush)
        );
        assert_eq!(
            InboundDeliveryMode::parse(" manual_flush "),
            Some(InboundDeliveryMode::ManualFlush)
        );
        assert_eq!(InboundDeliveryMode::parse("drive"), None);
        assert_eq!(InboundDeliveryMode::parse("passthrough"), None);
        assert_eq!(InboundDeliveryMode::parse("human"), None);
        // CLI verbs are not inbound delivery mode wire values.
        assert_eq!(InboundDeliveryMode::parse("relay"), None);
        assert_eq!(InboundDeliveryMode::AutoInject.as_wire_str(), "auto_inject");
        assert_eq!(
            InboundDeliveryMode::ManualFlush.as_wire_str(),
            "manual_flush"
        );
    }
}
