use super::*;

#[derive(Debug, Clone)]
pub(crate) struct PendingDelivery {
    pub(super) worker_name: String,
    pub(super) delivery: RelayDelivery,
    pub(super) attempts: u32,
    pub(super) next_retry_at: Instant,
    pub(super) queued_at_ms: u64,
    pub(super) last_error: Option<String>,
}

/// Serializable snapshot of pending deliveries for crash recovery.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct PersistedPendingDelivery {
    pub(super) worker_name: String,
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
        worker_name: String,
        attempts: u32,
        event_id: String,
    },
    Failed {
        worker_name: String,
        delivery_id: String,
        event_id: String,
        from: String,
        to: String,
        attempts: u32,
        last_error: String,
    },
    Noop,
}

pub(crate) fn unix_timestamp_millis() -> u64 {
    chrono::Utc::now().timestamp_millis().max(0) as u64
}

pub(crate) fn save_pending_deliveries(
    path: &Path,
    deliveries: &HashMap<String, PendingDelivery>,
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

pub(crate) fn load_pending_deliveries(path: &Path) -> HashMap<String, PendingDelivery> {
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
    pub(super) name: String,
    pub(super) pid: u32,
    pub(super) memory_bytes: u64,
    pub(super) uptime_secs: u64,
}

#[derive(Debug, Deserialize)]
pub(crate) struct DeliveryAckPayload {
    pub(super) delivery_id: String,
    pub(super) event_id: String,
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
    delivery_states: &mut HashMap<String, InboundDeliveryState>,
    workers: &WorkerRegistry,
    worker_name: &str,
    ctx: InboundContext<'_>,
) -> InboundQueueOutcome {
    if !workers.has_worker(worker_name) {
        return InboundQueueOutcome::WorkerMissing;
    }
    let state = delivery_states.entry(worker_name.to_string()).or_default();
    let should_drain = state.should_drain_immediately();
    let queued_at_ms = chrono::Utc::now().timestamp_millis().max(0) as u64;
    let msg = PendingRelayMessage {
        from: ctx.from.to_string(),
        body: ctx.body.to_string(),
        target: ctx.target.to_string(),
        thread_id: ctx.thread_id.map(str::to_string),
        workspace_id: ctx.workspace_id.map(str::to_string),
        workspace_alias: ctx.workspace_alias.map(str::to_string),
        priority: ctx.priority,
        mode: ctx.mode,
        queued_at_ms,
        event_id: ctx.event_id.map(str::to_string),
    };
    match state.accept_inbound(msg) {
        InboundDeliveryDispatch::Queued { queue_len } => {
            tracing::debug!(
                target = "agent_relay::broker",
                worker = %worker_name,
                from = %ctx.from,
                mode = state.mode.as_wire_str(),
                queue_len,
                "queued inbound relay message"
            );
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
        }
    }
    if should_drain {
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
    }
}

pub(crate) async fn try_inject_pending_relay_message(
    workers: &mut WorkerRegistry,
    pending_deliveries: &mut HashMap<String, PendingDelivery>,
    worker_name: &str,
    msg: &PendingRelayMessage,
    retry_interval: Duration,
) -> Result<()> {
    let event_id = msg
        .event_id
        .clone()
        .unwrap_or_else(|| format!("flush_{}", Uuid::new_v4().simple()));
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
    pending_deliveries: &mut HashMap<String, PendingDelivery>,
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

pub(crate) async fn queue_and_try_delivery(
    workers: &mut WorkerRegistry,
    pending_deliveries: &mut HashMap<String, PendingDelivery>,
    worker_name: &str,
    mapped: &crate::types::InboundRelayEvent,
    retry_interval: Duration,
) -> Result<()> {
    queue_and_try_delivery_raw(
        workers,
        pending_deliveries,
        worker_name,
        &mapped.event_id,
        &mapped.from,
        &mapped.target,
        &mapped.text,
        mapped.thread_id.clone(),
        Some(mapped.workspace_id.clone()),
        mapped.workspace_alias.clone(),
        mapped.priority.as_u8(),
        MessageInjectionMode::Wait,
        retry_interval,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn queue_and_try_delivery_raw(
    workers: &mut WorkerRegistry,
    pending_deliveries: &mut HashMap<String, PendingDelivery>,
    worker_name: &str,
    event_id: &str,
    from: &str,
    target: &str,
    body: &str,
    thread_id: Option<String>,
    workspace_id: Option<String>,
    workspace_alias: Option<String>,
    priority: u8,
    injection_mode: MessageInjectionMode,
    retry_interval: Duration,
) -> Result<()> {
    let delivery = RelayDelivery {
        delivery_id: format!("del_{}", Uuid::new_v4().simple()),
        event_id: event_id.to_string(),
        workspace_id,
        workspace_alias,
        from: from.to_string(),
        target: target.to_string(),
        body: body.to_string(),
        thread_id,
        priority: Some(priority),
        injection_mode,
    };
    let delivery_id = delivery.delivery_id.clone();
    pending_deliveries.insert(
        delivery_id.clone(),
        PendingDelivery {
            worker_name: worker_name.to_string(),
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
    delivery_id: &str,
    workers: &mut WorkerRegistry,
    pending_deliveries: &mut HashMap<String, PendingDelivery>,
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
            Err(error)
        }
    }
}

pub(crate) async fn emit_delivery_attempt_outcome(
    sdk_out_tx: &mpsc::Sender<ProtocolEnvelope<Value>>,
    delivery_id: &str,
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
                        delivery_id: delivery_id.to_string(),
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

pub(crate) fn drop_pending_for_worker(
    pending_deliveries: &mut HashMap<String, PendingDelivery>,
    worker_name: &str,
) -> usize {
    let before = pending_deliveries.len();
    pending_deliveries.retain(|_, pending| pending.worker_name != worker_name);
    before.saturating_sub(pending_deliveries.len())
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
    pending_deliveries: &mut HashMap<String, PendingDelivery>,
    delivery_id: &str,
    event_id: Option<&str>,
    worker_name: &str,
    worker_signal: &str,
) {
    let pending = pending_deliveries.get(delivery_id);
    if should_clear_pending_delivery_for_event(pending, event_id) {
        pending_deliveries.remove(delivery_id);
        return;
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
}
