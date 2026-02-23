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
    /// Send just Enter key (for stuck input recovery)
    SendEnter {
        /// Message ID this is for (for tracking)
        id: String,
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
    /// SendEnter result (for stuck input recovery)
    SendEnterResult {
        /// Message ID this response is for
        id: String,
        /// Whether Enter was sent successfully
        success: bool,
        /// Unix timestamp in milliseconds
        timestamp: u64,
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

/// Synchronization metadata for blocking messages
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncMeta {
    /// Whether sender should block awaiting response
    pub blocking: bool,
    /// Optional timeout in milliseconds
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
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
    /// Optional sync metadata for blocking messages
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sync: Option<SyncMeta>,
    /// For spawn: agent name to spawn
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spawn_name: Option<String>,
    /// For spawn: CLI to use
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spawn_cli: Option<String>,
    /// For spawn: task description
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spawn_task: Option<String>,
    /// For spawn: working directory
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spawn_cwd: Option<String>,
    /// For release: agent name to release
    #[serde(skip_serializing_if = "Option::is_none")]
    pub release_name: Option<String>,
}

/// Parsed continuity command from file-based relay output
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContinuityCommand {
    /// Type identifier (always "continuity")
    #[serde(rename = "type")]
    pub cmd_type: String,
    /// Action to perform: save, load, uncertain
    pub action: String,
    /// Continuity content (may be empty for load)
    pub content: String,
}

impl ContinuityCommand {
    pub fn new(action: String, content: String) -> Self {
        Self {
            cmd_type: "continuity".to_string(),
            action,
            content,
        }
    }
}

/// Event emitted when a file in the outbox has been sitting without a trigger.
/// This indicates the agent wrote a relay message file but forgot to output
/// the `->relay-file:ID` trigger to actually send it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StaleOutboxFile {
    /// Type identifier (always "stale_outbox_file")
    #[serde(rename = "type")]
    pub event_type: String,
    /// Name of the stale file (without path)
    pub file: String,
    /// Full path to the file
    pub path: String,
    /// Age of the file in seconds
    pub age_seconds: u64,
    /// Agent name
    pub agent: String,
}

impl StaleOutboxFile {
    pub fn new(file: String, path: String, age_seconds: u64, agent: String) -> Self {
        Self {
            event_type: "stale_outbox_file".to_string(),
            file,
            path,
            age_seconds,
            agent,
        }
    }
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
            sync: None,
            spawn_name: None,
            spawn_cli: None,
            spawn_task: None,
            spawn_cwd: None,
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
            sync: None,
            spawn_name: Some(name),
            spawn_cli: Some(cli),
            spawn_task: Some(task),
            spawn_cwd: None,
            release_name: None,
        }
    }

    pub fn new_spawn_with_cwd(
        from: String,
        name: String,
        cli: String,
        task: String,
        cwd: Option<String>,
        raw: String,
    ) -> Self {
        Self {
            cmd_type: "relay_command".to_string(),
            kind: "spawn".to_string(),
            from,
            to: "spawn".to_string(),
            body: task.clone(),
            raw,
            thread: None,
            sync: None,
            spawn_name: Some(name),
            spawn_cli: Some(cli),
            spawn_task: Some(task),
            spawn_cwd: cwd,
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
            sync: None,
            spawn_name: None,
            spawn_cli: None,
            spawn_task: None,
            spawn_cwd: None,
            release_name: Some(name),
        }
    }

    pub fn with_thread(mut self, thread: String) -> Self {
        self.thread = Some(thread);
        self
    }

    pub fn with_sync(mut self, sync: SyncMeta) -> Self {
        self.sync = Some(sync);
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
    /// Target (agent name, channel like "#general", or "*" for broadcast)
    pub to: Option<String>,
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
            to: None,
            priority,
            retries: 0,
            queued_at: std::time::Instant::now(),
        }
    }

    pub fn with_to(mut self, to: String) -> Self {
        self.to = Some(to);
        self
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
    ///
    /// Messages are wrapped with a system-reminder to guide agents to respond via MCP tools.
    /// The reminder is customized based on whether the message is to a channel or direct.
    /// If the body already contains a system-reminder, no additional wrapper is added.
    pub fn format_for_injection(&self) -> String {
        // Check if body already has a system-reminder wrapper (avoid double-wrapping)
        if self.body.starts_with("<system-reminder>") {
            return self.body.clone();
        }

        // Check if body is already formatted (from Node.js buildInjectionString)
        // This prevents double-wrapping with "Relay message from..."
        let relay_msg = if self.body.starts_with("Relay message from ") {
            // Already formatted - just apply retry prefixes if needed
            match self.retries {
                0 => self.body.clone(),
                1 => format!("[RETRY] {}", self.body),
                _ => format!("[URGENT - PLEASE ACKNOWLEDGE] {}", self.body),
            }
        } else {
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
        };

        // Build context-aware system-reminder based on target
        let mcp_hint = self.build_mcp_reply_hint(&relay_msg);

        // Wrap with system-reminder to guide agents to use MCP tools for replies
        format!(
            "<system-reminder>\n{}\n</system-reminder>\n\n{}",
            mcp_hint, relay_msg
        )
    }

    /// Build the MCP reply hint based on target (channel vs DM)
    fn build_mcp_reply_hint(&self, relay_msg: &str) -> String {
        // Try to determine target from `to` field first, then parse from body
        let target = self.to.as_deref().or_else(|| self.extract_channel_from_body(relay_msg));

        match target {
            Some(channel) if channel.starts_with('#') => {
                format!(
                    "This message was delivered via Relaycast MCP to channel {}. Reply using mcp__relaycast__post_message with channel: \"{}\".",
                    channel, channel.trim_start_matches('#')
                )
            }
            Some(channel) if channel == "*" => {
                "This message was delivered via Relaycast MCP as a broadcast. Reply using mcp__relaycast__post_message to respond to the appropriate channel.".to_string()
            }
            Some(sender) => {
                format!(
                    "This message was delivered via Relaycast MCP. Reply to {} using mcp__relaycast__send_dm.",
                    sender
                )
            }
            None => {
                // Fallback: check if body contains channel hint [#channel]
                if let Some(channel) = self.extract_channel_from_body(relay_msg) {
                    format!(
                        "This message was delivered via Relaycast MCP to channel {}. Reply using mcp__relaycast__post_message with channel: \"{}\".",
                        channel, channel.trim_start_matches('#')
                    )
                } else {
                    // Generic hint when we can't determine context
                    format!(
                        "This message was delivered via Relaycast MCP. Reply to {} using mcp__relaycast__send_dm (for direct messages) or mcp__relaycast__post_message (for channels).",
                        self.from
                    )
                }
            }
        }
    }

    /// Extract channel name from body if it contains [#channel] pattern
    fn extract_channel_from_body<'a>(&self, body: &'a str) -> Option<&'a str> {
        // Look for [#channel] pattern in the body
        // Example: "Relay message from Alice [abc123] [#general]: Hello"
        if let Some(start) = body.find("[#") {
            if let Some(end) = body[start..].find(']') {
                let channel = &body[start + 1..start + end];
                return Some(channel);
            }
        }
        None
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
        let workspace_id = std::env::var("WORKSPACE_ID")
            .ok()
            .map(|id| id.trim().to_string())
            .filter(|id| !id.is_empty());
        let socket_path = workspace_id
            .as_ref()
            .map(|id| format!("/tmp/relay/{}/sockets/agent.sock", id))
            .unwrap_or_else(|| "/tmp/relay-pty-agent.sock".to_string());

        Self {
            name: "agent".to_string(),
            socket_path,
            prompt_pattern: r"^[>$%#] $".to_string(),
            idle_timeout_ms: 5000, // 5 seconds - matches TypeScript queue monitor threshold
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
    use std::sync::{Mutex, OnceLock};

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
    fn test_inject_request_default_priority() {
        let json = r#"{"type":"inject","id":"msg-1","from":"Alice","body":"Hello"}"#;
        let req: InjectRequest = serde_json::from_str(json).unwrap();
        match req {
            InjectRequest::Inject { priority, .. } => {
                assert_eq!(priority, 0);
            }
            _ => panic!("Expected inject request"),
        }
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
        assert!(formatted.contains("<system-reminder>"));
        assert!(formatted.contains("mcp__relaycast__post_message"));
        assert!(formatted.contains("Relay message from Bob [abc1234]: Test message"));
    }

    #[test]
    fn test_config_default_with_workspace_id() {
        static ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        let _guard = ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();

        std::env::set_var("WORKSPACE_ID", "workspace-123");
        let config = Config::default();
        assert_eq!(
            config.socket_path,
            "/tmp/relay/workspace-123/sockets/agent.sock"
        );
        std::env::remove_var("WORKSPACE_ID");
    }

    #[test]
    fn test_queued_message_format_with_retry_escalation() {
        let mut msg = QueuedMessage::new(
            "abc1234567890".to_string(),
            "Alice".to_string(),
            "Important task".to_string(),
            0,
        );

        // First attempt (retries=0) - no prefix, has system-reminder
        let formatted = msg.format_for_injection();
        assert!(formatted.contains("<system-reminder>"));
        assert!(formatted.contains("Relay message from Alice [abc1234]: Important task"));
        assert!(!formatted.contains("[RETRY]"));

        // Second attempt (retries=1) - RETRY prefix
        msg.retries = 1;
        let formatted = msg.format_for_injection();
        assert!(formatted.contains("[RETRY] Relay message from Alice [abc1234]: Important task"));

        // Third attempt (retries=2) - URGENT prefix
        msg.retries = 2;
        let formatted = msg.format_for_injection();
        assert!(formatted.contains("[URGENT - PLEASE ACKNOWLEDGE] Relay message from Alice [abc1234]: Important task"));

        // Fourth attempt (retries=3) - still URGENT
        msg.retries = 3;
        let formatted = msg.format_for_injection();
        assert!(formatted.contains("[URGENT - PLEASE ACKNOWLEDGE] Relay message from Alice [abc1234]: Important task"));
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

        // Should include system-reminder but not double-wrap the relay message
        let formatted = msg.format_for_injection();
        assert!(formatted.contains("<system-reminder>"));
        assert!(formatted.contains("Relay message from Alice [abc12345]: Hello world"));
        // Should NOT have double "Relay message from"
        assert_eq!(formatted.matches("Relay message from").count(), 1);
    }

    #[test]
    fn test_queued_message_format_preformatted_with_retry() {
        let mut msg = QueuedMessage::new(
            "xyz7890".to_string(),
            "Alice".to_string(),
            "Relay message from Alice [abc12345]: Hello world".to_string(),
            0,
        );

        // Retry should prepend to pre-formatted body (with system-reminder wrapper)
        msg.retries = 1;
        let formatted = msg.format_for_injection();
        assert!(formatted.contains("<system-reminder>"));
        assert!(formatted.contains("[RETRY] Relay message from Alice [abc12345]: Hello world"));

        msg.retries = 2;
        let formatted = msg.format_for_injection();
        assert!(formatted.contains("[URGENT - PLEASE ACKNOWLEDGE] Relay message from Alice [abc12345]: Hello world"));
    }

    // =========================================================================
    // Extensive tests for pre-formatted message detection
    // =========================================================================

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
        let formatted = msg.format_for_injection();
        assert!(formatted.contains("Relay message from Alice [abc12345] [thread:task-123]: Please review"));
        assert_eq!(formatted.matches("Relay message from").count(), 1);
    }

    #[test]
    fn test_preformatted_with_importance_high() {
        // High importance indicator [!!]
        let msg = QueuedMessage::new(
            "xyz7890".to_string(),
            "Lead".to_string(),
            "Relay message from Lead [abc12345] [!!]: URGENT task".to_string(),
            0,
        );
        let formatted = msg.format_for_injection();
        assert!(formatted.contains("Relay message from Lead [abc12345] [!!]: URGENT task"));
    }

    #[test]
    fn test_preformatted_with_importance_medium() {
        // Medium importance indicator [!]
        let msg = QueuedMessage::new(
            "xyz7890".to_string(),
            "Lead".to_string(),
            "Relay message from Lead [abc12345] [!]: Important task".to_string(),
            0,
        );
        let formatted = msg.format_for_injection();
        assert!(formatted.contains("Relay message from Lead [abc12345] [!]: Important task"));
    }

    #[test]
    fn test_preformatted_with_channel_hint() {
        // Channel messages include [#channel]
        let msg = QueuedMessage::new(
            "xyz7890".to_string(),
            "Alice".to_string(),
            "Relay message from Alice [abc12345] [#general]: Hello team".to_string(),
            0,
        );
        let formatted = msg.format_for_injection();
        assert!(formatted.contains("Relay message from Alice [abc12345] [#general]: Hello team"));
    }

    #[test]
    fn test_preformatted_with_broadcast_hint() {
        // Broadcast messages show [#general] (default channel)
        let msg = QueuedMessage::new(
            "xyz7890".to_string(),
            "Lead".to_string(),
            "Relay message from Lead [abc12345] [#general]: Broadcast message".to_string(),
            0,
        );
        let formatted = msg.format_for_injection();
        assert!(formatted.contains("Relay message from Lead [abc12345] [#general]: Broadcast message"));
    }

    #[test]
    fn test_preformatted_with_multiple_hints() {
        // Combined: thread + importance + channel
        let msg = QueuedMessage::new(
            "xyz7890".to_string(),
            "Lead".to_string(),
            "Relay message from Lead [abc12345] [thread:proj-1] [!!] [#dev]: Critical fix needed"
                .to_string(),
            0,
        );
        let formatted = msg.format_for_injection();
        assert!(formatted.contains("Relay message from Lead [abc12345] [thread:proj-1] [!!] [#dev]: Critical fix needed"));
    }

    #[test]
    fn test_preformatted_dashboard_sender() {
        // Dashboard messages show actual username instead of Dashboard
        let msg = QueuedMessage::new(
            "xyz7890".to_string(),
            "Dashboard".to_string(),
            "Relay message from john_doe [abc12345]: Task from dashboard".to_string(),
            0,
        );
        // Should preserve the displayed sender (john_doe), not wrap with Dashboard
        let formatted = msg.format_for_injection();
        assert!(formatted.contains("Relay message from john_doe [abc12345]: Task from dashboard"));
        assert_eq!(formatted.matches("Relay message from").count(), 1);
    }

    #[test]
    fn test_preformatted_system_sender() {
        // System messages (from 'system' sender)
        let msg = QueuedMessage::new(
            "init-123".to_string(),
            "system".to_string(),
            "Relay message from system [init-123]: Agent initialized".to_string(),
            0,
        );
        let formatted = msg.format_for_injection();
        assert!(formatted.contains("Relay message from system [init-123]: Agent initialized"));
    }

    // =========================================================================
    // Edge cases that should NOT be treated as pre-formatted
    // =========================================================================

    #[test]
    fn test_similar_but_not_preformatted_missing_space() {
        // Missing space after "from" - should NOT match
        let msg = QueuedMessage::new(
            "xyz7890".to_string(),
            "Bob".to_string(),
            "Relay message fromAlice: not formatted correctly".to_string(),
            0,
        );
        // Should wrap normally since it doesn't match exact prefix
        let formatted = msg.format_for_injection();
        assert!(formatted.contains("Relay message from Bob [xyz7890]: Relay message fromAlice: not formatted correctly"));
    }

    #[test]
    fn test_similar_but_not_preformatted_lowercase() {
        // Lowercase "relay" - should NOT match
        let msg = QueuedMessage::new(
            "xyz7890".to_string(),
            "Bob".to_string(),
            "relay message from Alice: lowercase".to_string(),
            0,
        );
        let formatted = msg.format_for_injection();
        assert!(formatted.contains("Relay message from Bob [xyz7890]: relay message from Alice: lowercase"));
    }

    #[test]
    fn test_body_mentions_relay_in_middle() {
        // "Relay message from" appears in middle of text
        let msg = QueuedMessage::new(
            "xyz7890".to_string(),
            "Bob".to_string(),
            "I saw a Relay message from Alice earlier".to_string(),
            0,
        );
        let formatted = msg.format_for_injection();
        assert!(formatted.contains("Relay message from Bob [xyz7890]: I saw a Relay message from Alice earlier"));
    }

    #[test]
    fn test_body_with_quoted_relay_message() {
        // User is quoting a relay message
        let msg = QueuedMessage::new(
            "xyz7890".to_string(),
            "Bob".to_string(),
            "User said: \"Relay message from Alice [abc]: test\"".to_string(),
            0,
        );
        let formatted = msg.format_for_injection();
        assert!(formatted.contains("Relay message from Bob [xyz7890]: User said: \"Relay message from Alice [abc]: test\""));
    }

    // =========================================================================
    // Special characters and content edge cases
    // =========================================================================

    #[test]
    fn test_empty_body() {
        let msg = QueuedMessage::new("xyz7890".to_string(), "Bob".to_string(), "".to_string(), 0);
        let formatted = msg.format_for_injection();
        assert!(formatted.contains("Relay message from Bob [xyz7890]: "));
    }

    #[test]
    fn test_body_with_newlines() {
        // Body with newlines (should be preserved in raw format)
        let msg = QueuedMessage::new(
            "xyz7890".to_string(),
            "Bob".to_string(),
            "Line 1\nLine 2\nLine 3".to_string(),
            0,
        );
        let formatted = msg.format_for_injection();
        assert!(formatted.contains("Relay message from Bob [xyz7890]: Line 1\nLine 2\nLine 3"));
    }

    #[test]
    fn test_body_with_unicode() {
        let msg = QueuedMessage::new(
            "xyz7890".to_string(),
            "Bob".to_string(),
            "Hello 你好 مرحبا 🚀".to_string(),
            0,
        );
        let formatted = msg.format_for_injection();
        assert!(formatted.contains("Relay message from Bob [xyz7890]: Hello 你好 مرحبا 🚀"));
    }

    #[test]
    fn test_body_with_special_chars() {
        let msg = QueuedMessage::new(
            "xyz7890".to_string(),
            "Bob".to_string(),
            "Special: <>&\"'`$(){}[]|\\".to_string(),
            0,
        );
        let formatted = msg.format_for_injection();
        assert!(formatted.contains("Relay message from Bob [xyz7890]: Special: <>&\"'`$(){}[]|\\"));
    }

    #[test]
    fn test_very_long_message() {
        let long_body = "x".repeat(10000);
        let msg = QueuedMessage::new(
            "xyz7890".to_string(),
            "Bob".to_string(),
            long_body.clone(),
            0,
        );
        let formatted = msg.format_for_injection();
        assert!(formatted.contains("<system-reminder>"));
        assert!(formatted.contains("Relay message from Bob [xyz7890]: "));
        assert!(formatted.ends_with(&long_body));
    }

    #[test]
    fn test_preformatted_very_long_message() {
        let long_content = "y".repeat(10000);
        let preformatted = format!("Relay message from Alice [abc12345]: {}", long_content);
        let msg = QueuedMessage::new(
            "xyz7890".to_string(),
            "System".to_string(),
            preformatted.clone(),
            0,
        );
        // Should contain preformatted message without double-wrapping
        let formatted = msg.format_for_injection();
        assert!(formatted.contains(&preformatted));
        assert_eq!(formatted.matches("Relay message from").count(), 1);
    }

    #[test]
    fn test_sender_with_underscore() {
        let msg = QueuedMessage::new(
            "xyz7890".to_string(),
            "worker_1".to_string(),
            "Task complete".to_string(),
            0,
        );
        let formatted = msg.format_for_injection();
        assert!(formatted.contains("Relay message from worker_1 [xyz7890]: Task complete"));
    }

    #[test]
    fn test_sender_with_numbers() {
        let msg = QueuedMessage::new(
            "xyz7890".to_string(),
            "Agent42".to_string(),
            "Status update".to_string(),
            0,
        );
        let formatted = msg.format_for_injection();
        assert!(formatted.contains("Relay message from Agent42 [xyz7890]: Status update"));
    }

    #[test]
    fn test_short_message_id() {
        // ID shorter than 7 chars
        let msg = QueuedMessage::new(
            "abc".to_string(),
            "Bob".to_string(),
            "Short ID".to_string(),
            0,
        );
        let formatted = msg.format_for_injection();
        assert!(formatted.contains("Relay message from Bob [abc]: Short ID"));
    }

    #[test]
    fn test_preformatted_different_senders() {
        // The 'from' field in QueuedMessage differs from the displayed sender
        // This happens when messages are relayed through different agents
        let msg = QueuedMessage::new(
            "xyz7890".to_string(),
            "Relay".to_string(), // Actual sender in QueuedMessage
            "Relay message from Alice [orig123]: Original message".to_string(), // Shows Alice
            0,
        );
        // Should preserve Alice as the displayed sender
        let formatted = msg.format_for_injection();
        assert!(formatted.contains("Relay message from Alice [orig123]: Original message"));
        assert_eq!(formatted.matches("Relay message from").count(), 1);
    }

    #[test]
    fn test_system_reminder_mcp_hint_dm() {
        // Direct message should hint to use send_dm
        let msg = QueuedMessage::new(
            "xyz7890".to_string(),
            "Alice".to_string(),
            "Hello there".to_string(),
            0,
        );
        let formatted = msg.format_for_injection();

        // Should have system-reminder wrapper
        assert!(formatted.starts_with("<system-reminder>"));
        assert!(formatted.contains("</system-reminder>"));

        // Should mention MCP tools and sender for replying
        assert!(formatted.contains("mcp__relaycast__send_dm"));
        assert!(formatted.contains("Relaycast MCP"));
        assert!(formatted.contains("Alice")); // Should mention who to reply to

        // Relay message should come after the system-reminder
        assert!(formatted.contains("\n\nRelay message from Alice [xyz7890]: Hello there"));
    }

    #[test]
    fn test_system_reminder_mcp_hint_channel_from_to() {
        // Channel message with explicit `to` field
        let msg = QueuedMessage::new(
            "xyz7890".to_string(),
            "Alice".to_string(),
            "Hello team".to_string(),
            0,
        ).with_to("#general".to_string());
        let formatted = msg.format_for_injection();

        // Should mention the specific channel
        assert!(formatted.contains("#general"));
        assert!(formatted.contains("mcp__relaycast__post_message"));
        assert!(formatted.contains("channel: \"general\""));
    }

    #[test]
    fn test_system_reminder_mcp_hint_channel_from_body() {
        // Channel hint parsed from pre-formatted body
        let msg = QueuedMessage::new(
            "xyz7890".to_string(),
            "Alice".to_string(),
            "Relay message from Alice [abc12345] [#dev]: Build failed".to_string(),
            0,
        );
        let formatted = msg.format_for_injection();

        // Should detect #dev channel from body
        assert!(formatted.contains("#dev"));
        assert!(formatted.contains("mcp__relaycast__post_message"));
        assert!(formatted.contains("channel: \"dev\""));
    }

    #[test]
    fn test_system_reminder_broadcast() {
        // Broadcast message
        let msg = QueuedMessage::new(
            "xyz7890".to_string(),
            "Lead".to_string(),
            "Announcement".to_string(),
            0,
        ).with_to("*".to_string());
        let formatted = msg.format_for_injection();

        // Should mention broadcast
        assert!(formatted.contains("broadcast"));
        assert!(formatted.contains("mcp__relaycast__post_message"));
    }
}
