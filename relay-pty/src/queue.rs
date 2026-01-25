//! Message queue with priority and flow control.
//!
//! Handles queuing of injection messages with:
//! - Priority ordering (lower number = higher priority)
//! - Backpressure signaling when queue is full
//! - Deduplication by message ID
//! - Retry tracking

use crate::protocol::{InjectResponse, InjectStatus, QueuedMessage};
use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap};
use std::time::{Duration, Instant};
use tokio::sync::{broadcast, Mutex, Notify};
use tracing::{debug, info, warn};

/// Default time-to-live for seen message IDs (5 minutes)
/// After this duration, IDs are eligible for cleanup to prevent unbounded growth
const DEFAULT_SEEN_ID_TTL_SECS: u64 = 300;

/// Default cleanup interval (60 seconds)
const DEFAULT_CLEANUP_INTERVAL_SECS: u64 = 60;

/// Wrapper for priority queue ordering (reversed for min-heap behavior)
#[derive(Debug)]
struct PriorityMessage(QueuedMessage);

impl PartialEq for PriorityMessage {
    fn eq(&self, other: &Self) -> bool {
        self.0.id == other.0.id
    }
}

impl Eq for PriorityMessage {}

impl PartialOrd for PriorityMessage {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for PriorityMessage {
    fn cmp(&self, other: &Self) -> Ordering {
        // Reverse ordering for min-heap (lower priority number = higher priority)
        other
            .0
            .priority
            .cmp(&self.0.priority)
            .then_with(|| other.0.queued_at.cmp(&self.0.queued_at))
    }
}

/// Message queue with priority ordering and backpressure
pub struct MessageQueue {
    /// Priority queue of messages
    queue: Mutex<BinaryHeap<PriorityMessage>>,
    /// Map of message IDs to their insertion time for deduplication with TTL
    seen_ids: Mutex<HashMap<String, Instant>>,
    /// Maximum queue size before backpressure
    max_size: usize,
    /// Notifier for new messages
    notify: Notify,
    /// Broadcast channel for sending responses (multiple receivers can subscribe)
    response_tx: broadcast::Sender<InjectResponse>,
    /// Last time we cleaned up expired seen_ids
    last_cleanup: Mutex<Instant>,
    /// TTL for seen message IDs (configurable for long-running sessions)
    seen_id_ttl: Duration,
    /// Interval between cleanup runs
    cleanup_interval: Duration,
}

impl MessageQueue {
    /// Create a new message queue with default TTL settings
    pub fn new(max_size: usize, response_tx: broadcast::Sender<InjectResponse>) -> Self {
        Self::with_ttl(
            max_size,
            response_tx,
            DEFAULT_SEEN_ID_TTL_SECS,
            DEFAULT_CLEANUP_INTERVAL_SECS,
        )
    }

    /// Create a new message queue with configurable TTL settings
    /// For long-running sessions with 200+ agents, consider:
    /// - seen_ttl_secs: 120-180 (2-3 minutes)
    /// - cleanup_interval_secs: 30 (more frequent cleanup)
    pub fn with_ttl(
        max_size: usize,
        response_tx: broadcast::Sender<InjectResponse>,
        seen_ttl_secs: u64,
        cleanup_interval_secs: u64,
    ) -> Self {
        info!(
            "MessageQueue created: max_size={}, seen_ttl={}s, cleanup_interval={}s",
            max_size, seen_ttl_secs, cleanup_interval_secs
        );
        Self {
            queue: Mutex::new(BinaryHeap::new()),
            seen_ids: Mutex::new(HashMap::new()),
            max_size,
            notify: Notify::new(),
            response_tx,
            last_cleanup: Mutex::new(Instant::now()),
            seen_id_ttl: Duration::from_secs(seen_ttl_secs),
            cleanup_interval: Duration::from_secs(cleanup_interval_secs),
        }
    }

    /// Subscribe to response notifications
    pub fn subscribe_responses(&self) -> broadcast::Receiver<InjectResponse> {
        self.response_tx.subscribe()
    }

    /// Add a message to the queue
    ///
    /// Returns `true` if added, `false` if duplicate or backpressure
    pub async fn enqueue(&self, msg: QueuedMessage) -> bool {
        // Periodically clean up expired seen_ids based on configured interval
        {
            let mut last_cleanup = self.last_cleanup.lock().await;
            if last_cleanup.elapsed() > self.cleanup_interval {
                *last_cleanup = Instant::now();
                drop(last_cleanup); // Release lock before cleanup
                self.cleanup_expired_ids().await;
            }
        }

        // Check for duplicate
        {
            let mut seen = self.seen_ids.lock().await;
            if seen.contains_key(&msg.id) {
                debug!("Duplicate message ID: {}", msg.id);
                return false;
            }
            seen.insert(msg.id.clone(), Instant::now());
        }

        let mut queue = self.queue.lock().await;

        // Check backpressure
        if queue.len() >= self.max_size {
            warn!(
                "Queue at capacity ({}), rejecting message {}",
                self.max_size, msg.id
            );

            // Send backpressure notification
            let _ = self.response_tx.send(InjectResponse::Backpressure {
                queue_length: queue.len(),
                accept: false,
            });

            return false;
        }

        let msg_id = msg.id.clone();
        queue.push(PriorityMessage(msg));
        debug!("Enqueued message {}, queue size: {}", msg_id, queue.len());

        // Send queued response (broadcast to all subscribers)
        let _ = self.response_tx.send(InjectResponse::InjectResult {
            id: msg_id,
            status: InjectStatus::Queued,
            timestamp: current_timestamp_ms(),
            error: None,
        });

        // Notify waiters
        self.notify.notify_one();

        // Send backpressure recovery if we were near capacity
        if queue.len() == self.max_size / 2 {
            let _ = self.response_tx.send(InjectResponse::Backpressure {
                queue_length: queue.len(),
                accept: true,
            });
        }

        true
    }

    /// Get the next message from the queue
    pub async fn dequeue(&self) -> Option<QueuedMessage> {
        let mut queue = self.queue.lock().await;
        queue.pop().map(|pm| pm.0)
    }

    /// Wait for a message to be available and dequeue it
    pub async fn wait_and_dequeue(&self) -> QueuedMessage {
        loop {
            // IMPORTANT: Create the notified future BEFORE checking the queue.
            // This prevents a race condition where:
            // 1. We check the queue and find it empty
            // 2. A message arrives and notify_one() is called
            // 3. We start waiting on notified() - but the notification was already lost!
            //
            // By creating the future first, any notification that happens after
            // we start checking the queue will still wake us up.
            let notified = self.notify.notified();

            // Check if there's a message
            {
                let mut queue = self.queue.lock().await;
                if let Some(pm) = queue.pop() {
                    return pm.0;
                }
            }

            // Wait for notification - safe because we created the future before checking
            notified.await;
        }
    }

    /// Peek at the next message without removing it
    pub async fn peek(&self) -> Option<QueuedMessage> {
        let queue = self.queue.lock().await;
        queue.peek().map(|pm| pm.0.clone())
    }

    /// Get the current queue length
    pub async fn len(&self) -> usize {
        self.queue.lock().await.len()
    }

    /// Check if queue is empty
    pub async fn is_empty(&self) -> bool {
        self.queue.lock().await.is_empty()
    }

    /// Re-enqueue a message for retry (increments retry count)
    pub async fn retry(&self, mut msg: QueuedMessage) {
        msg.retries += 1;
        msg.queued_at = Instant::now();

        let mut queue = self.queue.lock().await;
        queue.push(PriorityMessage(msg));
        self.notify.notify_one();
    }

    /// Report injection result (broadcast to all subscribers)
    pub fn report_result(&self, id: String, status: InjectStatus, error: Option<String>) {
        let short_id = &id[..id.len().min(8)];
        debug!("Broadcasting status {:?} for message {}", status, short_id);

        match self.response_tx.send(InjectResponse::InjectResult {
            id: id.clone(),
            status,
            timestamp: current_timestamp_ms(),
            error,
        }) {
            Ok(receiver_count) => {
                debug!(
                    "Broadcast sent to {} receivers for message {}",
                    receiver_count, short_id
                );
            }
            Err(e) => {
                warn!(
                    "Failed to broadcast status for message {}: {:?}",
                    short_id, e
                );
            }
        }
    }

    /// Clear seen IDs (for long-running sessions)
    pub async fn clear_seen(&self) {
        let mut seen = self.seen_ids.lock().await;
        let before = seen.len();
        seen.clear();
        info!("Cleared {} seen message IDs", before);
    }

    /// Remove expired IDs from the seen set based on TTL
    /// This prevents unbounded growth of seen_ids over long sessions
    async fn cleanup_expired_ids(&self) {
        let mut seen = self.seen_ids.lock().await;
        let before = seen.len();
        let now = Instant::now();
        let ttl = self.seen_id_ttl;

        seen.retain(|_id, timestamp| now.duration_since(*timestamp) < ttl);

        let removed = before - seen.len();
        if removed > 0 {
            info!(
                "Cleaned up {} expired seen IDs ({} remaining, ttl={}s)",
                removed,
                seen.len(),
                ttl.as_secs()
            );
        }
    }

    /// Mark a message as delivered, removing it from the seen set
    /// This allows the ID to be reused if needed (e.g., for retries from a new sender)
    pub async fn mark_delivered(&self, id: &str) {
        let mut seen = self.seen_ids.lock().await;
        if seen.remove(id).is_some() {
            debug!(
                "Removed delivered message {} from seen set",
                &id[..id.len().min(8)]
            );
        }
    }

    /// Get queue statistics
    pub async fn stats(&self) -> QueueStats {
        let queue = self.queue.lock().await;
        let seen = self.seen_ids.lock().await;

        QueueStats {
            queue_length: queue.len(),
            max_size: self.max_size,
            seen_count: seen.len(),
        }
    }
}

/// Queue statistics
#[derive(Debug, Clone)]
pub struct QueueStats {
    pub queue_length: usize,
    pub max_size: usize,
    pub seen_count: usize,
}

/// Get current timestamp in milliseconds
fn current_timestamp_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_priority_ordering() {
        let (tx, _rx) = broadcast::channel(16);
        let queue = MessageQueue::new(10, tx);

        // Enqueue messages with different priorities
        queue
            .enqueue(QueuedMessage::new(
                "low".to_string(),
                "A".to_string(),
                "Low priority".to_string(),
                10,
            ))
            .await;

        queue
            .enqueue(QueuedMessage::new(
                "high".to_string(),
                "A".to_string(),
                "High priority".to_string(),
                1,
            ))
            .await;

        queue
            .enqueue(QueuedMessage::new(
                "medium".to_string(),
                "A".to_string(),
                "Medium priority".to_string(),
                5,
            ))
            .await;

        // Dequeue should return highest priority first
        let msg1 = queue.dequeue().await.unwrap();
        assert_eq!(msg1.id, "high");

        let msg2 = queue.dequeue().await.unwrap();
        assert_eq!(msg2.id, "medium");

        let msg3 = queue.dequeue().await.unwrap();
        assert_eq!(msg3.id, "low");
    }

    #[tokio::test]
    async fn test_deduplication() {
        let (tx, _rx) = broadcast::channel(16);
        let queue = MessageQueue::new(10, tx);

        let result1 = queue
            .enqueue(QueuedMessage::new(
                "dup".to_string(),
                "A".to_string(),
                "First".to_string(),
                0,
            ))
            .await;
        assert!(result1);

        let result2 = queue
            .enqueue(QueuedMessage::new(
                "dup".to_string(),
                "A".to_string(),
                "Second".to_string(),
                0,
            ))
            .await;
        assert!(!result2); // Should be rejected as duplicate

        assert_eq!(queue.len().await, 1);
    }

    #[tokio::test]
    async fn test_backpressure() {
        let (tx, _rx) = broadcast::channel(16);
        let queue = MessageQueue::new(2, tx);

        queue
            .enqueue(QueuedMessage::new(
                "1".to_string(),
                "A".to_string(),
                "Msg 1".to_string(),
                0,
            ))
            .await;

        queue
            .enqueue(QueuedMessage::new(
                "2".to_string(),
                "A".to_string(),
                "Msg 2".to_string(),
                0,
            ))
            .await;

        // Third message should be rejected
        let result = queue
            .enqueue(QueuedMessage::new(
                "3".to_string(),
                "A".to_string(),
                "Msg 3".to_string(),
                0,
            ))
            .await;
        assert!(!result);
    }
}
