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
    /// Timestamp of last injection (ms since epoch)
    last_injection_ms: AtomicU64,
    /// Recent output buffer for verification
    recent_output: Mutex<String>,
    /// Whether an auto-suggestion is currently visible (blocks injection)
    auto_suggestion_visible: AtomicBool,
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
            last_injection_ms: AtomicU64::new(0), // No injection yet
            recent_output: Mutex::new(String::new()),
            auto_suggestion_visible: AtomicBool::new(false),
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
        // Skip idle state updates for auto-suggestions (ghost text)
        // Auto-suggestions are NOT real agent activity AND block injection
        if is_auto_suggestion(output) {
            // Mark that an auto-suggestion is visible - this blocks injection
            self.auto_suggestion_visible.store(true, Ordering::SeqCst);
            debug!("Auto-suggestion detected, blocking injection");
            return;
        }

        // Real output detected - clear auto-suggestion flag
        self.auto_suggestion_visible.store(false, Ordering::SeqCst);

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
    /// Returns false if an auto-suggestion is currently visible (blocks injection)
    pub fn check_idle(&self) -> bool {
        // NEVER inject when an auto-suggestion is visible
        // This prevents accidentally submitting the auto-suggestion text
        if self.auto_suggestion_visible.load(Ordering::SeqCst) {
            return false;
        }

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

    /// Get milliseconds since last injection (0 if never injected)
    pub fn ms_since_injection(&self) -> u64 {
        let last_injection = self.last_injection_ms.load(Ordering::SeqCst);
        if last_injection == 0 {
            return 0; // Never injected
        }
        let now = current_timestamp_ms();
        now.saturating_sub(last_injection)
    }

    /// Check if there was a recent injection (within given ms)
    pub fn had_recent_injection(&self, within_ms: u64) -> bool {
        let since = self.ms_since_injection();
        since > 0 && since <= within_ms
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
                    // Track injection time for auto-Enter detection
                    self.last_injection_ms
                        .store(current_timestamp_ms(), Ordering::SeqCst);
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

        info!("Step 2: Waiting 50ms...");

        // Step 2: Wait for CLI to process the input
        // Reduced from 200ms to 50ms for faster message delivery.
        // Most CLIs process input within 20-30ms; 50ms provides a safety margin.
        tokio::time::sleep(Duration::from_millis(50)).await;

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

/// Detect if output is an auto-suggestion (ghost text).
/// Claude Code shows auto-suggestions with:
/// - \x1b[7m (reverse video) for cursor position
/// - followed by a character
/// - \x1b[27m (reverse off)
/// - \x1b[2m (dim) for the ghost text
fn is_auto_suggestion(output: &str) -> bool {
    // Pattern: \x1b[7m followed by any char, then \x1b[27m\x1b[2m
    // This is the cursor position + dim ghost text pattern
    let has_cursor_ghost = output.contains("\x1b[7m") && output.contains("\x1b[27m\x1b[2m");

    // Also check for the "↵ send" hint which appears in suggestions
    let has_send_hint = output.contains("↵ send");

    has_cursor_ghost || has_send_hint
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
    use tokio::sync::{broadcast, mpsc};

    fn test_config(idle_timeout_ms: u64) -> Config {
        Config {
            idle_timeout_ms,
            ..Config::default()
        }
    }

    fn test_parse_result(is_idle: bool) -> ParseResult {
        ParseResult {
            commands: Vec::new(),
            continuity_commands: Vec::new(),
            is_idle,
            ready_signal: false,
        }
    }

    #[tokio::test]
    async fn test_update_from_parse_sets_idle() {
        let (pty_tx, _pty_rx) = mpsc::channel(1);
        let (response_tx, _response_rx) = broadcast::channel(1);
        let queue = Arc::new(MessageQueue::new(1, response_tx));
        let injector = Injector::new(pty_tx, queue, test_config(600000));

        injector.update_from_parse(&test_parse_result(true));
        assert!(injector.check_idle());
    }

    #[tokio::test]
    async fn test_record_output_clears_idle_on_non_relay() {
        let (pty_tx, _pty_rx) = mpsc::channel(1);
        let (response_tx, _response_rx) = broadcast::channel(1);
        let queue = Arc::new(MessageQueue::new(1, response_tx));
        let injector = Injector::new(pty_tx, queue, test_config(600000));

        injector.update_from_parse(&test_parse_result(true));
        assert!(injector.check_idle());

        injector.record_output("Hello world").await;
        assert!(!injector.check_idle());
    }

    #[tokio::test]
    async fn test_record_output_keeps_idle_on_relay_echo() {
        let (pty_tx, _pty_rx) = mpsc::channel(1);
        let (response_tx, _response_rx) = broadcast::channel(1);
        let queue = Arc::new(MessageQueue::new(1, response_tx));
        let injector = Injector::new(pty_tx, queue, test_config(600000));

        injector.update_from_parse(&test_parse_result(true));
        assert!(injector.check_idle());

        injector
            .record_output("Relay message from Alice [abc]: Hi\n")
            .await;
        assert!(injector.check_idle());
    }

    #[test]
    fn test_idle_timeout_zero_is_immediately_idle() {
        let (pty_tx, _pty_rx) = mpsc::channel(1);
        let (response_tx, _response_rx) = broadcast::channel(1);
        let queue = Arc::new(MessageQueue::new(1, response_tx));
        let injector = Injector::new(pty_tx, queue, test_config(0));

        assert!(injector.check_idle());
    }

    #[test]
    fn test_is_relay_echo() {
        assert!(is_relay_echo("Relay message from Alice [abc]: Hi\n"));
        assert!(is_relay_echo("\nRelay message from Bob [def]: Yo\n\n"));
        assert!(!is_relay_echo("Some other output\n"));
    }

    #[test]
    fn test_is_auto_suggestion() {
        // Real auto-suggestion from Claude Code with cursor + dim ghost text
        assert!(is_auto_suggestion(
            "\x1b[7mW\x1b[27m\x1b[2mhat's the task you need help with?\x1b[22m"
        ));
        assert!(is_auto_suggestion(
            "\x1b[7mT\x1b[27m\x1b[2mry \"how do I log an error?\"\x1b[22m"
        ));

        // With "↵ send" hint
        assert!(is_auto_suggestion("some text ↵ send"));

        // Normal output should not be detected as auto-suggestion
        assert!(!is_auto_suggestion("Hello world"));
        assert!(!is_auto_suggestion("Running tests..."));
        assert!(!is_auto_suggestion("\x1b[2m───────\x1b[22m")); // dim separator line without cursor
    }

    #[tokio::test]
    async fn test_record_output_blocks_injection_on_auto_suggestions() {
        let (pty_tx, _pty_rx) = mpsc::channel(1);
        let (response_tx, _response_rx) = broadcast::channel(1);
        let queue = Arc::new(MessageQueue::new(1, response_tx));
        let injector = Injector::new(pty_tx, queue, test_config(600000));

        injector.update_from_parse(&test_parse_result(true));
        assert!(injector.check_idle());

        // Auto-suggestion should BLOCK injection (check_idle returns false)
        injector
            .record_output("\x1b[7mW\x1b[27m\x1b[2mhat's the task?\x1b[22m")
            .await;
        assert!(!injector.check_idle()); // Should NOT be idle - auto-suggestion blocks injection

        // Real output clears the auto-suggestion flag
        injector.record_output("Some real output").await;
        assert!(!injector.check_idle()); // Not idle due to recent real output
    }

    #[tokio::test]
    async fn test_auto_suggestion_flag_cleared_by_real_output() {
        let (pty_tx, _pty_rx) = mpsc::channel(1);
        let (response_tx, _response_rx) = broadcast::channel(1);
        let queue = Arc::new(MessageQueue::new(1, response_tx));
        // Use long timeout so we test the explicit idle flag behavior
        let injector = Injector::new(pty_tx, queue, test_config(600000));

        // Start idle via explicit flag
        injector.update_from_parse(&test_parse_result(true));
        assert!(injector.check_idle());

        // Auto-suggestion blocks injection even though idle flag is set
        injector
            .record_output("\x1b[7mH\x1b[27m\x1b[2melp me\x1b[22m")
            .await;
        assert!(!injector.check_idle()); // Blocked by auto_suggestion_visible

        // Real output clears the auto_suggestion_visible flag
        // But also clears is_idle (non-relay output = agent active)
        injector.record_output("Agent is working...").await;
        assert!(!injector.check_idle()); // Not idle - real output means agent active

        // Set idle again via parser - this should work now since
        // auto_suggestion_visible was cleared by the real output
        injector.update_from_parse(&test_parse_result(true));
        assert!(injector.check_idle()); // Now idle - auto-suggestion flag was cleared
    }

    #[test]
    fn test_is_auto_suggestion_real_world_patterns() {
        // Real patterns captured from Claude Code output logs

        // Full auto-suggestion with send hint
        assert!(is_auto_suggestion(
            "\x1b[7mS\x1b[27m\x1b[2mend Dashboard their first task                                                          ↵ send\x1b[22m"
        ));

        // Auto-suggestion without send hint
        assert!(is_auto_suggestion(
            "\x1b[7mH\x1b[27m\x1b[2melp me set up agent deployment\x1b[22m"
        ));

        // Just the send hint (partial view)
        assert!(is_auto_suggestion("                     ↵ send"));

        // Spinner output should NOT be detected (common false positive check)
        assert!(!is_auto_suggestion("\x1b[38;5;174m✻\x1b[39m"));
        assert!(!is_auto_suggestion("\x1b[38;5;174m✶\x1b[39m"));

        // Prompt with cursor but no dim text should NOT match
        // (this is the idle prompt, not an auto-suggestion)
        assert!(!is_auto_suggestion("> \x1b[7m \x1b[27m"));

        // Tool output should NOT match
        assert!(!is_auto_suggestion("\x1b[1mBash\x1b[22m(ls -la)"));
        assert!(!is_auto_suggestion("Relay message from Alice [abc]: Hello"));
    }

    #[test]
    fn test_is_auto_suggestion_edge_cases() {
        // Empty string
        assert!(!is_auto_suggestion(""));

        // Just reverse video without dim (not a suggestion)
        assert!(!is_auto_suggestion("\x1b[7mX\x1b[27m"));

        // Just dim without reverse (separator lines, etc)
        assert!(!is_auto_suggestion("\x1b[2m────────\x1b[22m"));

        // Reverse and dim but not adjacent (unlikely but test it)
        assert!(!is_auto_suggestion(
            "\x1b[7mX\x1b[27m some text \x1b[2mdim\x1b[22m"
        ));

        // Multiple suggestions in one output (should still detect)
        assert!(is_auto_suggestion(
            "line1\n\x1b[7mA\x1b[27m\x1b[2muto complete\x1b[22m\nline2"
        ));
    }
}
