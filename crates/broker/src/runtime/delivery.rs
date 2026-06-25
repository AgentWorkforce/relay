use super::*;

#[derive(Debug, Clone)]
pub(crate) struct PendingDelivery {
    pub(super) worker_name: WorkerName,
    pub(super) delivery: RelayDelivery,
    pub(super) attempts: u32,
    pub(super) next_retry_at: Instant,
    pub(super) queued_at_ms: u64,
    pub(super) last_error: Option<String>,
}

/// Serializable snapshot of pending deliveries for crash recovery.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct PersistedPendingDelivery {
    pub(super) worker_name: WorkerName,
    pub(super) delivery: RelayDelivery,
    pub(super) attempts: u32,
    #[serde(default)]
    pub(super) queued_at_ms: u64,
    #[serde(default)]
    pub(super) last_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum DeliveryAttemptOutcome {
    Attempted {
        worker_name: WorkerName,
        attempts: u32,
        event_id: EventId,
    },
    Failed {
        worker_name: WorkerName,
        delivery_id: DeliveryId,
        event_id: EventId,
        from: String,
        to: MessageTarget,
        attempts: u32,
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
            queued_at_ms: pd.queued_at_ms,
            last_error: pd.last_error.clone(),
        })
        .collect();
    let json = serde_json::to_string_pretty(&persisted)?;
    let dir = path.parent().unwrap_or(path);
    let mut tmp = tempfile::NamedTempFile::new_in(dir)
        .with_context(|| format!("failed creating temp file in {}", dir.display()))?;
    std::io::Write::write_all(&mut tmp, json.as_bytes())?;
    tmp.persist(path)
        .with_context(|| format!("failed persisting pending deliveries to {}", path.display()))?;
    Ok(())
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
    persisted
        .into_iter()
        .map(|p| {
            let id = p.delivery.delivery_id.clone();
            (
                id,
                PendingDelivery {
                    worker_name: p.worker_name,
                    delivery: p.delivery,
                    attempts: p.attempts,
                    next_retry_at: Instant::now(), // retry immediately on restart
                    queued_at_ms: if p.queued_at_ms == 0 {
                        unix_timestamp_millis()
                    } else {
                        p.queued_at_ms
                    },
                    last_error: p.last_error,
                },
            )
        })
        .collect()
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

pub(crate) async fn try_inject_pending_relay_message(
    workers: &mut WorkerRegistry,
    pending_deliveries: &mut HashMap<DeliveryId, PendingDelivery>,
    worker_name: &str,
    msg: &PendingRelayMessage,
    retry_interval: Duration,
) -> Result<()> {
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

/// Inject a previously-queued pending relay message into the worker via
/// the existing `queue_and_try_delivery_raw` path. Used by the
/// `/api/spawned/{name}/flush` handler and by the auto-drain on a
/// `manual_flush → auto_inject` transition. Failures are logged but not
/// propagated — the broker treats `flush` as best-effort fire-and-forget
/// the same way `/api/send` does for individual targets.
pub(crate) async fn inject_pending_relay_message(
    workers: &mut WorkerRegistry,
    pending_deliveries: &mut HashMap<DeliveryId, PendingDelivery>,
    worker_name: &str,
    msg: &PendingRelayMessage,
    retry_interval: Duration,
) {
    let event_id = msg.event_id.as_deref().unwrap_or("");
    if let Err(error) = try_inject_pending_relay_message(
        workers,
        pending_deliveries,
        worker_name,
        msg,
        retry_interval,
    )
    .await
    {
        tracing::warn!(
            target = "agent_relay::broker",
            worker = %worker_name,
            from = %msg.from,
            event_id = %event_id,
            error = %error,
            "failed to inject pending relay message during flush"
        );
    }
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
) -> Result<()> {
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
    let delivery_id = delivery.delivery_id.clone();
    pending_deliveries.insert(
        delivery_id.clone(),
        PendingDelivery {
            worker_name: WorkerName::new(worker_name),
            delivery,
            attempts: 0,
            next_retry_at: Instant::now(),
            queued_at_ms: unix_timestamp_millis(),
            last_error: None,
        },
    );

    if let DeliveryAttemptOutcome::Failed { last_error, .. } =
        retry_pending_delivery(&delivery_id, workers, pending_deliveries, retry_interval).await?
    {
        anyhow::bail!(last_error);
    }
    Ok(())
}

pub(crate) async fn retry_pending_delivery(
    delivery_id: &DeliveryId,
    workers: &mut WorkerRegistry,
    pending_deliveries: &mut HashMap<DeliveryId, PendingDelivery>,
    retry_interval: Duration,
) -> Result<DeliveryAttemptOutcome> {
    let pending = match pending_deliveries.get(delivery_id) {
        Some(pending) => pending.clone(),
        None => return Ok(DeliveryAttemptOutcome::Noop),
    };

    if pending.attempts >= MAX_DELIVERY_RETRIES {
        let removed = pending_deliveries.remove(delivery_id).unwrap_or(pending);
        return Ok(DeliveryAttemptOutcome::Failed {
            worker_name: removed.worker_name,
            delivery_id: removed.delivery.delivery_id,
            event_id: removed.delivery.event_id,
            from: removed.delivery.from,
            to: removed.delivery.target,
            attempts: removed.attempts,
            last_error: removed
                .last_error
                .unwrap_or_else(|| "max delivery retries exceeded".to_string()),
        });
    }

    if !workers.has_worker(&pending.worker_name) {
        let removed = pending_deliveries.remove(delivery_id).unwrap_or(pending);
        return Ok(DeliveryAttemptOutcome::Failed {
            worker_name: removed.worker_name,
            delivery_id: removed.delivery.delivery_id,
            event_id: removed.delivery.event_id,
            from: removed.delivery.from,
            to: removed.delivery.target,
            attempts: removed.attempts,
            last_error: "recipient gone".to_string(),
        });
    }

    match workers
        .deliver(&pending.worker_name, pending.delivery.clone())
        .await
    {
        Ok(()) => {
            if let Some(current) = pending_deliveries.get_mut(delivery_id) {
                current.attempts = current.attempts.saturating_add(1);
                current.next_retry_at = Instant::now() + retry_interval;
                current.last_error = None;
                return Ok(DeliveryAttemptOutcome::Attempted {
                    worker_name: current.worker_name.clone(),
                    attempts: current.attempts,
                    event_id: current.delivery.event_id.clone(),
                });
            }
            Ok(DeliveryAttemptOutcome::Noop)
        }
        Err(error) => {
            let should_fail = if let Some(current) = pending_deliveries.get_mut(delivery_id) {
                current.attempts = current.attempts.saturating_add(1);
                current.next_retry_at = Instant::now() + retry_interval;
                current.last_error = Some(error.to_string());
                current.attempts >= MAX_DELIVERY_RETRIES
            } else {
                false
            };

            if should_fail {
                if let Some(removed) = pending_deliveries.remove(delivery_id) {
                    return Ok(DeliveryAttemptOutcome::Failed {
                        worker_name: removed.worker_name,
                        delivery_id: removed.delivery.delivery_id,
                        event_id: removed.delivery.event_id,
                        from: removed.delivery.from,
                        to: removed.delivery.target,
                        attempts: removed.attempts,
                        last_error: removed
                            .last_error
                            .unwrap_or_else(|| "max delivery retries exceeded".to_string()),
                    });
                }
                return Ok(DeliveryAttemptOutcome::Noop);
            }
            Ok(DeliveryAttemptOutcome::Noop)
        }
    }
}

pub(crate) async fn emit_delivery_attempt_outcome(
    sdk_out_tx: &mpsc::Sender<ProtocolEnvelope<Value>>,
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
            worker_name,
            delivery_id,
            event_id,
            from,
            to,
            attempts,
            last_error,
        } => {
            send_broker_event(
                sdk_out_tx,
                BrokerEvent::MessageDeliveryFailed {
                    name: worker_name,
                    delivery_id: Some(delivery_id),
                    event_id: Some(event_id),
                    from,
                    to,
                    attempts,
                    last_error,
                },
            )
            .await?;
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

pub(crate) async fn emit_dropped_delivery_failures(
    sdk_out_tx: &mpsc::Sender<ProtocolEnvelope<Value>>,
    dropped: &[PendingDelivery],
    reason: &str,
) -> Result<()> {
    for pending in dropped {
        send_broker_event(
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
        .await?;
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
