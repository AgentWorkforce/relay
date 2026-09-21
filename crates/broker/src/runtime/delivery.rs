use super::*;

/// The error a caller sees for a write that MAY have committed.
///
/// Paired with [`pre_write_failure_error`] so the two are defined together and
/// cannot drift into the same shape. That drift WAS the bug: both reached
/// `handle_fleet_deliver`'s `Err` arm as a plain `anyhow::Error`, so it could
/// not tell a possible write from one that provably never started and gave
/// both the drop-and-withhold treatment. A dropped in-doubt delivery is never
/// recorded, so the engine redelivers and the broker re-injects — a post-write
/// retry on the same transport, which seam rule 1 forbids.
pub(crate) fn in_doubt_error(reason: String) -> anyhow::Error {
    anyhow::Error::new(TerminalInDoubtError { reason })
}

/// The error a caller sees for a write that provably never started. Safe to
/// retry, and must NOT be accounted for as delivered.
pub(crate) fn pre_write_failure_error(reason: String) -> anyhow::Error {
    anyhow::anyhow!(reason)
}

/// A delivery whose write MAY have committed before it failed.
///
/// Carried as a typed error so a caller can tell "never wrote" from "may have
/// written". Without it both arrive as a plain `anyhow::Error` and get the same
/// treatment, which is how an in-doubt fleet delivery came to be dropped
/// without being recorded: `handle_fleet_deliver`'s `Err` arm withheld the ack
/// and returned without `commit_received`, so the engine's redelivery of the
/// same `msg_id` was classified `Deliver` rather than `Duplicate` and the
/// broker re-injected it — a post-write failure retried on the same transport,
/// which seam rule 1 exists to forbid.
#[derive(Debug, Clone)]
pub(crate) struct TerminalInDoubtError {
    pub(crate) reason: String,
}

impl std::fmt::Display for TerminalInDoubtError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.reason)
    }
}

impl std::error::Error for TerminalInDoubtError {}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct PendingDelivery {
    pub(super) worker_name: WorkerName,
    pub(super) delivery: RelayDelivery,
    pub(super) attempts: u32,
    /// Consecutive broker-to-worker handoff failures. Successful writes reset
    /// this count because waiting for the PTY to acknowledge an already queued
    /// delivery is not a failed delivery attempt.
    pub(super) failed_attempts: u32,
    pub(super) next_retry_at: Instant,
    pub(super) queued_at_ms: u64,
    pub(super) last_error: Option<String>,
    /// Fleet (engine-facing) `delivery_ack` withheld until the worker confirms
    /// this specific PTY injection landed — echo-verified, or its bounded
    /// timeout fallback — rather than acked the instant the write is merely
    /// handed to the worker. See relay#1310.
    ///
    /// Lives on the `PendingDelivery` itself, not a second map keyed by
    /// `DeliveryId`, so it cannot outlive the delivery it belongs to: every
    /// path that disposes of a `PendingDelivery` (echo confirmation, dead
    /// letter, worker teardown) disposes of its withheld ack with it, by
    /// construction, instead of needing a matching removal remembered at
    /// every one of those call sites. See relay#1543.
    pub(super) withheld_fleet_ack: Option<crate::fleet_wire::Deliver>,
    /// Lowest sequenced delivery that must be confirmed before this withheld
    /// cumulative ACK may advance. Persisted independently of the lower
    /// delivery entry so a terminal failure followed by another broker
    /// restart cannot make a higher pending sequence look like a safe new
    /// baseline.
    pub(super) withheld_fleet_ack_floor: Option<u64>,
}

/// Serializable snapshot of pending deliveries for crash recovery.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct PersistedPendingDelivery {
    pub(super) worker_name: WorkerName,
    pub(super) delivery: RelayDelivery,
    pub(super) attempts: u32,
    #[serde(default)]
    pub(super) failed_attempts: u32,
    #[serde(default)]
    pub(super) queued_at_ms: u64,
    #[serde(default)]
    pub(super) last_error: Option<String>,
    /// See `PendingDelivery::withheld_fleet_ack`. `#[serde(default)]` so a
    /// snapshot written before this field existed (or by a broker version
    /// that predates it) deserializes as `None` instead of failing to load
    /// — the same "nothing withheld" state that field already gets from a
    /// fresh delivery. See relay#1543's restart-persistence follow-up.
    #[serde(default)]
    pub(super) withheld_fleet_ack: Option<crate::fleet_wire::Deliver>,
    #[serde(default)]
    pub(super) withheld_fleet_ack_floor: Option<u64>,
}

/// Return the immutable fleet identity and the earliest sequence this pending
/// delivery can safely acknowledge. A missing persisted floor falls back to
/// the delivery's own sequence, and a corrupt floor above that sequence is
/// clamped so it can never skip the delivery itself.
pub(super) fn pending_fleet_ack_floor_candidate(
    pending: &PendingDelivery,
) -> Option<(&crate::fleet_wire::Deliver, u64)> {
    let deliver = pending
        .withheld_fleet_ack
        .as_ref()
        .filter(|deliver| deliver.seq > 0)?;
    Some((
        deliver,
        pending
            .withheld_fleet_ack_floor
            .unwrap_or(deliver.seq)
            .min(deliver.seq),
    ))
}

/// Lightweight same-agent view used to rebuild the delivery cursor without
/// cloning full JSON payloads. The floor is reduced in the same pass so every
/// caller shares the exact fallback/minimum invariant above.
pub(super) struct PendingFleetAckGroup<'a> {
    pub(super) deliveries: Vec<&'a crate::fleet_wire::Deliver>,
    pub(super) floor: Option<u64>,
}

pub(super) fn pending_fleet_ack_group<'a>(
    deliveries: impl IntoIterator<Item = &'a PendingDelivery>,
    agent_id: &str,
) -> PendingFleetAckGroup<'a> {
    let mut group = PendingFleetAckGroup {
        deliveries: Vec::new(),
        floor: None,
    };
    for pending in deliveries {
        let Some((deliver, candidate)) = pending_fleet_ack_floor_candidate(pending) else {
            continue;
        };
        if deliver.agent_id != agent_id {
            continue;
        }
        group.deliveries.push(deliver);
        group.floor = Some(group.floor.map_or(candidate, |floor| floor.min(candidate)));
    }
    group
}

/// A cumulative ACK through `acked_up_to_seq` proves every lower sequence is
/// complete. Raise only the surviving same-agent floors to the next required
/// sequence so a later broker restart cannot wait forever for an already
/// acknowledged confirmation. Terminal failures never call this helper
/// because they do not advance the cumulative ACK.
pub(super) fn advance_pending_fleet_ack_floors(
    deliveries: &mut HashMap<DeliveryId, PendingDelivery>,
    agent_id: &str,
    acked_up_to_seq: u64,
) {
    let next_required_seq = acked_up_to_seq.saturating_add(1);
    for pending in deliveries.values_mut() {
        let Some(deliver) = pending
            .withheld_fleet_ack
            .as_ref()
            .filter(|deliver| deliver.agent_id == agent_id && deliver.seq > acked_up_to_seq)
        else {
            continue;
        };
        pending.withheld_fleet_ack_floor = Some(next_required_seq.min(deliver.seq));
    }
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum DeliveryAttemptOutcome {
    Attempted {
        worker_name: WorkerName,
        attempts: u32,
        event_id: EventId,
    },
    /// Terminal failure: the entry was removed from the pending map. The full
    /// [`PendingDelivery`] rides along so the caller can move it into the
    /// dead-letter store instead of discarding the message.
    Failed {
        pending: Box<PendingDelivery>,
        last_error: String,
    },
    TerminalInDoubt {
        pending: Box<PendingDelivery>,
        last_error: String,
    },
    Noop,
}

pub(crate) fn unix_timestamp_millis() -> u64 {
    chrono::Utc::now().timestamp_millis().max(0) as u64
}

/// Pending-delivery map with dirty tracking. Any mutable access (insert,
/// remove, retry bookkeeping) marks the store dirty via `DerefMut`, letting
/// the event loop persist the snapshot immediately after the mutating event
/// instead of waiting for the next maintenance tick.
#[derive(Debug, Default)]
pub(crate) struct PendingDeliveryStore {
    map: HashMap<DeliveryId, PendingDelivery>,
    dirty: bool,
}

impl PendingDeliveryStore {
    pub(crate) fn new(map: HashMap<DeliveryId, PendingDelivery>) -> Self {
        Self { map, dirty: false }
    }

    /// Return whether the map was mutated since the last call, clearing the flag.
    pub(crate) fn take_dirty(&mut self) -> bool {
        std::mem::take(&mut self.dirty)
    }

    /// Re-mark the store dirty after a failed persist so the next flush retries
    /// the write instead of silently dropping queued deliveries.
    pub(crate) fn mark_dirty(&mut self) {
        self.dirty = true;
    }
}

impl std::ops::Deref for PendingDeliveryStore {
    type Target = HashMap<DeliveryId, PendingDelivery>;

    fn deref(&self) -> &Self::Target {
        &self.map
    }
}

impl std::ops::DerefMut for PendingDeliveryStore {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.dirty = true;
        &mut self.map
    }
}

/// Persist or remove the pending-deliveries file during graceful shutdown.
/// A non-empty map is written back to disk so the next broker start can
/// redeliver; the file is only removed when nothing is actually pending.
pub(crate) fn persist_pending_on_shutdown(
    path: &Path,
    persist: bool,
    deliveries: &HashMap<DeliveryId, PendingDelivery>,
) {
    if deliveries.is_empty() {
        if persist {
            let _ = std::fs::remove_file(path);
        }
        return;
    }
    if !persist {
        tracing::warn!(
            count = deliveries.len(),
            "shutting down with pending deliveries — they will be lost because persistence is disabled"
        );
        return;
    }
    tracing::warn!(
        count = deliveries.len(),
        path = %path.display(),
        "shutting down with pending deliveries — persisting for redelivery on restart"
    );
    if let Err(error) = save_pending_deliveries(path, deliveries) {
        tracing::warn!(
            path = %path.display(),
            error = %error,
            "failed to persist pending deliveries during shutdown"
        );
    }
}

pub(crate) fn save_pending_deliveries(
    path: &Path,
    deliveries: &HashMap<DeliveryId, PendingDelivery>,
) -> Result<()> {
    let persisted: Vec<PersistedPendingDelivery> = deliveries
        .values()
        .map(|pd| PersistedPendingDelivery {
            worker_name: pd.worker_name.clone(),
            delivery: pd.delivery.clone(),
            attempts: pd.attempts,
            failed_attempts: pd.failed_attempts,
            queued_at_ms: pd.queued_at_ms,
            last_error: pd.last_error.clone(),
            withheld_fleet_ack: pd.withheld_fleet_ack.clone(),
            withheld_fleet_ack_floor: pd.withheld_fleet_ack_floor,
        })
        .collect();
    crate::util::fs::write_json_atomic(path, &persisted)
}

pub(crate) fn load_pending_deliveries(path: &Path) -> HashMap<DeliveryId, PendingDelivery> {
    let data = match std::fs::read_to_string(path) {
        Ok(d) => d,
        Err(_) => return HashMap::new(),
    };
    let persisted: Vec<PersistedPendingDelivery> = match serde_json::from_str(&data) {
        Ok(v) => v,
        Err(_) => return HashMap::new(),
    };
    let mut loaded = persisted
        .into_iter()
        .map(|p| {
            let id = p.delivery.delivery_id.clone();
            // A restarted local recipient gets a fresh transport budget even
            // if it registers before maintenance first retries this snapshot.
            let failed_attempts = if p.delivery.event_id.as_str().starts_with("local_") {
                0
            } else {
                p.failed_attempts
            };
            (
                id,
                PendingDelivery {
                    worker_name: p.worker_name,
                    delivery: p.delivery,
                    attempts: p.attempts,
                    failed_attempts,
                    next_retry_at: Instant::now(), // retry immediately on restart
                    queued_at_ms: if p.queued_at_ms == 0 {
                        unix_timestamp_millis()
                    } else {
                        p.queued_at_ms
                    },
                    last_error: p.last_error,
                    // Restored from the snapshot (relay#1543 P1): the
                    // fleet control connection itself doesn't survive a
                    // restart, but the *fact* that this delivery's engine
                    // ack is withheld must — otherwise a retried delivery
                    // that goes on to land has no ack left to release, and
                    // the engine stays unacknowledged. `#[serde(default)]`
                    // on `PersistedPendingDelivery` makes a pre-relay#1543
                    // snapshot deserialize this as `None`, matching the
                    // "nothing withheld" state those deliveries actually had.
                    withheld_fleet_ack: p.withheld_fleet_ack,
                    withheld_fleet_ack_floor: p.withheld_fleet_ack_floor,
                },
            )
        })
        .collect();
    normalize_pending_fleet_ack_floors(&mut loaded);
    loaded
}

fn normalize_pending_fleet_ack_floors(deliveries: &mut HashMap<DeliveryId, PendingDelivery>) {
    let mut floors = HashMap::<String, u64>::new();
    for pending in deliveries.values() {
        let Some((deliver, candidate)) = pending_fleet_ack_floor_candidate(pending) else {
            continue;
        };
        floors
            .entry(deliver.agent_id.clone())
            .and_modify(|floor| *floor = (*floor).min(candidate))
            .or_insert(candidate);
    }
    for pending in deliveries.values_mut() {
        let Some(deliver) = pending
            .withheld_fleet_ack
            .as_ref()
            .filter(|deliver| deliver.seq > 0)
        else {
            pending.withheld_fleet_ack_floor = None;
            continue;
        };
        pending.withheld_fleet_ack_floor = floors.get(&deliver.agent_id).copied();
    }
}

// These payload structs were used by the stdio protocol handler (handle_sdk_frame).
#[derive(Debug, Serialize)]
pub(crate) struct AgentMetrics {
    pub(super) name: WorkerName,
    pub(super) pid: u32,
    pub(super) memory_bytes: u64,
    pub(super) uptime_secs: u64,
}

#[derive(Debug, Deserialize)]
pub(crate) struct DeliveryAckPayload {
    pub(super) delivery_id: DeliveryId,
    pub(super) event_id: EventId,
}

/// Classify delivery ids that are meaningful Relaycast message ids for
/// read-ack purposes. A read-ack means "delivered to the recipient location",
/// not proof that a model turn cognitively processed the message.
pub(crate) fn synthetic_delivery_read_ack_reason(event_id: &EventId) -> Option<&'static str> {
    let event_id = event_id.as_str().trim();
    if event_id.is_empty() {
        return Some("blank_event_id");
    }
    if event_id.starts_with("local_") {
        return Some("local_only_synthetic_event_id");
    }
    if event_id.starts_with("http_") {
        return Some("http_api_synthetic_event_id");
    }
    if event_id.starts_with("init_") {
        return Some("initial_task_synthetic_event_id");
    }
    if event_id.starts_with("cont_load_") {
        return Some("continuity_synthetic_event_id");
    }
    if event_id.starts_with("flush_") {
        return Some("manual_flush_synthetic_event_id");
    }
    None
}

#[cfg(test)]
pub(crate) fn delivery_read_ack_is_relaycast_message(event_id: &EventId) -> bool {
    synthetic_delivery_read_ack_reason(event_id).is_none()
}

/// True when `thread_id` is a real Relaycast message id we can `reply()` to,
/// as opposed to a broker-minted synthetic event id (`http_`/`init_`/… — see
/// [`synthetic_delivery_read_ack_reason`]) or a channel/DM grouping key
/// (`#channel`, `direct:*`) that `/api/threads` can surface. Relaycast rejects
/// a reply to anything that isn't a real message id, so the publish path must
/// fall back to a plain post for these rather than fail the whole send.
pub(crate) fn is_relaycast_reply_target(thread_id: &str) -> bool {
    let id = thread_id.trim();
    if id.is_empty() || id.starts_with('#') || id.starts_with("direct:") {
        return false;
    }
    synthetic_delivery_read_ack_reason(&EventId::new(id)).is_none()
}

pub(crate) fn seed_supplied_agent_token(
    relaycast_http: &RelaycastHttpClient,
    agent_name: &str,
    token: &str,
) {
    relaycast_http.seed_agent_token(agent_name, token);
}

const DELIVERY_READ_ACK_TIMEOUT: Duration = Duration::from_secs(2);

pub(crate) fn mark_delivery_read_ack(
    relaycast_http: &RelaycastHttpClient,
    sdk_out_tx: &mpsc::Sender<ProtocolEnvelope<Value>>,
    dedup: &mut DedupCache,
    worker_name: &WorkerName,
    cli_hint: Option<&str>,
    delivery_id: &DeliveryId,
    event_id: &EventId,
) {
    mark_delivery_read_ack_with_timeout(
        relaycast_http,
        sdk_out_tx,
        dedup,
        worker_name,
        cli_hint,
        delivery_id,
        event_id,
        DELIVERY_READ_ACK_TIMEOUT,
    );
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn mark_delivery_read_ack_with_timeout(
    relaycast_http: &RelaycastHttpClient,
    sdk_out_tx: &mpsc::Sender<ProtocolEnvelope<Value>>,
    dedup: &mut DedupCache,
    worker_name: &WorkerName,
    cli_hint: Option<&str>,
    delivery_id: &DeliveryId,
    event_id: &EventId,
    timeout_window: Duration,
) {
    let dedup_key = format!("delivery_read_ack:{worker_name}:{event_id}");
    if !dedup.insert_if_new(&dedup_key, Instant::now()) {
        emit_delivery_read_ack_telemetry(
            sdk_out_tx.clone(),
            BrokerEvent::DeliveryReadAck {
                name: worker_name.clone(),
                delivery_id: delivery_id.clone(),
                event_id: event_id.clone(),
                status: DeliveryReadAckStatus::SuppressedDuplicate,
                reason: Some("duplicate_delivery_read_ack".to_string()),
            },
        );
        return;
    }

    if let Some(reason) = synthetic_delivery_read_ack_reason(event_id) {
        emit_delivery_read_ack_telemetry(
            sdk_out_tx.clone(),
            BrokerEvent::DeliveryReadAck {
                name: worker_name.clone(),
                delivery_id: delivery_id.clone(),
                event_id: event_id.clone(),
                status: DeliveryReadAckStatus::SkippedSynthetic,
                reason: Some(reason.to_string()),
            },
        );
        return;
    }

    let relaycast_http = relaycast_http.clone();
    let sdk_out_tx = sdk_out_tx.clone();
    let worker_name = worker_name.clone();
    let cli_hint = cli_hint.map(str::to_string);
    let delivery_id = delivery_id.clone();
    let event_id = event_id.clone();

    tokio::spawn(async move {
        let result = timeout(
            timeout_window,
            relaycast_http.mark_read_as_agent(
                worker_name.as_str(),
                cli_hint.as_deref(),
                event_id.as_str(),
            ),
        )
        .await;

        match result {
            Ok(Ok(_)) => {
                let _ = send_broker_event(
                    &sdk_out_tx,
                    BrokerEvent::DeliveryReadAck {
                        name: worker_name,
                        delivery_id,
                        event_id,
                        status: DeliveryReadAckStatus::Marked,
                        reason: None,
                    },
                )
                .await;
            }
            Ok(Err(error)) => {
                let reason = error.to_string();
                tracing::warn!(
                    target = "agent_relay::broker",
                    worker = %worker_name,
                    delivery_id = %delivery_id,
                    event_id = %event_id,
                    error = %reason,
                    "failed to mark relaycast message read after delivery_ack"
                );
                let _ = send_broker_event(
                    &sdk_out_tx,
                    BrokerEvent::DeliveryReadAck {
                        name: worker_name,
                        delivery_id,
                        event_id,
                        status: DeliveryReadAckStatus::Failed,
                        reason: Some(reason),
                    },
                )
                .await;
            }
            Err(_) => {
                let reason = format!(
                    "relaycast mark_read timed out after {}ms",
                    timeout_window.as_millis()
                );
                tracing::warn!(
                    target = "agent_relay::broker",
                    worker = %worker_name,
                    delivery_id = %delivery_id,
                    event_id = %event_id,
                    timeout_ms = %timeout_window.as_millis(),
                    "timed out marking relaycast message read after delivery_ack"
                );
                let _ = send_broker_event(
                    &sdk_out_tx,
                    BrokerEvent::DeliveryReadAck {
                        name: worker_name,
                        delivery_id,
                        event_id,
                        status: DeliveryReadAckStatus::Failed,
                        reason: Some(reason),
                    },
                )
                .await;
            }
        }
    });
}

fn emit_delivery_read_ack_telemetry(
    sdk_out_tx: mpsc::Sender<ProtocolEnvelope<Value>>,
    event: BrokerEvent,
) {
    tokio::spawn(async move {
        let _ = send_broker_event(&sdk_out_tx, event).await;
    });
}

/// Outcome of [`queue_inbound_for_delivery_mode`]. Distinguishes the
/// three cases broker call sites care about: the message is queued and
/// should wait for an explicit flush, the queue should be drained now,
/// or there's no worker (caller falls through to existing target handling).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum InboundQueueOutcome {
    Queued,
    DrainNow(Vec<PendingRelayMessage>),
    RejectedFull,
    WorkerMissing,
}

/// Result of [`queue_inbound_for_delivery_mode`]: the routing outcome plus
/// eviction info when the per-worker pending cap forced the oldest queued
/// message out. Callers must surface evictions as a `delivery_dropped`
/// broker event — a capped queue silently losing messages is a delivery
/// failure, not a debug detail.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct InboundQueueResult {
    pub(crate) outcome: InboundQueueOutcome,
    /// `from` of the oldest message evicted to make room, if any.
    pub(crate) evicted_from: Option<String>,
}

/// Per-worker count of messages that have not reached the agent yet: the
/// un-injected inbound queue (`manual_flush` backlog) plus the in-flight
/// deliveries still awaiting worker confirmation. Feeds `pending_messages` on
/// `GET /api/spawned` and `GET /api/status`; workers with nothing waiting are
/// left out of the map.
pub(crate) fn pending_message_counts(
    delivery_states: &HashMap<WorkerName, InboundDeliveryState>,
    pending_deliveries: &HashMap<DeliveryId, PendingDelivery>,
) -> HashMap<WorkerName, usize> {
    let mut counts: HashMap<WorkerName, usize> = delivery_states
        .iter()
        .filter(|(_, state)| state.pending_len() > 0)
        .map(|(name, state)| (name.clone(), state.pending_len()))
        .collect();
    for delivery in pending_deliveries.values() {
        *counts.entry(delivery.worker_name.clone()).or_insert(0) += 1;
    }
    counts
}

/// Build the `delivery_dropped` broker event for a queue-cap eviction.
pub(crate) fn delivery_dropped_event_for_eviction(
    worker_name: &str,
    dropped_from: &str,
) -> BrokerEvent {
    BrokerEvent::DeliveryDropped {
        name: WorkerName::from(worker_name),
        count: 1,
        reason: format!(
            "pending queue full (max {}); evicted oldest message from {}",
            crate::types::MAX_PENDING_PER_WORKER,
            dropped_from
        ),
    }
}

/// Bundle of routing context captured into the pending queue. Mirrors the
/// args `queue_and_try_delivery_raw`
/// expects so a drain reproduces the original delivery exactly — same
/// target (channel / DM / thread sentinel), thread, workspace,
/// priority, and injection mode.
pub(crate) struct InboundContext<'a> {
    pub(super) from: &'a str,
    pub(super) body: &'a str,
    pub(super) target: &'a str,
    pub(super) thread_id: Option<&'a str>,
    pub(super) workspace_id: Option<&'a str>,
    pub(super) workspace_alias: Option<&'a str>,
    pub(super) priority: u8,
    pub(super) mode: MessageInjectionMode,
    pub(super) event_id: Option<&'a str>,
    pub(super) relaycast_receipt: Option<crate::types::RelaycastDeliveryReceipt>,
}

/// Queue an inbound relay message through the per-worker [`InboundDeliveryMode`].
///
/// Every inbound message is appended to the per-worker pending queue. In
/// [`InboundDeliveryMode::AutoInject`] the caller immediately drains the queue
/// in the same broker turn; in [`InboundDeliveryMode::ManualFlush`] the message
/// stays parked until an explicit flush or mode transition.
///
/// Pulled out so the broker has one obvious choke point for the two
/// inbound paths (`/api/send` and the relaycast inbound feed) that the
/// `drive` client needs to intercept. Internal broker-driven injections
/// (`worker_ready` initial task, continuity restore) bypass this queue by
/// not calling this helper.
pub(crate) fn queue_inbound_for_delivery_mode(
    delivery_states: &mut HashMap<WorkerName, InboundDeliveryState>,
    workers: &WorkerRegistry,
    worker_name: &str,
    ctx: InboundContext<'_>,
) -> InboundQueueResult {
    if !workers.has_worker(worker_name) {
        return InboundQueueResult {
            outcome: InboundQueueOutcome::WorkerMissing,
            evicted_from: None,
        };
    }
    let state = delivery_states
        .entry(WorkerName::from(worker_name))
        .or_default();
    if state.pending.len() >= crate::types::MAX_PENDING_PER_WORKER {
        tracing::warn!(
            target = "agent_relay::broker",
            worker = %worker_name,
            from = %ctx.from,
            mode = state.mode.as_wire_str(),
            queue_len = state.pending.len(),
            max_pending = crate::types::MAX_PENDING_PER_WORKER,
            "pending queue full - rejecting newest message"
        );
        return InboundQueueResult {
            outcome: InboundQueueOutcome::RejectedFull,
            evicted_from: None,
        };
    }
    let should_drain = state.should_drain_immediately();
    let queued_at_ms = chrono::Utc::now().timestamp_millis().max(0) as u64;
    let msg = PendingRelayMessage {
        from: ctx.from.to_string(),
        body: ctx.body.to_string(),
        target: MessageTarget::new(ctx.target),
        thread_id: ctx.thread_id.map(ThreadId::from),
        workspace_id: ctx.workspace_id.map(WorkspaceId::from),
        workspace_alias: ctx.workspace_alias.map(WorkspaceAlias::from),
        priority: ctx.priority,
        mode: ctx.mode,
        queued_at_ms,
        event_id: ctx.event_id.map(EventId::from),
        relaycast_receipt: ctx.relaycast_receipt,
    };
    let evicted_from = match state.accept_inbound(msg) {
        InboundDeliveryDispatch::Queued { queue_len } => {
            tracing::debug!(
                target = "agent_relay::broker",
                worker = %worker_name,
                from = %ctx.from,
                mode = state.mode.as_wire_str(),
                queue_len,
                "queued inbound relay message"
            );
            None
        }
        InboundDeliveryDispatch::QueuedEvicted {
            queue_len,
            dropped_from,
        } => {
            tracing::warn!(
                target = "agent_relay::broker",
                worker = %worker_name,
                from = %ctx.from,
                dropped_from = %dropped_from,
                mode = state.mode.as_wire_str(),
                queue_len,
                max_pending = crate::types::MAX_PENDING_PER_WORKER,
                "pending queue full — evicting oldest message"
            );
            Some(dropped_from)
        }
    };
    let outcome = if should_drain {
        let to_drain = state.drain_pending();
        tracing::debug!(
            target = "agent_relay::broker",
            worker = %worker_name,
            drained = to_drain.len(),
            "draining inbound queue immediately (auto_inject delivery mode)"
        );
        InboundQueueOutcome::DrainNow(to_drain)
    } else {
        InboundQueueOutcome::Queued
    };
    InboundQueueResult {
        outcome,
        evicted_from,
    }
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn try_inject_pending_relay_message(
    workers: &mut WorkerRegistry,
    pending_deliveries: &mut HashMap<DeliveryId, PendingDelivery>,
    worker_name: &str,
    msg: &PendingRelayMessage,
    retry_interval: Duration,
    // Fleet-originated deliveries pass the withheld engine ack through so it
    // is embedded into the `PendingDelivery` at the moment of insertion —
    // synchronously, before the handoff attempt below can time out. Deliver
    // it any later (e.g. as a follow-up step keyed off this function's
    // return value) and a handoff that outlives `retry_interval` loses the
    // race: the timeout below fires, the `DeliveryId` never reaches the
    // caller, and the ack is never registered even though the delivery is
    // still very much alive and retryable. See relay#1310 / relay#1543.
    withheld_fleet_ack: Option<crate::fleet_wire::Deliver>,
    withheld_fleet_ack_floor: Option<u64>,
    seam: &mut crate::delivery::DeliverySeam,
) -> Result<DeliveryId> {
    let event_id = msg
        .event_id
        .clone()
        .unwrap_or_else(|| EventId::new(format!("flush_{}", Uuid::new_v4().simple())));
    match timeout(
        retry_interval,
        queue_and_try_delivery_raw(
            workers,
            pending_deliveries,
            worker_name,
            &event_id,
            &msg.from,
            // Use the ORIGINAL routing target captured at queue time —
            // `#general`, the DM recipient name, `"thread"`, etc. Falling
            // back to `worker_name` here would silently reframe channel
            // messages as direct-to-worker messages on drain.
            &msg.target,
            &msg.body,
            msg.thread_id.clone(),
            msg.workspace_id.clone(),
            msg.workspace_alias.clone(),
            msg.priority,
            msg.mode.clone(),
            retry_interval,
            withheld_fleet_ack,
            withheld_fleet_ack_floor,
            seam,
        ),
    )
    .await
    {
        Ok(result) => result,
        Err(_) => Err(anyhow::anyhow!(
            "pending relay delivery timed out after {}ms",
            retry_interval.as_millis()
        )),
    }
}

/// Attempt one PTY injection without transferring ownership to the broker's
/// retry queue. Manual-flush callers keep the original message at the head of
/// their FIFO on failure, along with its Relaycast receipt, so retrying cannot
/// race a second broker-owned copy of the same delivery.
/// Rebuild the `RelayDelivery` a parked message was queued from.
///
/// Shared by the injection path and the dead-letter path so a message that is
/// discarded instead of injected is recorded under the same delivery and event
/// ids the worker would have seen.
pub(crate) fn relay_delivery_for_pending_message(msg: &PendingRelayMessage) -> RelayDelivery {
    let event_id = msg
        .event_id
        .clone()
        .unwrap_or_else(|| EventId::new(format!("flush_{}", Uuid::new_v4().simple())));
    let delivery_id = msg
        .relaycast_receipt
        .as_ref()
        .map(|receipt| receipt.delivery_id.clone())
        .unwrap_or_else(|| DeliveryId::new(format!("del_{}", Uuid::new_v4().simple())));
    RelayDelivery {
        delivery_id,
        event_id,
        workspace_id: msg.workspace_id.clone(),
        workspace_alias: msg.workspace_alias.clone(),
        from: msg.from.clone(),
        target: msg.target.clone(),
        body: msg.body.clone(),
        thread_id: msg.thread_id.clone(),
        priority: Some(msg.priority),
        injection_mode: msg.mode.clone(),
    }
}

pub(crate) async fn try_inject_pending_relay_message_once(
    workers: &mut WorkerRegistry,
    worker_name: &str,
    msg: &PendingRelayMessage,
    retry_interval: Duration,
) -> Result<()> {
    let delivery = relay_delivery_for_pending_message(msg);

    // NOT behind the delivery seam. `timeout` can fire AFTER the frame has been
    // admitted to the sole writer queue, and an admitted command is still
    // emitted (`worker.rs`, `send_to_worker_with_commit_boundary`). The caller
    // in `fleet.rs` records a failure and breaks, leaving the message at the
    // head of the FIFO, so the next flush writes it again — a fall-back after a
    // possible write (rule 1) and a re-send on doubt (rule 2), on the fleet
    // path. Pre-dates the seam; tracked in relay#1832 with
    // `maintenance.rs`'s direct `workers.deliver`. Phase 0 put ONE of three PTY
    // write paths behind the trait; phase 1 must not assume otherwise.
    timeout(retry_interval, workers.deliver(worker_name, delivery))
        .await
        .map_err(|_| {
            anyhow::anyhow!(
                "pending relay delivery timed out after {}ms",
                retry_interval.as_millis()
            )
        })?
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn queue_and_try_delivery_raw(
    workers: &mut WorkerRegistry,
    pending_deliveries: &mut HashMap<DeliveryId, PendingDelivery>,
    worker_name: &str,
    event_id: &str,
    from: &str,
    target: &str,
    body: &str,
    thread_id: Option<ThreadId>,
    workspace_id: Option<WorkspaceId>,
    workspace_alias: Option<WorkspaceAlias>,
    priority: u8,
    injection_mode: MessageInjectionMode,
    retry_interval: Duration,
    withheld_fleet_ack: Option<crate::fleet_wire::Deliver>,
    withheld_fleet_ack_floor: Option<u64>,
    seam: &mut crate::delivery::DeliverySeam,
) -> Result<DeliveryId> {
    let delivery = RelayDelivery {
        delivery_id: DeliveryId::new(format!("del_{}", Uuid::new_v4().simple())),
        event_id: EventId::new(event_id),
        workspace_id,
        workspace_alias,
        from: from.to_string(),
        target: MessageTarget::new(target),
        body: body.to_string(),
        thread_id,
        priority: Some(priority),
        injection_mode,
    };
    insert_and_attempt_delivery(
        workers,
        pending_deliveries,
        worker_name,
        delivery,
        retry_interval,
        withheld_fleet_ack,
        withheld_fleet_ack_floor,
        seam,
    )
    .await
}

/// Register a delivery and make its first handoff attempt, in one atomic
/// step: the `PendingDelivery` — including any withheld fleet ack — is
/// inserted into `pending_deliveries` before the handoff attempt starts, so
/// a slow or cancelled attempt can never separate "this delivery exists and
/// is retryable" from "its withheld ack is registered". Shared by the
/// broker-generated-id path (`queue_and_try_delivery_raw`) and any caller
/// that already has a fully-built [`RelayDelivery`] (the fleet
/// `WorkerMissing` injection path, which must keep the engine's own
/// `delivery_id`).
#[allow(clippy::too_many_arguments)]
pub(crate) async fn insert_and_attempt_delivery(
    workers: &mut WorkerRegistry,
    pending_deliveries: &mut HashMap<DeliveryId, PendingDelivery>,
    worker_name: &str,
    delivery: RelayDelivery,
    retry_interval: Duration,
    withheld_fleet_ack: Option<crate::fleet_wire::Deliver>,
    explicit_withheld_fleet_ack_floor: Option<u64>,
    seam: &mut crate::delivery::DeliverySeam,
) -> Result<DeliveryId> {
    let delivery_id = delivery.delivery_id.clone();
    let withheld_fleet_ack_floor = withheld_fleet_ack
        .as_ref()
        .filter(|deliver| deliver.seq > 0)
        .map(|deliver| {
            let requested_floor = explicit_withheld_fleet_ack_floor
                .unwrap_or(deliver.seq)
                .min(deliver.seq);
            pending_fleet_ack_group(pending_deliveries.values(), &deliver.agent_id)
                .floor
                .map_or(requested_floor, |floor| floor.min(requested_floor))
        });
    pending_deliveries.insert(
        delivery_id.clone(),
        PendingDelivery {
            worker_name: WorkerName::new(worker_name),
            delivery,
            attempts: 0,
            failed_attempts: 0,
            next_retry_at: Instant::now(),
            queued_at_ms: unix_timestamp_millis(),
            last_error: None,
            withheld_fleet_ack,
            withheld_fleet_ack_floor,
        },
    );

    match retry_pending_delivery(
        &delivery_id,
        workers,
        pending_deliveries,
        retry_interval,
        seam,
    )
    .await?
    {
        DeliveryAttemptOutcome::Failed {
            mut pending,
            last_error,
        } => {
            // The raw queue path has no dead-letter store/event sender. Preserve
            // ownership locally so the maintenance retry path can record the
            // terminal failure instead of silently discarding it here.
            pending.failed_attempts = MAX_DELIVERY_RETRIES;
            pending.last_error = Some(last_error.clone());
            pending.next_retry_at = Instant::now();
            pending_deliveries.insert(pending.delivery.delivery_id.clone(), *pending);
            // Paired with the in-doubt arm below: a caller must be able to tell
            // these apart, so both go through the named constructors.
            return Err(pre_write_failure_error(last_error));
        }
        DeliveryAttemptOutcome::TerminalInDoubt { last_error, .. } => {
            // Typed, so the caller can account for it instead of treating a
            // possible write as a failed one.
            return Err(in_doubt_error(last_error));
        }
        _ => {}
    }
    Ok(delivery_id)
}

pub(crate) async fn retry_pending_delivery(
    delivery_id: &DeliveryId,
    workers: &mut WorkerRegistry,
    pending_deliveries: &mut HashMap<DeliveryId, PendingDelivery>,
    retry_interval: Duration,
    // Borrowed, not constructed. A seam that lives only for this call has an
    // always-empty receipt memory, which makes its duplicate guard, route
    // recording and bounded eviction inert.
    seam: &mut crate::delivery::DeliverySeam,
) -> Result<DeliveryAttemptOutcome> {
    let pending = match pending_deliveries.get(delivery_id) {
        Some(pending) => pending.clone(),
        None => return Ok(DeliveryAttemptOutcome::Noop),
    };

    // A local queue can outlive its broker and worker. Check absence before
    // retry exhaustion, and give a respawned recipient a fresh handoff budget.
    // Explicit release still moves its pending deliveries to dead letters.
    if pending.delivery.event_id.as_str().starts_with("local_")
        && !workers.has_worker(&pending.worker_name)
    {
        if let Some(current) = pending_deliveries.get_mut(delivery_id) {
            current.failed_attempts = 0;
            current.next_retry_at = Instant::now() + retry_interval;
            current.last_error = Some("waiting for local recipient to reconnect".into());
        }
        return Ok(DeliveryAttemptOutcome::Noop);
    }

    if pending.failed_attempts >= MAX_DELIVERY_RETRIES {
        let removed = pending_deliveries.remove(delivery_id).unwrap_or(pending);
        // A delivery the seam already handed to a route is IN DOUBT, not
        // simply failed, however many retries followed.
        //
        // `Failed` dead-letters with a reason carrying no in-doubt marker, so
        // `is_auto_redeliverable` returns true and an operator redelivery
        // re-sends a message that may already have landed — the double
        // delivery rule 2 exists to prevent. The retry budget is exhausted the
        // same way in both cases; what differs is whether anything ever went
        // out over a transport, and only the seam knows that.
        //
        // This is the common shape, not an edge case: one successful hand-off
        // whose ack never arrives returns `AlreadySent` on every later tick,
        // counting `failed_attempts` up to the cap without re-writing. It then
        // arrived here and was dead-lettered as freely redeliverable.
        if let Some(route) = seam.recorded_route(delivery_id) {
            let route = route.as_str().to_string();
            let last_error = removed.last_error.clone().unwrap_or_else(|| {
                format!(
                    "handed over to route {route} and never acknowledged within                      {MAX_DELIVERY_RETRIES} retries"
                )
            });
            return Ok(DeliveryAttemptOutcome::TerminalInDoubt {
                pending: Box::new(removed),
                last_error,
            });
        }
        let last_error = removed
            .last_error
            .clone()
            .unwrap_or_else(|| "max delivery retries exceeded".to_string());
        return Ok(DeliveryAttemptOutcome::Failed {
            pending: Box::new(removed),
            last_error,
        });
    }

    if !workers.has_worker(&pending.worker_name) {
        let removed = pending_deliveries.remove(delivery_id).unwrap_or(pending);
        return Ok(DeliveryAttemptOutcome::Failed {
            pending: Box::new(removed),
            last_error: "recipient gone".to_string(),
        });
    }

    // Keep early channel traffic out of the PTY until worker_ready queues the
    // initial task. Startup waiting does not consume the transport retry budget.
    if workers.initial_tasks.contains_key(&pending.worker_name) {
        if let Some(current) = pending_deliveries.get_mut(delivery_id) {
            current.next_retry_at = Instant::now() + retry_interval;
        }
        return Ok(DeliveryAttemptOutcome::Noop);
    }

    let mut pty_backend = crate::delivery::pty::PtyDeliveryBackend::new(workers);
    let request =
        crate::delivery::SendRequest::relay(pending.worker_name.clone(), pending.delivery.clone());
    match seam.send(&mut [&mut pty_backend], request).await {
        Ok(crate::delivery::SendOutcome::AlreadySent(_)) => {
            // NOT `Noop`. `Noop` leaves `next_retry_at` untouched, so once the
            // seam outlives a single call — which is the whole point of hoisting
            // it — a delivery whose ack never arrives would be re-entered by
            // every maintenance tick, return the same answer, never advance its
            // own clock, and so never retry, never fail and never dead-letter:
            // a permanently stuck delivery plus a hot loop.
            //
            // Backing off keeps the retry cap reachable, so an un-acked routed
            // delivery still terminates in a dead letter instead of spinning.
            if let Some(current) = pending_deliveries.get_mut(delivery_id) {
                current.failed_attempts = current.failed_attempts.saturating_add(1);
                current.next_retry_at = Instant::now() + retry_interval;
            }
            Ok(DeliveryAttemptOutcome::Noop)
        }
        Ok(crate::delivery::SendOutcome::Forgotten { .. }) => {
            // The seam sent this before and has since evicted its receipt, so
            // the route is unknown. Rule 2: not knowing where a message went is
            // not evidence it did not go. Settle it in doubt rather than
            // handing it to a transport again.
            let removed = pending_deliveries.remove(delivery_id).unwrap_or(pending);
            Ok(DeliveryAttemptOutcome::TerminalInDoubt {
                pending: Box::new(removed),
                last_error: "delivery route was forgotten by the seam; not re-sending".to_string(),
            })
        }
        Ok(outcome)
            if matches!(
                outcome.receipt().map(|receipt| &receipt.status),
                Some(crate::delivery::SendStatus::InDoubt)
            ) =>
        {
            let removed = pending_deliveries.remove(delivery_id).unwrap_or(pending);
            Ok(DeliveryAttemptOutcome::TerminalInDoubt {
                pending: Box::new(removed),
                last_error: "delivery route is in doubt after possible write".to_string(),
            })
        }
        Ok(crate::delivery::SendOutcome::Fresh(_)) => {
            if let Some(current) = pending_deliveries.get_mut(delivery_id) {
                current.attempts = current.attempts.saturating_add(1);
                current.failed_attempts = 0;
                current.next_retry_at = Instant::now()
                    + delivery_ack_timeout(&current.delivery.injection_mode, retry_interval);
                current.last_error = None;
                return Ok(DeliveryAttemptOutcome::Attempted {
                    worker_name: current.worker_name.clone(),
                    attempts: current.attempts,
                    event_id: current.delivery.event_id.clone(),
                });
            }
            Ok(DeliveryAttemptOutcome::Noop)
        }
        Err(error) if error.is_committed() => {
            let removed = pending_deliveries.remove(delivery_id).unwrap_or(pending);
            Ok(DeliveryAttemptOutcome::TerminalInDoubt {
                pending: Box::new(removed),
                last_error: error.to_string(),
            })
        }
        Err(error) => {
            let should_fail = if let Some(current) = pending_deliveries.get_mut(delivery_id) {
                current.attempts = current.attempts.saturating_add(1);
                current.failed_attempts = current.failed_attempts.saturating_add(1);
                current.next_retry_at = Instant::now() + retry_interval;
                current.last_error = Some(error.to_string());
                current.failed_attempts >= MAX_DELIVERY_RETRIES
            } else {
                false
            };

            if should_fail {
                if let Some(removed) = pending_deliveries.remove(delivery_id) {
                    let last_error = removed
                        .last_error
                        .clone()
                        .unwrap_or_else(|| "max delivery retries exceeded".to_string());
                    return Ok(DeliveryAttemptOutcome::Failed {
                        pending: Box::new(removed),
                        last_error,
                    });
                }
                return Ok(DeliveryAttemptOutcome::Noop);
            }
            Ok(DeliveryAttemptOutcome::Noop)
        }
    }
}

/// Headroom above the verification window and one tick.
///
/// Absorbs the quantisation of when a retry actually fires — the maintenance
/// tick — plus the clock-origin difference between the broker (frame written to
/// stdin) and the worker (paced injection complete). Named rather than a magic
/// literal so the reason survives.
const STEER_ACK_SLACK: Duration = Duration::from_millis(800);

pub(crate) fn delivery_ack_timeout(
    injection_mode: &MessageInjectionMode,
    retry_interval: Duration,
) -> Duration {
    let minimum = match injection_mode {
        MessageInjectionMode::Wait => WAIT_DELIVERY_ACK_TIMEOUT,
        MessageInjectionMode::Steer => {
            // Must exceed the LONGEST window any harness may use, plus a tick.
            // If the broker's retry fires while a worker is still inside its
            // echo window, it re-injects a message whose first copy is still
            // pending verification — a double delivery.
            //
            // Derived from `max_verification_window()` rather than the raw
            // constant so a per-CLI window that exceeded it would have to go
            // through the same accessor. `delivery_ack_timeout_outlasts_any_
            // verification_window` pins the ordering as a test-time fact.
            crate::broker::delivery_verification::max_verification_window()
                + crate::broker::delivery_verification::VERIFICATION_TICK
                + STEER_ACK_SLACK
        }
    };
    std::cmp::max(retry_interval, minimum)
}

pub(crate) async fn emit_delivery_attempt_outcome(
    sdk_out_tx: &mpsc::Sender<ProtocolEnvelope<Value>>,
    dead_letters: &mut DeadLetterStore,
    delivery_id: &DeliveryId,
    was_retry: bool,
    outcome: DeliveryAttemptOutcome,
) -> Result<()> {
    match outcome {
        DeliveryAttemptOutcome::Attempted {
            worker_name,
            attempts,
            event_id,
        } => {
            if was_retry {
                send_broker_event(
                    sdk_out_tx,
                    BrokerEvent::DeliveryRetry {
                        name: worker_name,
                        delivery_id: delivery_id.clone(),
                        event_id,
                        attempts,
                    },
                )
                .await?;
            }
        }
        DeliveryAttemptOutcome::Failed {
            pending,
            last_error,
        } => {
            // Notify best-effort: a closed SDK channel must not (via `?`) abort
            // before the dead-letter write below. The delivery has already been
            // removed from the pending map, so gating the DLQ capture on the
            // send would lose the terminally-failed delivery entirely.
            let _ = send_broker_event(
                sdk_out_tx,
                BrokerEvent::MessageDeliveryFailed {
                    name: pending.worker_name.clone(),
                    delivery_id: Some(pending.delivery.delivery_id.clone()),
                    event_id: Some(pending.delivery.event_id.clone()),
                    from: pending.delivery.from.clone(),
                    to: pending.delivery.target.clone(),
                    attempts: pending.attempts,
                    last_error: last_error.clone(),
                },
            )
            .await;
            // A dead-lettered delivery never actually landed, so any fleet
            // (engine-facing) ack withheld pending its confirmation must be
            // dropped rather than sent — the engine keeps its own record of
            // this delivery as un-acked and will redeliver it. See relay#1310:
            // the whole point of withholding the ack is that "enqueued for
            // injection" must not be reported the same as "delivered". The
            // withheld ack lives on `pending` itself, so it is dropped here
            // simply by `pending` going out of scope — nothing to remember to
            // clean up separately. See relay#1543.
            if pending.withheld_fleet_ack.is_some() {
                tracing::info!(
                    target = "relay_broker::fleet",
                    worker = %pending.worker_name,
                    delivery_id = %pending.delivery.delivery_id,
                    "dropping withheld fleet delivery_ack for dead-lettered delivery"
                );
            }
            dead_letter_pending_delivery(sdk_out_tx, dead_letters, &pending, &last_error).await;
        }
        DeliveryAttemptOutcome::TerminalInDoubt {
            pending,
            last_error,
        } => {
            let _ = send_broker_event(
                sdk_out_tx,
                BrokerEvent::MessageDeliveryFailed {
                    name: pending.worker_name.clone(),
                    delivery_id: Some(pending.delivery.delivery_id.clone()),
                    event_id: Some(pending.delivery.event_id.clone()),
                    from: pending.delivery.from.clone(),
                    to: pending.delivery.target.clone(),
                    attempts: pending.attempts,
                    last_error: last_error.clone(),
                },
            )
            .await;
            // Retain it, marked not-for-auto-redelivery.
            //
            // Dropping it silently was the only option that loses the message:
            // a killed child cannot have consumed it, and a broken pipe to a
            // dead process is not evidence of delivery, yet the entry vanished
            // with nothing but a warn line. Retaining it under a marker keeps
            // rule 1 — nothing retries a possible write — while leaving an
            // operator-visible record with the body intact.
            let reason = format!(
                "{}{last_error}",
                crate::runtime::dead_letter::IN_DOUBT_REASON_PREFIX
            );
            dead_letter_pending_delivery(sdk_out_tx, dead_letters, &pending, &reason).await;
            tracing::warn!(
                target = "agent_relay::broker",
                worker = %pending.worker_name,
                delivery_id = %pending.delivery.delivery_id,
                event_id = %pending.delivery.event_id,
                "delivery stopped in doubt after possible write; dead-lettered without auto-redelivery"
            );
        }
        DeliveryAttemptOutcome::Noop => {}
    }
    Ok(())
}

#[cfg(test)]
pub(crate) fn drop_pending_for_worker(
    pending_deliveries: &mut HashMap<DeliveryId, PendingDelivery>,
    worker_name: &str,
) -> usize {
    take_pending_for_worker(pending_deliveries, worker_name).len()
}

pub(crate) fn take_pending_for_worker(
    pending_deliveries: &mut HashMap<DeliveryId, PendingDelivery>,
    worker_name: &str,
) -> Vec<PendingDelivery> {
    let delivery_ids: Vec<DeliveryId> = pending_deliveries
        .iter()
        .filter(|(_, pending)| pending.worker_name.as_str() == worker_name)
        .map(|(delivery_id, _)| delivery_id.clone())
        .collect();

    delivery_ids
        .into_iter()
        .filter_map(|delivery_id| pending_deliveries.remove(&delivery_id))
        .collect()
}

/// Choke point for every worker-exit / teardown disposition (agent release,
/// permanent worker death, unsupervised exit): whatever removed these
/// `PendingDelivery`s from `pending_deliveries` (via [`take_pending_for_worker`])
/// already carried their withheld fleet acks along as a struct field, so this
/// is also the single place that drops them. See relay#1543.
pub(crate) async fn emit_dropped_delivery_failures(
    sdk_out_tx: &mpsc::Sender<ProtocolEnvelope<Value>>,
    dead_letters: &mut DeadLetterStore,
    dropped: &[PendingDelivery],
    reason: &str,
) -> Result<()> {
    for pending in dropped {
        if pending.withheld_fleet_ack.is_some() {
            tracing::info!(
                target = "relay_broker::fleet",
                worker = %pending.worker_name,
                delivery_id = %pending.delivery.delivery_id,
                reason = reason,
                "dropping withheld fleet delivery_ack for a delivery dropped from the pending map"
            );
        }
        // Notify best-effort: a send failure must not `?`-abort the loop and
        // strand the remaining dropped deliveries out of the dead-letter store.
        // The DLQ capture below runs regardless of the send's outcome.
        let _ = send_broker_event(
            sdk_out_tx,
            BrokerEvent::MessageDeliveryFailed {
                name: pending.worker_name.clone(),
                delivery_id: Some(pending.delivery.delivery_id.clone()),
                event_id: Some(pending.delivery.event_id.clone()),
                from: pending.delivery.from.clone(),
                to: pending.delivery.target.clone(),
                attempts: pending.attempts,
                last_error: reason.to_string(),
            },
        )
        .await;
        dead_letter_pending_delivery(sdk_out_tx, dead_letters, pending, reason).await;
    }
    Ok(())
}

/// Drain every in-flight worker request targeting `worker_name` and
/// notify each awaiter with [`worker_request::RequestWorkerError::WorkerDisappeared`].
/// Called from every worker-teardown path (explicit release or
/// `reap_exited` periodic sweep) so HTTP callers don't have to wait out
/// the request deadline when the worker has clearly gone. Logs one
/// structured warning per drained request.
pub(crate) fn fail_pending_requests_for_worker(
    pending_requests: &mut HashMap<String, worker_request::PendingRequest>,
    worker_name: &str,
    reason: &'static str,
) -> usize {
    let failed = worker_request::fail_for_worker(pending_requests, worker_name);
    for (req_id, kind) in &failed {
        tracing::warn!(
            target = "agent_relay::broker",
            request_id = %req_id,
            worker = %worker_name,
            kind = %kind,
            reason = reason,
            "failed pending worker request because worker is gone"
        );
    }
    failed.len()
}

pub(crate) fn should_clear_pending_delivery_for_event(
    pending: Option<&PendingDelivery>,
    event_id: Option<&str>,
) -> bool {
    let Some(pending) = pending else {
        return true;
    };

    let Some(event_id) = event_id
        .map(str::trim)
        .filter(|event_id| !event_id.is_empty())
    else {
        return true;
    };

    pending.delivery.event_id == event_id
}

pub(crate) fn clear_pending_delivery_if_event_matches(
    pending_deliveries: &mut HashMap<DeliveryId, PendingDelivery>,
    delivery_id: &str,
    event_id: Option<&str>,
    worker_name: &str,
    worker_signal: &str,
) -> Option<PendingDelivery> {
    let pending = pending_deliveries.get(delivery_id);
    if should_clear_pending_delivery_for_event(pending, event_id) {
        return pending_deliveries.remove(delivery_id);
    }

    if let Some(pending) = pending {
        tracing::warn!(
            target = "agent_relay::broker",
            worker = %worker_name,
            signal = %worker_signal,
            delivery_id = %delivery_id,
            expected_event_id = %pending.delivery.event_id,
            received_event_id = %event_id.unwrap_or(""),
            "ignoring stale delivery lifecycle event due to event_id mismatch"
        );
    }
    None
}

#[cfg(test)]
mod reply_target_tests {
    use super::is_relaycast_reply_target;

    #[test]
    fn real_message_ids_are_reply_targets() {
        assert!(is_relaycast_reply_target("msg_abc123"));
        assert!(is_relaycast_reply_target("evt_01hxyz"));
    }

    #[test]
    fn synthetic_and_grouping_ids_are_not_reply_targets() {
        for id in [
            "",
            "   ",
            "#general",
            "direct:alice",
            "http_deadbeef",
            "init_task",
            "cont_load_1",
            "flush_1",
        ] {
            assert!(
                !is_relaycast_reply_target(id),
                "expected non-target: {id:?}"
            );
        }
    }
}

#[cfg(test)]
mod steer_timing_invariants {
    use super::delivery_ack_timeout;
    use crate::broker::delivery_verification::{max_verification_window, VERIFICATION_TICK};
    use crate::protocol::MessageInjectionMode;
    use std::time::Duration;

    /// relay: F8 — the broker's Steer retry must never fire inside a worker's
    /// verification window.
    ///
    /// If it does, the broker re-injects a message whose first copy is still
    /// pending verification: a double delivery produced by the retry machinery
    /// itself, not by any transport fault. These were two constants that
    /// happened to be ordered; this makes the ordering a fact a change has to
    /// break deliberately.
    #[test]
    fn delivery_ack_timeout_outlasts_any_verification_window() {
        let timeout = delivery_ack_timeout(&MessageInjectionMode::Steer, Duration::ZERO);
        assert!(
            timeout > max_verification_window() + VERIFICATION_TICK,
            "Steer ack timeout {timeout:?} does not outlast the longest verification window \
             {:?} plus a tick {VERIFICATION_TICK:?}: a retry can fire while the worker is \
             still waiting for an echo",
            max_verification_window()
        );
    }
}
