//! Protocol types for relay-pty communication.
//!
//! Defines the JSON message format for injection requests, responses,
//! and parsed output commands.

use serde::{Deserialize, Serialize};

/// Message sent to the injection socket
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum InjectRequest {
    /// Inject a relay message into the agent
    Inject {
        /// Unique message ID for tracking
        id: String,
        /// Sender name (shown as "Relay message from {from}")
        from: String,
        /// Message body to inject
        body: String,
        /// Priority (lower = higher priority)
        #[serde(default)]
        priority: i32,
    },
    /// Query current status
    Status,
    /// Graceful shutdown request
    Shutdown,
}

/// Response sent back through the injection socket
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum InjectResponse {
    /// Injection result
    InjectResult {
        /// Message ID this response is for
        id: String,
        /// Status of the injection
        status: InjectStatus,
        /// Unix timestamp in milliseconds
        timestamp: u64,
        /// Optional error message
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    /// Status response
    Status {
        /// Whether agent appears idle (ready for injection)
        agent_idle: bool,
        /// Number of messages in queue
        queue_length: usize,
        /// Cursor position [x, y]
        cursor_position: Option<[u16; 2]>,
        /// Milliseconds since last output
        last_output_ms: u64,
    },
    /// Backpressure notification
    Backpressure {
        /// Current queue length
        queue_length: usize,
        /// Whether new messages are accepted
        accept: bool,
    },
    /// Shutdown acknowledged
    ShutdownAck,
    /// Error response
    Error {
        /// Error message
        message: String,
    },
}

/// Status of an injection attempt
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InjectStatus {
    /// Message queued for injection
    Queued,
    /// Currently being injected
    Injecting,
    /// Successfully delivered and echoed
    Delivered,
    /// Injection failed after retries
    Failed,
}

/// Parsed relay command from agent output
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParsedRelayCommand {
    /// Type identifier (always "relay_command")
    #[serde(rename = "type")]
    pub cmd_type: String,
    /// Command kind: "message", "spawn", "release"
    pub kind: String,
    /// Sender (the agent name)
    pub from: String,
    /// Target (agent name, channel, or broadcast) - for messages
    pub to: String,
    /// Message body
    pub body: String,
    /// Raw text that was parsed
    pub raw: String,
    /// Optional thread identifier
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread: Option<String>,
    /// For spawn: agent name to spawn
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spawn_name: Option<String>,
    /// For spawn: CLI to use
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spawn_cli: Option<String>,
    /// For spawn: task description
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spawn_task: Option<String>,
    /// For release: agent name to release
    #[serde(skip_serializing_if = "Option::is_none")]
    pub release_name: Option<String>,
}

impl ParsedRelayCommand {
    pub fn new_message(from: String, to: String, body: String, raw: String) -> Self {
        Self {
            cmd_type: "relay_command".to_string(),
            kind: "message".to_string(),
            from,
            to,
            body,
            raw,
            thread: None,
            spawn_name: None,
            spawn_cli: None,
            spawn_task: None,
            release_name: None,
        }
    }

    pub fn new_spawn(from: String, name: String, cli: String, task: String, raw: String) -> Self {
        Self {
            cmd_type: "relay_command".to_string(),
            kind: "spawn".to_string(),
            from,
            to: "spawn".to_string(),
            body: task.clone(),
            raw,
            thread: None,
            spawn_name: Some(name),
            spawn_cli: Some(cli),
            spawn_task: Some(task),
            release_name: None,
        }
    }

    pub fn new_release(from: String, name: String, raw: String) -> Self {
        Self {
            cmd_type: "relay_command".to_string(),
            kind: "release".to_string(),
            from,
            to: "release".to_string(),
            body: name.clone(),
            raw,
            thread: None,
            spawn_name: None,
            spawn_cli: None,
            spawn_task: None,
            release_name: Some(name),
        }
    }

    pub fn with_thread(mut self, thread: String) -> Self {
        self.thread = Some(thread);
        self
    }
}

/// Internal message for the injection queue
#[derive(Debug, Clone)]
pub struct QueuedMessage {
    /// Unique message ID
    pub id: String,
    /// Sender name
    pub from: String,
    /// Message body
    pub body: String,
    /// Priority (lower = higher priority)
    pub priority: i32,
    /// Retry count
    pub retries: u32,
    /// Timestamp when queued
    pub queued_at: std::time::Instant,
}

impl QueuedMessage {
    pub fn new(id: String, from: String, body: String, priority: i32) -> Self {
        Self {
            id,
            from,
            body,
            priority,
            retries: 0,
            queued_at: std::time::Instant::now(),
        }
    }

    /// Format as relay message for injection with escalating urgency based on retry count.
    ///
    /// If the body is already formatted (starts with "Relay message from"), it will be used
    /// as-is to avoid double-formatting. This happens when the Node.js orchestrator has
    /// already called buildInjectionString() before sending to the socket.
    ///
    /// Retry escalation (only applied to newly formatted messages):
    /// - Attempt 1 (retries=0): "Relay message from..."
    /// - Attempt 2 (retries=1): "[RETRY] Relay message from..."
    /// - Attempt 3+ (retries>=2): "[URGENT - PLEASE ACKNOWLEDGE] Relay message from..."
    pub fn format_for_injection(&self) -> String {
        // Check if body is already formatted (from Node.js buildInjectionString)
        // This prevents double-wrapping with "Relay message from..."
        if self.body.starts_with("Relay message from ") {
            // Already formatted - just apply retry prefixes if needed
            return match self.retries {
                0 => self.body.clone(),
                1 => format!("[RETRY] {}", self.body),
                _ => format!("[URGENT - PLEASE ACKNOWLEDGE] {}", self.body),
            };
        }

        // Not pre-formatted - apply full formatting
        let short_id = &self.id[..self.id.len().min(7)];
        let base_msg = format!(
            "Relay message from {} [{}]: {}",
            self.from, short_id, self.body
        );

        match self.retries {
            0 => base_msg,
            1 => format!("[RETRY] {}", base_msg),
            _ => format!("[URGENT - PLEASE ACKNOWLEDGE] {}", base_msg),
        }
    }
}

/// Configuration for the PTY wrapper
#[derive(Debug, Clone)]
pub struct Config {
    /// Agent name/identifier
    pub name: String,
    /// Unix socket path
    pub socket_path: String,
    /// Regex pattern to detect prompt
    pub prompt_pattern: String,
    /// Milliseconds of silence before considering idle
    pub idle_timeout_ms: u64,
    /// Maximum messages in queue before backpressure
    pub queue_max: usize,
    /// Whether to output parsed commands as JSON to stderr
    pub json_output: bool,
    /// Command to run (e.g., ["claude", "--model", "opus"])
    pub command: Vec<String>,
    /// Maximum injection retries
    pub max_retries: u32,
    /// Delay between retries in milliseconds
    pub retry_delay_ms: u64,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            name: "agent".to_string(),
            socket_path: "/tmp/relay-pty-agent.sock".to_string(),
            prompt_pattern: r"^[>$%#] $".to_string(),
            idle_timeout_ms: 500,
            queue_max: 50,
            json_output: false,
            command: vec![],
            max_retries: 3,
            retry_delay_ms: 300,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_inject_request_serialization() {
        let req = InjectRequest::Inject {
            id: "msg-123".to_string(),
            from: "Alice".to_string(),
            body: "Hello!".to_string(),
            priority: 0,
        };
        let json = serde_json::to_string(&req).unwrap();
        assert!(json.contains("\"type\":\"inject\""));
        assert!(json.contains("\"from\":\"Alice\""));
    }

    #[test]
    fn test_queued_message_format() {
        let msg = QueuedMessage::new(
            "abc1234567890".to_string(),
            "Bob".to_string(),
            "Test message".to_string(),
            0,
        );
        let formatted = msg.format_for_injection();
        assert_eq!(formatted, "Relay message from Bob [abc1234]: Test message");
    }

    #[test]
    fn test_queued_message_format_with_retry_escalation() {
        let mut msg = QueuedMessage::new(
            "abc1234567890".to_string(),
            "Alice".to_string(),
            "Important task".to_string(),
            0,
        );

        // First attempt (retries=0) - no prefix
        assert_eq!(
            msg.format_for_injection(),
            "Relay message from Alice [abc1234]: Important task"
        );

        // Second attempt (retries=1) - RETRY prefix
        msg.retries = 1;
        assert_eq!(
            msg.format_for_injection(),
            "[RETRY] Relay message from Alice [abc1234]: Important task"
        );

        // Third attempt (retries=2) - URGENT prefix
        msg.retries = 2;
        assert_eq!(
            msg.format_for_injection(),
            "[URGENT - PLEASE ACKNOWLEDGE] Relay message from Alice [abc1234]: Important task"
        );

        // Fourth attempt (retries=3) - still URGENT
        msg.retries = 3;
        assert_eq!(
            msg.format_for_injection(),
            "[URGENT - PLEASE ACKNOWLEDGE] Relay message from Alice [abc1234]: Important task"
        );
    }

    #[test]
    fn test_queued_message_format_preformatted() {
        // When body is already formatted (from Node.js buildInjectionString),
        // it should NOT be double-wrapped
        let msg = QueuedMessage::new(
            "xyz7890".to_string(),
            "Alice".to_string(),
            "Relay message from Alice [abc12345]: Hello world".to_string(),
            0,
        );

        // Should return body as-is (no double-wrapping)
        assert_eq!(
            msg.format_for_injection(),
            "Relay message from Alice [abc12345]: Hello world"
        );
    }

    #[test]
    fn test_queued_message_format_preformatted_with_retry() {
        let mut msg = QueuedMessage::new(
            "xyz7890".to_string(),
            "Alice".to_string(),
            "Relay message from Alice [abc12345]: Hello world".to_string(),
            0,
        );

        // Retry should prepend to pre-formatted body
        msg.retries = 1;
        assert_eq!(
            msg.format_for_injection(),
            "[RETRY] Relay message from Alice [abc12345]: Hello world"
        );

        msg.retries = 2;
        assert_eq!(
            msg.format_for_injection(),
            "[URGENT - PLEASE ACKNOWLEDGE] Relay message from Alice [abc12345]: Hello world"
        );
    }

    #[test]
    fn test_preformatted_with_thread_hint() {
        // Node.js buildInjectionString adds thread hints
        let msg = QueuedMessage::new(
            "xyz7890".to_string(),
            "Alice".to_string(),
            "Relay message from Alice [abc12345] [thread:task-123]: Please review".to_string(),
            0,
        );
        // Should preserve thread hint, not double-wrap
        assert_eq!(
            msg.format_for_injection(),
            "Relay message from Alice [abc12345] [thread:task-123]: Please review"
        );
    }
}
