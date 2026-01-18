//! Injection logic for delivering messages to the agent.
//!
//! Handles:
//! - Waiting for injection window (agent idle)
//! - Writing message to PTY
//! - Verifying injection success
//! - Retry logic

use crate::parser::ParseResult;
use crate::protocol::{Config, InjectStatus, QueuedMessage};
use crate::queue::MessageQueue;
use anyhow::Result;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, Mutex};
use tracing::{debug, error, info, warn};

/// Injection manager
pub struct Injector {
    /// Channel for sending data to PTY
    pty_tx: mpsc::Sender<Vec<u8>>,
    /// Message queue
    queue: Arc<MessageQueue>,
    /// Configuration
    config: Config,
    /// Whether agent is currently idle
    is_idle: AtomicBool,
    /// Timestamp of last output (ms since epoch)
    last_output_ms: AtomicU64,
    /// Recent output buffer for verification
    recent_output: Mutex<String>,
}

// Injector is Send+Sync safe
unsafe impl Send for Injector {}
unsafe impl Sync for Injector {}

impl Injector {
    /// Create a new injector
    pub fn new(pty_tx: mpsc::Sender<Vec<u8>>, queue: Arc<MessageQueue>, config: Config) -> Self {
        Self {
            pty_tx,
            queue,
            config,
            is_idle: AtomicBool::new(false),
            last_output_ms: AtomicU64::new(current_timestamp_ms()),
            recent_output: Mutex::new(String::new()),
        }
    }

    /// Update idle state based on parser result
    pub fn update_from_parse(&self, result: &ParseResult) {
        if result.is_idle || result.ready_signal {
            self.is_idle.store(true, Ordering::SeqCst);
        }
    }

    /// Record new output (updates last_output_ms and recent_output)
    pub async fn record_output(&self, output: &str) {
        self.last_output_ms
            .store(current_timestamp_ms(), Ordering::SeqCst);
        if !is_relay_echo(output) {
            self.is_idle.store(false, Ordering::SeqCst);
        }

        let mut recent = self.recent_output.lock().await;
        recent.push_str(output);

        // Limit buffer size (must find valid UTF-8 char boundary)
        if recent.len() > 10000 {
            let target_start = recent.len() - 10000;
            // Find the next valid char boundary at or after target_start
            let start = recent
                .char_indices()
                .map(|(i, _)| i)
                .find(|&i| i >= target_start)
                .unwrap_or(recent.len());
            *recent = recent[start..].to_string();
        }
    }

    /// Check if agent is idle (based on timeout or explicit signal)
    pub fn check_idle(&self) -> bool {
        // Check explicit idle flag
        if self.is_idle.load(Ordering::SeqCst) {
            return true;
        }

        // Check silence timeout
        let last_output = self.last_output_ms.load(Ordering::SeqCst);
        let now = current_timestamp_ms();
        let silence_ms = now.saturating_sub(last_output);

        silence_ms >= self.config.idle_timeout_ms
    }

    /// Get milliseconds since last output
    pub fn silence_ms(&self) -> u64 {
        let last_output = self.last_output_ms.load(Ordering::SeqCst);
        let now = current_timestamp_ms();
        now.saturating_sub(last_output)
    }

    /// Run the injection loop
    pub async fn run(&self) -> Result<()> {
        info!("Injection loop started");

        loop {
            // Wait for a message
            let msg = self.queue.wait_and_dequeue().await;
            debug!("Processing message: {}", msg.id);

            // Report injecting status
            self.queue
                .report_result(msg.id.clone(), InjectStatus::Injecting, None);

            // Try to inject
            match self.inject_message(&msg).await {
                Ok(true) => {
                    info!("Message {} delivered successfully", msg.id);
                    self.queue
                        .report_result(msg.id.clone(), InjectStatus::Delivered, None);
                }
                Ok(false) => {
                    // Verification failed, retry
                    if msg.retries < self.config.max_retries {
                        warn!(
                            "Message {} not verified, retrying ({}/{})",
                            msg.id,
                            msg.retries + 1,
                            self.config.max_retries
                        );
                        tokio::time::sleep(Duration::from_millis(self.config.retry_delay_ms)).await;
                        self.queue.retry(msg).await;
                    } else {
                        error!("Message {} failed after {} retries", msg.id, msg.retries);
                        self.queue.report_result(
                            msg.id.clone(),
                            InjectStatus::Failed,
                            Some("Verification failed after retries".to_string()),
                        );
                    }
                }
                Err(e) => {
                    error!("Injection error for {}: {}", msg.id, e);
                    self.queue.report_result(
                        msg.id.clone(),
                        InjectStatus::Failed,
                        Some(e.to_string()),
                    );
                }
            }
        }
    }

    /// Inject a single message
    async fn inject_message(&self, msg: &QueuedMessage) -> Result<bool> {
        info!("=== INJECT START: {} from {} ===", msg.id, msg.from);

        // Wait for injection window
        let window_timeout = Duration::from_secs(10);
        let start = Instant::now();

        while start.elapsed() < window_timeout {
            if self.check_idle() {
                info!("Agent is idle, proceeding with injection");
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }

        if !self.check_idle() {
            warn!(
                "Injection window timeout for message {}, proceeding anyway",
                msg.id
            );
        }

        // Clear recent output for verification
        {
            let mut recent = self.recent_output.lock().await;
            recent.clear();
        }

        // Format the message (without Enter key)
        let formatted = msg.format_for_injection();

        info!(
            "Step 1: Writing message content ({} bytes): {}",
            formatted.len(),
            &formatted[..formatted.len().min(100)]
        );

        // Step 1: Write message content (no Enter)
        self.pty_tx
            .send(formatted.as_bytes().to_vec())
            .await
            .map_err(|_| anyhow::anyhow!("PTY channel closed"))?;

        info!("Step 2: Waiting 200ms...");

        // Step 2: Wait for CLI to process the input
        tokio::time::sleep(Duration::from_millis(200)).await;

        info!("Step 3: Sending Enter key (\\r)");

        // Step 3: Send Enter key (\r = carriage return)
        self.pty_tx
            .send(vec![0x0d]) // \r
            .await
            .map_err(|_| anyhow::anyhow!("PTY channel closed"))?;

        // Mark as not idle (we just sent input)
        self.is_idle.store(false, Ordering::SeqCst);

        info!("=== INJECT COMPLETE: {} ===", msg.id);

        // Assume delivery after successful PTY write; many CLIs don't echo input.
        Ok(true)
    }
}

fn is_relay_echo(output: &str) -> bool {
    output.lines().all(|line| {
        let trimmed = line.trim();
        trimmed.is_empty() || trimmed.starts_with("Relay message from ")
    })
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

    #[test]
    fn test_silence_detection() {
        // This is a basic structure test
        // Full integration tests require PTY setup
    }
}
