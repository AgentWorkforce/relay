use super::*;

/// Maximum dead letters retained before the oldest entry is evicted.
pub(crate) const MAX_DEAD_LETTERS: usize = 500;

/// A delivery that terminally failed (retry cap exhausted or the recipient
/// is gone) and was moved out of the pending map instead of being discarded.
/// Retains the full [`RelayDelivery`] so `redeliver` can requeue it through
/// the normal delivery path.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct DeadLetterEntry {
    pub(super) worker_name: WorkerName,
    pub(super) delivery: RelayDelivery,
    pub(super) attempts: u32,
    pub(super) reason: String,
    /// When the delivery was first queued (unix millis).
    #[serde(default)]
    pub(super) queued_at_ms: u64,
    /// When the delivery terminally failed (unix millis).
    #[serde(default)]
    pub(super) failed_at_ms: u64,
}

impl DeadLetterEntry {
    pub(crate) fn from_pending(pending: &PendingDelivery, reason: &str) -> Self {
        Self {
            worker_name: pending.worker_name.clone(),
            delivery: pending.delivery.clone(),
            attempts: pending.attempts,
            reason: reason.to_string(),
            queued_at_ms: pending.queued_at_ms,
            failed_at_ms: unix_timestamp_millis(),
        }
    }
}

/// Bounded FIFO of terminally-failed deliveries with dirty tracking, mirroring
/// [`PendingDeliveryStore`]: mutations mark the store dirty and the event loop
/// persists the snapshot right after the mutating event. Entries are ordered
/// oldest-first; the cap evicts the oldest with a warning.
#[derive(Debug, Default)]
pub(crate) struct DeadLetterStore {
    entries: VecDeque<DeadLetterEntry>,
    dirty: bool,
}

impl DeadLetterStore {
    pub(crate) fn new(entries: Vec<DeadLetterEntry>) -> Self {
        Self {
            entries: entries.into(),
            dirty: false,
        }
    }

    /// Return whether the store was mutated since the last call, clearing the flag.
    pub(crate) fn take_dirty(&mut self) -> bool {
        std::mem::take(&mut self.dirty)
    }

    /// Append an entry, evicting (and returning) the oldest one when the
    /// store is at [`MAX_DEAD_LETTERS`].
    pub(crate) fn push(&mut self, entry: DeadLetterEntry) -> Option<DeadLetterEntry> {
        self.dirty = true;
        let evicted = if self.entries.len() >= MAX_DEAD_LETTERS {
            let evicted = self.entries.pop_front();
            if let Some(ref old) = evicted {
                tracing::warn!(
                    target = "agent_relay::broker",
                    delivery_id = %old.delivery.delivery_id,
                    worker = %old.worker_name,
                    max_dead_letters = MAX_DEAD_LETTERS,
                    "dead-letter queue full — evicting oldest entry"
                );
            }
            evicted
        } else {
            None
        };
        self.entries.push_back(entry);
        evicted
    }

    pub(crate) fn remove(&mut self, delivery_id: &str) -> Option<DeadLetterEntry> {
        let index = self
            .entries
            .iter()
            .position(|entry| entry.delivery.delivery_id.as_str() == delivery_id)?;
        self.dirty = true;
        self.entries.remove(index)
    }

    pub(crate) fn get(&self, delivery_id: &str) -> Option<&DeadLetterEntry> {
        self.entries
            .iter()
            .find(|entry| entry.delivery.delivery_id.as_str() == delivery_id)
    }

    pub(crate) fn iter(&self) -> impl Iterator<Item = &DeadLetterEntry> {
        self.entries.iter()
    }

    pub(crate) fn delivery_ids(&self) -> Vec<DeliveryId> {
        self.entries
            .iter()
            .map(|entry| entry.delivery.delivery_id.clone())
            .collect()
    }

    pub(crate) fn len(&self) -> usize {
        self.entries.len()
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

pub(crate) fn save_dead_letters(path: &Path, store: &DeadLetterStore) -> Result<()> {
    let entries: Vec<&DeadLetterEntry> = store.iter().collect();
    crate::util::fs::write_json_atomic(path, &entries)
}

pub(crate) fn load_dead_letters(path: &Path) -> Vec<DeadLetterEntry> {
    let data = match std::fs::read_to_string(path) {
        Ok(d) => d,
        Err(_) => return Vec::new(),
    };
    serde_json::from_str(&data).unwrap_or_default()
}

/// Persist or remove the dead-letter file during graceful shutdown. Unlike
/// pending deliveries the entries are terminal, so this only keeps the
/// snapshot in sync: write when non-empty, remove when empty.
pub(crate) fn persist_dead_letters_on_shutdown(
    path: &Path,
    persist: bool,
    store: &DeadLetterStore,
) {
    if !persist {
        return;
    }
    if store.is_empty() {
        let _ = std::fs::remove_file(path);
        return;
    }
    if let Err(error) = save_dead_letters(path, store) {
        tracing::warn!(
            path = %path.display(),
            error = %error,
            "failed to persist dead letters during shutdown"
        );
    }
}

/// Move a dead-letter entry back into the pending map so the normal
/// delivery/retry path picks it up on the next maintenance tick. Resets the
/// retry count and clears the recorded error. Returns the requeued
/// [`PendingDelivery`] or `None` when the id is not in the dead-letter store.
pub(crate) fn requeue_dead_letter(
    dead_letters: &mut DeadLetterStore,
    pending_deliveries: &mut HashMap<DeliveryId, PendingDelivery>,
    delivery_id: &str,
) -> Option<PendingDelivery> {
    let entry = dead_letters.remove(delivery_id)?;
    let pending = PendingDelivery {
        worker_name: entry.worker_name,
        delivery: entry.delivery,
        attempts: 0,
        next_retry_at: Instant::now(),
        queued_at_ms: entry.queued_at_ms,
        last_error: None,
    };
    pending_deliveries.insert(pending.delivery.delivery_id.clone(), pending.clone());
    Some(pending)
}

/// Push a terminally-failed pending delivery into the dead-letter store and
/// emit the `dead_letter_added` broker event (plus the cap-eviction warning
/// handled inside [`DeadLetterStore::push`]).
pub(crate) async fn dead_letter_pending_delivery(
    sdk_out_tx: &mpsc::Sender<ProtocolEnvelope<Value>>,
    dead_letters: &mut DeadLetterStore,
    pending: &PendingDelivery,
    reason: &str,
) {
    let entry = DeadLetterEntry::from_pending(pending, reason);
    let event = BrokerEvent::DeadLetterAdded {
        name: entry.worker_name.clone(),
        delivery_id: entry.delivery.delivery_id.clone(),
        event_id: entry.delivery.event_id.clone(),
        from: entry.delivery.from.clone(),
        to: entry.delivery.target.clone(),
        attempts: entry.attempts,
        reason: entry.reason.clone(),
    };
    dead_letters.push(entry);
    let _ = send_broker_event(sdk_out_tx, event).await;
}
