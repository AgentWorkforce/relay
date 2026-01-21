//! Output parser for relay commands and agent status detection.
//!
//! Scans agent output for:
//! - `<<<RELAY_JSON>>>...<<<END_RELAY>>>` structured JSON format (preferred)
//! - `->relay:` commands (messages, broadcasts, spawns) - legacy format
//! - `KIND: continuity` file-based messages via `->relay-file:ID`
//! - Prompt patterns (to detect idle state)
//! - `->pty:ready` explicit ready signal

use crate::protocol::{ContinuityCommand, ParsedRelayCommand};
use regex::Regex;
use serde::Deserialize;
use std::sync::OnceLock;
use tracing::{debug, info, warn};

/// Regex patterns (compiled once)
static RELAY_PATTERN: OnceLock<Regex> = OnceLock::new();
static FENCED_PATTERN: OnceLock<Regex> = OnceLock::new();
static SPAWN_FENCED_PATTERN: OnceLock<Regex> = OnceLock::new();
static SPAWN_SINGLE_PATTERN: OnceLock<Regex> = OnceLock::new();
static RELEASE_PATTERN: OnceLock<Regex> = OnceLock::new();
static THREAD_PATTERN: OnceLock<Regex> = OnceLock::new();
static ANSI_PATTERN: OnceLock<Regex> = OnceLock::new();
static JSON_RELAY_PATTERN: OnceLock<Regex> = OnceLock::new();

/// Structured relay message (parsed from either header format or JSON)
#[derive(Debug, Default)]
struct RelayMessage {
    /// Message kind: "message", "spawn", "release"
    kind: String,
    /// Target agent (for messages)
    to: Option<String>,
    /// Message body (for messages) or task (for spawn)
    body: Option<String>,
    /// Agent name (for spawn/release)
    name: Option<String>,
    /// CLI to use (for spawn)
    cli: Option<String>,
    /// Optional thread identifier
    thread: Option<String>,
}

/// Structured continuity message (parsed from header format)
#[derive(Debug, Default)]
struct ContinuityMessage {
    /// Action: save, load, uncertain
    action: String,
    /// Content body
    content: String,
}

/// JSON format (for backwards compatibility)
#[derive(Debug, Deserialize)]
struct JsonRelayMessage {
    /// Message kind: "message", "spawn", "release"
    kind: String,
    /// Target agent (for messages)
    #[serde(default)]
    to: Option<String>,
    /// Message body (for messages)
    #[serde(default)]
    body: Option<String>,
    /// Agent name (for spawn/release)
    #[serde(default)]
    name: Option<String>,
    /// CLI to use (for spawn)
    #[serde(default)]
    cli: Option<String>,
    /// Task description (for spawn)
    #[serde(default)]
    task: Option<String>,
    /// Optional thread identifier
    #[serde(default)]
    thread: Option<String>,
}

/// Parse simple header-based format:
/// ```
/// TO: AgentName
/// KIND: message
/// THREAD: optional
///
/// Body content here
/// Can span multiple lines
/// ```
fn parse_header_format(content: &str) -> Option<RelayMessage> {
    let mut msg = RelayMessage::default();

    // Split into headers and body at first blank line
    let parts: Vec<&str> = content.splitn(2, "\n\n").collect();
    let headers = parts.first()?;
    let body = parts.get(1).map(|s| s.trim().to_string());

    // Parse headers
    for line in headers.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        // Split at first colon
        if let Some(colon_pos) = line.find(':') {
            let key = line[..colon_pos].trim().to_uppercase();
            let value = line[colon_pos + 1..].trim().to_string();

            match key.as_str() {
                "TO" => msg.to = Some(value),
                "KIND" => msg.kind = value.to_lowercase(),
                "NAME" => msg.name = Some(value),
                "CLI" => msg.cli = Some(value),
                "THREAD" => msg.thread = Some(value),
                _ => {} // Ignore unknown headers
            }
        }
    }

    // Set body
    msg.body = body;

    // Default kind to "message" if TO is set but KIND is empty
    if msg.kind.is_empty() && msg.to.is_some() {
        msg.kind = "message".to_string();
    }

    // Validate we have required fields
    if msg.kind.is_empty() {
        return None;
    }

    Some(msg)
}

/// Parse header-based continuity format:
/// ```
/// KIND: continuity
/// ACTION: save
///
/// Body content here
/// ```
fn parse_continuity_format(content: &str) -> Option<ContinuityMessage> {
    let mut msg = ContinuityMessage::default();

    let parts: Vec<&str> = content.splitn(2, "\n\n").collect();
    let headers = parts.first()?;
    let body = parts
        .get(1)
        .map(|s| s.trim().to_string())
        .unwrap_or_default();

    let mut kind = None;

    for line in headers.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        if let Some(colon_pos) = line.find(':') {
            let key = line[..colon_pos].trim().to_uppercase();
            let value = line[colon_pos + 1..].trim().to_string();

            match key.as_str() {
                "KIND" => kind = Some(value.to_lowercase()),
                "ACTION" => msg.action = value.to_lowercase(),
                _ => {}
            }
        }
    }

    if kind.as_deref() != Some("continuity") {
        return None;
    }

    if msg.action.is_empty() {
        return None;
    }

    msg.content = body;

    match msg.action.as_str() {
        "save" | "load" | "uncertain" => Some(msg),
        _ => None,
    }
}

/// Pattern for file-based relay format: ->relay-file:ID
/// Agent writes JSON to file, outputs just the ID
fn file_relay_pattern() -> &'static Regex {
    JSON_RELAY_PATTERN.get_or_init(|| {
        // Match ->relay-file: followed by an ID (alphanumeric, dash, underscore)
        Regex::new(r"->relay-file:([a-zA-Z0-9_-]+)").unwrap()
    })
}

fn relay_pattern() -> &'static Regex {
    RELAY_PATTERN.get_or_init(|| Regex::new(r"(?m)^[\s>$%#\-*]*->relay:(\S+)\s+(.+)$").unwrap())
}

fn fenced_pattern() -> &'static Regex {
    FENCED_PATTERN.get_or_init(|| Regex::new(r"(?ms)->relay:(\S+)\s+<<<\s*(.*?)>>>").unwrap())
}

/// Spawn with fenced task: ->relay:spawn AgentName cli <<<task>>>
fn spawn_fenced_pattern() -> &'static Regex {
    SPAWN_FENCED_PATTERN
        .get_or_init(|| Regex::new(r"(?ms)->relay:spawn\s+(\w+)\s+(\w+)\s*<<<\s*(.*?)>>>").unwrap())
}

/// Spawn with quoted task: ->relay:spawn AgentName cli "task"
fn spawn_single_pattern() -> &'static Regex {
    SPAWN_SINGLE_PATTERN
        .get_or_init(|| Regex::new(r#"(?m)->relay:spawn\s+(\w+)\s+(\w+)\s+"([^"]+)""#).unwrap())
}

/// Release: ->relay:release AgentName
fn release_pattern() -> &'static Regex {
    RELEASE_PATTERN.get_or_init(|| Regex::new(r"(?m)->relay:release\s+(\w+)").unwrap())
}

fn thread_pattern() -> &'static Regex {
    THREAD_PATTERN.get_or_init(|| Regex::new(r"\[thread:([^\]]+)\]").unwrap())
}

fn ansi_pattern() -> &'static Regex {
    ANSI_PATTERN.get_or_init(|| Regex::new(r"\x1B\[[0-9;]*[A-Za-z]|\x1B\].*?\x07").unwrap())
}

/// Output parser state
pub struct OutputParser {
    /// Agent name (for the "from" field in parsed commands)
    agent_name: String,
    /// Prompt pattern regex
    prompt_pattern: Regex,
    /// Buffer for incomplete output
    buffer: String,
    /// Last position where we found a complete command
    last_parsed_pos: usize,
    /// Outbox directory for file-based messages (optional)
    outbox_path: Option<std::path::PathBuf>,
}

impl OutputParser {
    /// Create a new output parser
    pub fn new(agent_name: String, prompt_pattern: &str) -> Self {
        let prompt_regex =
            Regex::new(prompt_pattern).unwrap_or_else(|_| Regex::new(r"^[>$%#] $").unwrap());

        Self {
            agent_name,
            prompt_pattern: prompt_regex,
            buffer: String::new(),
            last_parsed_pos: 0,
            outbox_path: None,
        }
    }

    /// Create a new output parser with outbox path for file-based messages
    pub fn with_outbox(
        agent_name: String,
        prompt_pattern: &str,
        outbox_path: std::path::PathBuf,
    ) -> Self {
        let prompt_regex =
            Regex::new(prompt_pattern).unwrap_or_else(|_| Regex::new(r"^[>$%#] $").unwrap());

        Self {
            agent_name,
            prompt_pattern: prompt_regex,
            buffer: String::new(),
            last_parsed_pos: 0,
            outbox_path: Some(outbox_path),
        }
    }

    /// Process new output and return any parsed commands
    pub fn process(&mut self, output: &[u8]) -> ParseResult {
        // Convert to string, handling invalid UTF-8
        let text = String::from_utf8_lossy(output);

        // Strip ANSI escape sequences
        let clean = strip_ansi(&text);

        // Append to buffer
        self.buffer.push_str(&clean);

        // Debug: check if buffer contains relay pattern
        if clean.contains("->relay:") {
            debug!(
                "Buffer contains ->relay: pattern, buffer len={}, last_parsed={}",
                self.buffer.len(),
                self.last_parsed_pos
            );
        }

        // Parse commands from buffer
        let parse_output = self.parse_commands();

        if !parse_output.commands.is_empty() {
            debug!(
                "Parsed {} relay commands from buffer",
                parse_output.commands.len()
            );
        }

        if !parse_output.continuity_commands.is_empty() {
            debug!(
                "Parsed {} continuity commands from buffer",
                parse_output.continuity_commands.len()
            );
        }

        // Check for prompt
        let is_idle = self.check_for_prompt();

        // Check for explicit ready signal
        let ready_signal = self.buffer.contains("->pty:ready");
        if ready_signal {
            // Remove the signal from buffer
            self.buffer = self.buffer.replace("->pty:ready", "");
        }

        ParseResult {
            commands: parse_output.commands,
            continuity_commands: parse_output.continuity_commands,
            is_idle: is_idle || ready_signal,
            ready_signal,
        }
    }

    /// Parse relay and continuity commands from the buffer
    fn parse_commands(&mut self) -> ParseOutput {
        let mut commands = Vec::new();
        let mut continuity_commands = Vec::new();
        let search_text = &self.buffer[self.last_parsed_pos..];

        // Debug: show what we're searching
        if search_text.contains("->relay:") || search_text.contains("->relay-file:") {
            debug!(
                "Searching for relay commands in {} bytes of text",
                search_text.len()
            );
        }

        // 0. Parse file-based format: ->relay-file:ID
        // Agent writes to file (header format preferred, JSON also supported)
        if let Some(ref outbox) = self.outbox_path {
            for caps in file_relay_pattern().captures_iter(search_text) {
                let msg_id = caps.get(1).map(|m| m.as_str()).unwrap_or("");
                let raw = caps.get(0).map(|m| m.as_str()).unwrap_or("");

                // Log spawn-related triggers at info level for visibility
                if msg_id == "spawn" || msg_id.starts_with("spawn") || msg_id == "release" {
                    info!(
                        "Found file relay trigger: {} (outbox: {:?})",
                        msg_id, outbox
                    );
                } else {
                    debug!("Found file relay: {}", msg_id);
                }

                // Try reading file (with or without .json extension)
                let file_path_txt = outbox.join(msg_id);
                let file_path_json = outbox.join(format!("{}.json", msg_id));

                let (file_content, file_path) = if file_path_txt.exists() {
                    (std::fs::read_to_string(&file_path_txt).ok(), file_path_txt)
                } else if file_path_json.exists() {
                    (
                        std::fs::read_to_string(&file_path_json).ok(),
                        file_path_json,
                    )
                } else {
                    // Log missing spawn files at warn level for visibility
                    if msg_id == "spawn" || msg_id.starts_with("spawn") || msg_id == "release" {
                        warn!(
                            "Spawn/release file not found: {:?} or {:?}",
                            file_path_txt, file_path_json
                        );
                    } else {
                        debug!(
                            "Relay file not found: {:?} or {:?}",
                            file_path_txt, file_path_json
                        );
                    }
                    continue;
                };

                let Some(content) = file_content else {
                    debug!("Failed to read relay file");
                    continue;
                };

                // Try continuity header format first
                if let Some(continuity) = parse_continuity_format(&content) {
                    debug!("Parsed continuity header format successfully");
                    let cmd = ContinuityCommand::new(continuity.action, continuity.content);
                    continuity_commands.push(cmd);
                    let _ = std::fs::remove_file(&file_path);
                    continue;
                }

                // Try relay header format next (simpler, more robust)
                let msg: Option<RelayMessage> = if let Some(parsed) = parse_header_format(&content)
                {
                    debug!("Parsed header format successfully");
                    Some(parsed)
                } else {
                    // Fall back to JSON format
                    let sanitized = sanitize_json_from_shell(&content);
                    match serde_json::from_str::<JsonRelayMessage>(&sanitized) {
                        Ok(json_msg) => {
                            debug!("Parsed JSON format successfully");
                            Some(RelayMessage {
                                kind: json_msg.kind,
                                to: json_msg.to,
                                body: json_msg.body.or(json_msg.task),
                                name: json_msg.name,
                                cli: json_msg.cli,
                                thread: json_msg.thread,
                            })
                        }
                        Err(e) => {
                            debug!("Failed to parse relay file: {}", e);
                            None
                        }
                    }
                };

                let Some(msg) = msg else {
                    continue;
                };

                let cmd = match msg.kind.as_str() {
                    "spawn" => {
                        if let (Some(name), Some(cli)) = (&msg.name, &msg.cli) {
                            let task_preview = msg
                                .body
                                .as_ref()
                                .map(|b| &b[..b.len().min(50)])
                                .unwrap_or("");
                            info!(
                                "SPAWN PARSED: {} spawning {} with {} (task: {}...)",
                                self.agent_name, name, cli, task_preview
                            );
                            Some(ParsedRelayCommand::new_spawn(
                                self.agent_name.clone(),
                                name.clone(),
                                cli.clone(),
                                msg.body.unwrap_or_default(),
                                raw.to_string(),
                            ))
                        } else {
                            warn!(
                                "SPAWN FAILED: File spawn missing name ({:?}) or cli ({:?})",
                                msg.name, msg.cli
                            );
                            None
                        }
                    }
                    "release" => {
                        if let Some(name) = &msg.name {
                            info!("RELEASE PARSED: {} releasing {}", self.agent_name, name);
                            Some(ParsedRelayCommand::new_release(
                                self.agent_name.clone(),
                                name.clone(),
                                raw.to_string(),
                            ))
                        } else {
                            warn!("RELEASE FAILED: File release missing name");
                            None
                        }
                    }
                    _ => {
                        if let Some(to) = &msg.to {
                            debug!("Parsed file message: {} -> {}", self.agent_name, to);
                            let mut cmd = ParsedRelayCommand::new_message(
                                self.agent_name.clone(),
                                to.clone(),
                                msg.body.unwrap_or_default(),
                                raw.to_string(),
                            );
                            if let Some(thread) = msg.thread {
                                cmd = cmd.with_thread(thread);
                            }
                            Some(cmd)
                        } else {
                            debug!("File message missing 'to' field");
                            None
                        }
                    }
                };

                if let Some(c) = cmd {
                    commands.push(c);
                    // Delete the file after processing
                    let _ = std::fs::remove_file(&file_path);
                }
            }
        }

        // If we found file commands, skip legacy parsing
        if !commands.is_empty() || !continuity_commands.is_empty() {
            self.last_parsed_pos = self.buffer.len();
            return ParseOutput {
                commands,
                continuity_commands,
            };
        }

        // Legacy format parsing below...
        if search_text.contains("->relay:") {
            // Check if fenced pattern would match
            if search_text.contains("<<<") && search_text.contains(">>>") {
                debug!("Text contains both <<< and >>> markers");
            } else if search_text.contains("<<<") {
                debug!("Text contains <<< but no >>> yet (incomplete fenced message)");
            }
        }

        // 1. Parse spawn commands (fenced format): ->relay:spawn Name cli <<<task>>>
        for caps in spawn_fenced_pattern().captures_iter(search_text) {
            let name = caps.get(1).map(|m| m.as_str()).unwrap_or("");
            let cli = caps.get(2).map(|m| m.as_str()).unwrap_or("");
            let task = caps.get(3).map(|m| m.as_str()).unwrap_or("");
            let raw = caps.get(0).map(|m| m.as_str()).unwrap_or("");

            let cmd = ParsedRelayCommand::new_spawn(
                self.agent_name.clone(),
                name.to_string(),
                cli.to_string(),
                task.trim().to_string(),
                raw.to_string(),
            );

            debug!(
                "Parsed spawn command: {} spawning {} with {}",
                self.agent_name, name, cli
            );
            commands.push(cmd);
        }

        // 2. Parse spawn commands (single-line format): ->relay:spawn Name cli "task"
        for caps in spawn_single_pattern().captures_iter(search_text) {
            let name = caps.get(1).map(|m| m.as_str()).unwrap_or("");
            let cli = caps.get(2).map(|m| m.as_str()).unwrap_or("");
            let task = caps.get(3).map(|m| m.as_str()).unwrap_or("");
            let raw = caps.get(0).map(|m| m.as_str()).unwrap_or("");

            let cmd = ParsedRelayCommand::new_spawn(
                self.agent_name.clone(),
                name.to_string(),
                cli.to_string(),
                task.to_string(),
                raw.to_string(),
            );

            debug!(
                "Parsed spawn command (single): {} spawning {} with {}",
                self.agent_name, name, cli
            );
            commands.push(cmd);
        }

        // 3. Parse release commands: ->relay:release Name
        for caps in release_pattern().captures_iter(search_text) {
            let name = caps.get(1).map(|m| m.as_str()).unwrap_or("");
            let raw = caps.get(0).map(|m| m.as_str()).unwrap_or("");

            let cmd = ParsedRelayCommand::new_release(
                self.agent_name.clone(),
                name.to_string(),
                raw.to_string(),
            );

            debug!(
                "Parsed release command: {} releasing {}",
                self.agent_name, name
            );
            commands.push(cmd);
        }

        // 4. Parse fenced messages (multi-line): ->relay:Target <<<body>>>
        // Skip if target is "spawn" or "release" (already handled above)
        for caps in fenced_pattern().captures_iter(search_text) {
            let target = caps.get(1).map(|m| m.as_str()).unwrap_or("");
            let body = caps.get(2).map(|m| m.as_str()).unwrap_or("");
            let raw = caps.get(0).map(|m| m.as_str()).unwrap_or("");

            // Skip spawn/release - handled separately with proper parsing
            if target == "spawn" || target.starts_with("spawn ") || target == "release" {
                continue;
            }

            let mut cmd = ParsedRelayCommand::new_message(
                self.agent_name.clone(),
                target.to_string(),
                body.trim().to_string(),
                raw.to_string(),
            );

            // Check for thread
            if let Some(thread_caps) = thread_pattern().captures(target) {
                if let Some(thread_name) = thread_caps.get(1) {
                    cmd = cmd.with_thread(thread_name.as_str().to_string());
                }
            }

            debug!("Parsed fenced message: {} -> {}", self.agent_name, target);
            commands.push(cmd);
        }

        // 5. Parse single-line messages (only if no fenced commands)
        if commands.is_empty() {
            for caps in relay_pattern().captures_iter(search_text) {
                let target = caps.get(1).map(|m| m.as_str()).unwrap_or("");
                let body = caps.get(2).map(|m| m.as_str()).unwrap_or("");
                let raw = caps.get(0).map(|m| m.as_str()).unwrap_or("");

                // Skip spawn/release and fenced markers
                if target == "spawn" || target == "release" || body.starts_with("<<<") {
                    continue;
                }

                let mut cmd = ParsedRelayCommand::new_message(
                    self.agent_name.clone(),
                    target.to_string(),
                    body.trim().to_string(),
                    raw.to_string(),
                );

                // Check for thread
                if let Some(thread_caps) = thread_pattern().captures(target) {
                    if let Some(thread_name) = thread_caps.get(1) {
                        cmd = cmd.with_thread(thread_name.as_str().to_string());
                    }
                }

                debug!(
                    "Parsed single-line message: {} -> {}",
                    self.agent_name, target
                );
                commands.push(cmd);
            }
        }

        // Update last parsed position
        if !commands.is_empty() {
            self.last_parsed_pos = self.buffer.len();
        }

        ParseOutput {
            commands,
            continuity_commands,
        }
    }

    /// Check if the buffer ends with a prompt pattern
    fn check_for_prompt(&self) -> bool {
        // Get last few lines of buffer
        let lines: Vec<&str> = self.buffer.lines().collect();
        if let Some(last_line) = lines.last() {
            if self.prompt_pattern.is_match(last_line) {
                return true;
            }
        }

        // Also check common prompt patterns
        let common_prompts = [
            "> ",      // Claude
            "$ ",      // Shell
            ">>> ",    // Gemini
            "codex> ", // Codex
        ];

        if let Some(last_line) = lines.last() {
            let trimmed = last_line.trim_start();
            for prompt in common_prompts {
                if trimmed.ends_with(prompt) {
                    return true;
                }
            }
        }

        false
    }

    /// Clear the buffer
    pub fn clear(&mut self) {
        self.buffer.clear();
        self.last_parsed_pos = 0;
    }

    /// Get current buffer contents
    pub fn buffer(&self) -> &str {
        &self.buffer
    }

    /// Truncate buffer to prevent unbounded growth
    pub fn truncate_buffer(&mut self, max_size: usize) {
        if self.buffer.len() > max_size {
            // Keep the last max_size characters
            let start = self.buffer.len() - max_size;
            self.buffer = self.buffer[start..].to_string();
            self.last_parsed_pos = 0;
        }
    }
}

/// Result of parsing output
#[derive(Debug)]
pub struct ParseResult {
    /// Parsed relay commands
    pub commands: Vec<ParsedRelayCommand>,
    /// Parsed continuity commands
    pub continuity_commands: Vec<ContinuityCommand>,
    /// Whether agent appears idle
    pub is_idle: bool,
    /// Whether explicit ready signal was received
    pub ready_signal: bool,
}

/// Intermediate output from parsing
struct ParseOutput {
    commands: Vec<ParsedRelayCommand>,
    continuity_commands: Vec<ContinuityCommand>,
}

/// Strip ANSI escape sequences from text
pub fn strip_ansi(text: &str) -> String {
    ansi_pattern().replace_all(text, "").to_string()
}

/// Sanitize JSON that was written by shell commands
/// Fixes common issues:
/// 1. Literal newlines in strings -> \n escape
/// 2. Invalid bash escapes like \! -> just the character
fn sanitize_json_from_shell(json: &str) -> String {
    let mut result = String::with_capacity(json.len());
    let mut in_string = false;
    let mut chars = json.chars().peekable();

    while let Some(c) = chars.next() {
        match c {
            '"' => {
                // Toggle string state (unless escaped)
                result.push(c);
                in_string = !in_string;
            }
            '\\' if in_string => {
                // Check what follows the backslash
                if let Some(&next) = chars.peek() {
                    match next {
                        // Valid JSON escapes - pass through
                        '"' | '\\' | '/' | 'b' | 'f' | 'n' | 'r' | 't' | 'u' => {
                            result.push(c);
                        }
                        // Invalid escapes from bash - just output the character
                        '!' | '[' | ']' | '(' | ')' | '{' | '}' | '$' | '`' | '\'' | ' ' | '*'
                        | '?' | '#' | '~' | '=' | '%' | '^' | '&' | ';' | '|' | '<' | '>' => {
                            chars.next(); // consume the next char
                            result.push(next); // output just the character, not the backslash
                        }
                        // Unknown escape - pass through as-is
                        _ => {
                            result.push(c);
                        }
                    }
                } else {
                    result.push(c);
                }
            }
            '\n' if in_string => {
                // Literal newline in string -> escape it
                result.push_str("\\n");
            }
            '\r' if in_string => {
                // Literal carriage return in string -> escape it
                result.push_str("\\r");
            }
            '\t' if in_string => {
                // Literal tab in string -> escape it
                result.push_str("\\t");
            }
            _ => {
                result.push(c);
            }
        }
    }

    result
}

/// Sanitize text for injection (remove control characters)
pub fn sanitize_for_injection(text: &str) -> String {
    text.chars()
        .filter(|c| !c.is_control() || *c == '\n' || *c == '\t')
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_single_line() {
        let mut parser = OutputParser::new("Alice".to_string(), r"^> $");
        let result = parser.process(b"->relay:Bob Hello Bob!\n");

        assert_eq!(result.commands.len(), 1);
        assert_eq!(result.commands[0].to, "Bob");
        assert_eq!(result.commands[0].body, "Hello Bob!");
    }

    #[test]
    fn test_parse_fenced() {
        let mut parser = OutputParser::new("Alice".to_string(), r"^> $");
        let result = parser.process(b"->relay:Bob <<<\nHello Bob!\nMulti-line message.>>>\n");

        assert_eq!(result.commands.len(), 1);
        assert_eq!(result.commands[0].to, "Bob");
        assert!(result.commands[0].body.contains("Multi-line"));
    }

    #[test]
    fn test_parse_with_thread() {
        let mut parser = OutputParser::new("Alice".to_string(), r"^> $");
        let result = parser.process(b"->relay:Bob [thread:test-123] <<<Hello>>>\n");

        assert_eq!(result.commands.len(), 1);
        assert_eq!(result.commands[0].to, "Bob");
        // Thread is extracted from the target
        assert!(result.commands[0].to.contains("Bob"));
    }

    #[test]
    fn test_prompt_detection() {
        let mut parser = OutputParser::new("Alice".to_string(), r"^> $");
        let result = parser.process(b"Some output\n> ");

        assert!(result.is_idle);
    }

    #[test]
    fn test_strip_ansi() {
        let input = "\x1B[31mRed text\x1B[0m";
        let output = strip_ansi(input);
        assert_eq!(output, "Red text");
    }

    #[test]
    fn test_ready_signal() {
        let mut parser = OutputParser::new("Alice".to_string(), r"^> $");
        let result = parser.process(b"Working...\n->pty:ready\n");

        assert!(result.ready_signal);
        assert!(result.is_idle);
    }

    #[test]
    fn test_file_relay_message() {
        // Create a temp directory for the outbox
        let temp_dir = std::env::temp_dir().join("relay-test-outbox");
        std::fs::create_dir_all(&temp_dir).unwrap();

        // Write a message file
        let msg_id = "test-msg-001";
        let json = r#"{"kind":"message","to":"Bob","body":"Hello from file!"}"#;
        std::fs::write(temp_dir.join(format!("{}.json", msg_id)), json).unwrap();

        // Create parser with outbox path
        let mut parser = OutputParser::with_outbox("Alice".to_string(), r"^> $", temp_dir.clone());
        let input = format!("->relay-file:{}\n", msg_id);
        let result = parser.process(input.as_bytes());

        assert_eq!(result.commands.len(), 1);
        assert_eq!(result.commands[0].kind, "message");
        assert_eq!(result.commands[0].to, "Bob");
        assert_eq!(result.commands[0].body, "Hello from file!");

        // File should be deleted after processing
        assert!(!temp_dir.join(format!("{}.json", msg_id)).exists());

        // Cleanup
        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_file_relay_spawn() {
        let temp_dir = std::env::temp_dir().join("relay-test-spawn");
        std::fs::create_dir_all(&temp_dir).unwrap();

        let msg_id = "test-spawn-001";
        let json = r#"{"kind":"spawn","name":"Worker1","cli":"claude","task":"Do the thing"}"#;
        std::fs::write(temp_dir.join(format!("{}.json", msg_id)), json).unwrap();

        let mut parser = OutputParser::with_outbox("Alice".to_string(), r"^> $", temp_dir.clone());
        let input = format!("->relay-file:{}\n", msg_id);
        let result = parser.process(input.as_bytes());

        assert_eq!(result.commands.len(), 1);
        assert_eq!(result.commands[0].kind, "spawn");
        assert_eq!(result.commands[0].spawn_name, Some("Worker1".to_string()));
        assert_eq!(result.commands[0].spawn_cli, Some("claude".to_string()));
        assert_eq!(
            result.commands[0].spawn_task,
            Some("Do the thing".to_string())
        );

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_file_relay_release() {
        let temp_dir = std::env::temp_dir().join("relay-test-release");
        std::fs::create_dir_all(&temp_dir).unwrap();

        let msg_id = "test-release-001";
        let json = r#"{"kind":"release","name":"Worker1"}"#;
        std::fs::write(temp_dir.join(format!("{}.json", msg_id)), json).unwrap();

        let mut parser = OutputParser::with_outbox("Alice".to_string(), r"^> $", temp_dir.clone());
        let input = format!("->relay-file:{}\n", msg_id);
        let result = parser.process(input.as_bytes());

        assert_eq!(result.commands.len(), 1);
        assert_eq!(result.commands[0].kind, "release");
        assert_eq!(result.commands[0].release_name, Some("Worker1".to_string()));

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_file_relay_with_thread() {
        let temp_dir = std::env::temp_dir().join("relay-test-thread");
        std::fs::create_dir_all(&temp_dir).unwrap();

        let msg_id = "test-thread-001";
        let json = r#"{"kind":"message","to":"Bob","body":"Threaded msg","thread":"task-123"}"#;
        std::fs::write(temp_dir.join(format!("{}.json", msg_id)), json).unwrap();

        let mut parser = OutputParser::with_outbox("Alice".to_string(), r"^> $", temp_dir.clone());
        let input = format!("->relay-file:{}\n", msg_id);
        let result = parser.process(input.as_bytes());

        assert_eq!(result.commands.len(), 1);
        assert_eq!(result.commands[0].thread, Some("task-123".to_string()));

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_file_relay_missing_file() {
        let temp_dir = std::env::temp_dir().join("relay-test-missing");
        std::fs::create_dir_all(&temp_dir).unwrap();

        // Don't write any file
        let mut parser = OutputParser::with_outbox("Alice".to_string(), r"^> $", temp_dir.clone());
        let input = "->relay-file:nonexistent\n";
        let result = parser.process(input.as_bytes());

        // Should not crash, just produce no commands
        assert_eq!(result.commands.len(), 0);

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_file_relay_pattern_doesnt_interfere() {
        let mut parser = OutputParser::new("Alice".to_string(), r"^> $");
        // Normal conversation shouldn't trigger the parser
        let input = "Let me explain how file-based relay works: you write to a file.\n";
        let result = parser.process(input.as_bytes());

        assert_eq!(result.commands.len(), 0);
    }

    #[test]
    fn test_file_relay_in_mixed_output() {
        let temp_dir = std::env::temp_dir().join("relay-test-mixed");
        std::fs::create_dir_all(&temp_dir).unwrap();

        let msg_id = "test-mixed-001";
        let json = r#"{"kind":"message","to":"Bob","body":"Hello!"}"#;
        std::fs::write(temp_dir.join(format!("{}.json", msg_id)), json).unwrap();

        let mut parser = OutputParser::with_outbox("Alice".to_string(), r"^> $", temp_dir.clone());
        let input = format!(
            "I'm going to send a message now.\n->relay-file:{}\nAnd that's done.\n",
            msg_id
        );
        let result = parser.process(input.as_bytes());

        assert_eq!(result.commands.len(), 1);
        assert_eq!(result.commands[0].to, "Bob");

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_sanitize_json_from_shell() {
        // Test fixing literal newlines
        let input = "{\"body\":\"line1\nline2\"}";
        let expected = "{\"body\":\"line1\\nline2\"}";
        assert_eq!(sanitize_json_from_shell(input), expected);

        // Test fixing bash \! escape
        let input = "{\"body\":\"Hello\\! World\"}";
        let expected = "{\"body\":\"Hello! World\"}";
        assert_eq!(sanitize_json_from_shell(input), expected);

        // Test preserving valid escapes
        let input = r#"{"body":"line1\nline2"}"#;
        let expected = r#"{"body":"line1\nline2"}"#;
        assert_eq!(sanitize_json_from_shell(input), expected);

        // Test complex case with board
        let input = "{\"body\":\"Board:\n 1 | 2\n-----\"}";
        let expected = "{\"body\":\"Board:\\n 1 | 2\\n-----\"}";
        assert_eq!(sanitize_json_from_shell(input), expected);
    }

    #[test]
    fn test_file_relay_with_shell_escapes() {
        let temp_dir = std::env::temp_dir().join("relay-test-shell-escapes");
        std::fs::create_dir_all(&temp_dir).unwrap();

        let msg_id = "test-shell-001";
        // Simulate what shell would write - with literal newlines and \! escapes
        let json = "{\"kind\":\"message\",\"to\":\"Bob\",\"body\":\"Hello\\! World\nLine 2\"}";
        std::fs::write(temp_dir.join(format!("{}.json", msg_id)), json).unwrap();

        let mut parser = OutputParser::with_outbox("Alice".to_string(), r"^> $", temp_dir.clone());
        let input = format!("->relay-file:{}\n", msg_id);
        let result = parser.process(input.as_bytes());

        assert_eq!(result.commands.len(), 1);
        assert_eq!(result.commands[0].to, "Bob");
        assert!(result.commands[0].body.contains("Hello!"));
        assert!(result.commands[0].body.contains("Line 2"));

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_parse_header_format_message() {
        let content = "TO: Bob\n\nHello Bob!\nThis is a multi-line message.";
        let msg = parse_header_format(content).unwrap();
        assert_eq!(msg.kind, "message");
        assert_eq!(msg.to, Some("Bob".to_string()));
        assert!(msg.body.as_ref().unwrap().contains("Hello Bob!"));
        assert!(msg.body.as_ref().unwrap().contains("multi-line"));
    }

    #[test]
    fn test_parse_header_format_spawn() {
        let content =
            "KIND: spawn\nNAME: Worker1\nCLI: claude\n\nImplement the auth module\nWith JWT tokens";
        let msg = parse_header_format(content).unwrap();
        assert_eq!(msg.kind, "spawn");
        assert_eq!(msg.name, Some("Worker1".to_string()));
        assert_eq!(msg.cli, Some("claude".to_string()));
        assert!(msg.body.as_ref().unwrap().contains("auth module"));
    }

    #[test]
    fn test_parse_header_format_release() {
        let content = "KIND: release\nNAME: Worker1";
        let msg = parse_header_format(content).unwrap();
        assert_eq!(msg.kind, "release");
        assert_eq!(msg.name, Some("Worker1".to_string()));
    }

    #[test]
    fn test_parse_header_format_with_thread() {
        let content = "TO: Bob\nTHREAD: task-123\n\nMessage with thread";
        let msg = parse_header_format(content).unwrap();
        assert_eq!(msg.to, Some("Bob".to_string()));
        assert_eq!(msg.thread, Some("task-123".to_string()));
    }

    #[test]
    fn test_file_relay_header_format() {
        let temp_dir = std::env::temp_dir().join("relay-test-header");
        std::fs::create_dir_all(&temp_dir).unwrap();

        let msg_id = "test-header-001";
        // Write header format file (no .json extension)
        let content = "TO: Bob\n\nHello from header format!\nMultiple lines work great.";
        std::fs::write(temp_dir.join(msg_id), content).unwrap();

        let mut parser = OutputParser::with_outbox("Alice".to_string(), r"^> $", temp_dir.clone());
        let input = format!("->relay-file:{}\n", msg_id);
        let result = parser.process(input.as_bytes());

        assert_eq!(result.commands.len(), 1);
        assert_eq!(result.commands[0].to, "Bob");
        assert!(result.commands[0].body.contains("Hello from header format"));

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_file_relay_header_spawn() {
        let temp_dir = std::env::temp_dir().join("relay-test-header-spawn");
        std::fs::create_dir_all(&temp_dir).unwrap();

        let msg_id = "spawn-worker";
        let content = "KIND: spawn\nNAME: TicTacToe\nCLI: claude\n\nPlay tic-tac-toe against the user.\nYou are O, they are X.";
        std::fs::write(temp_dir.join(msg_id), content).unwrap();

        let mut parser = OutputParser::with_outbox("Alice".to_string(), r"^> $", temp_dir.clone());
        let input = format!("->relay-file:{}\n", msg_id);
        let result = parser.process(input.as_bytes());

        assert_eq!(result.commands.len(), 1);
        assert_eq!(result.commands[0].kind, "spawn");
        assert_eq!(result.commands[0].spawn_name, Some("TicTacToe".to_string()));
        assert_eq!(result.commands[0].spawn_cli, Some("claude".to_string()));
        assert!(result.commands[0]
            .spawn_task
            .as_ref()
            .unwrap()
            .contains("tic-tac-toe"));

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_file_relay_continuity_save() {
        let temp_dir = std::env::temp_dir().join("relay-test-continuity-save");
        std::fs::create_dir_all(&temp_dir).unwrap();

        let msg_id = "continuity";
        let content = "KIND: continuity\nACTION: save\n\nCurrent task: testing continuity parsing.";
        std::fs::write(temp_dir.join(msg_id), content).unwrap();

        let mut parser = OutputParser::with_outbox("Alice".to_string(), r"^> $", temp_dir.clone());
        let input = format!("->relay-file:{}\n", msg_id);
        let result = parser.process(input.as_bytes());

        assert_eq!(result.continuity_commands.len(), 1);
        assert_eq!(result.continuity_commands[0].action, "save");
        assert!(result.continuity_commands[0]
            .content
            .contains("testing continuity parsing"));

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_file_relay_continuity_load() {
        let temp_dir = std::env::temp_dir().join("relay-test-continuity-load");
        std::fs::create_dir_all(&temp_dir).unwrap();

        let msg_id = "load";
        let content = "KIND: continuity\nACTION: load\n";
        std::fs::write(temp_dir.join(msg_id), content).unwrap();

        let mut parser = OutputParser::with_outbox("Alice".to_string(), r"^> $", temp_dir.clone());
        let input = format!("->relay-file:{}\n", msg_id);
        let result = parser.process(input.as_bytes());

        assert_eq!(result.continuity_commands.len(), 1);
        assert_eq!(result.continuity_commands[0].action, "load");
        assert_eq!(result.continuity_commands[0].content, "");

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_file_relay_continuity_uncertain() {
        let temp_dir = std::env::temp_dir().join("relay-test-continuity-uncertain");
        std::fs::create_dir_all(&temp_dir).unwrap();

        let msg_id = "uncertain";
        let content = "KIND: continuity\nACTION: uncertain\n\nAPI rate limit handling unclear.";
        std::fs::write(temp_dir.join(msg_id), content).unwrap();

        let mut parser = OutputParser::with_outbox("Alice".to_string(), r"^> $", temp_dir.clone());
        let input = format!("->relay-file:{}\n", msg_id);
        let result = parser.process(input.as_bytes());

        assert_eq!(result.continuity_commands.len(), 1);
        assert_eq!(result.continuity_commands[0].action, "uncertain");
        assert!(result.continuity_commands[0].content.contains("rate limit"));

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_parse_header_format_defaults_to_message() {
        let content = "TO: Bob\n\nHello there!";
        let msg = parse_header_format(content).unwrap();
        assert_eq!(msg.kind, "message");
        assert_eq!(msg.to, Some("Bob".to_string()));
        assert_eq!(msg.body, Some("Hello there!".to_string()));
    }

    #[test]
    fn test_parse_continuity_format_rejects_invalid_action() {
        let content = "KIND: continuity\nACTION: maybe\n\nNot a valid action";
        let msg = parse_continuity_format(content);
        assert!(msg.is_none());
    }

    #[test]
    fn test_file_relay_skips_legacy_parsing_when_file_found() {
        let temp_dir = std::env::temp_dir().join("relay-test-file-priority");
        std::fs::create_dir_all(&temp_dir).unwrap();

        let msg_id = "test-file-priority";
        let content = "TO: Bob\n\nHello from file.";
        std::fs::write(temp_dir.join(msg_id), content).unwrap();

        let mut parser = OutputParser::with_outbox("Alice".to_string(), r"^> $", temp_dir.clone());
        let input = format!(
            "->relay-file:{}\n->relay:Charlie This should be ignored.\n",
            msg_id
        );
        let result = parser.process(input.as_bytes());

        assert_eq!(result.commands.len(), 1);
        assert_eq!(result.commands[0].to, "Bob");

        let _ = std::fs::remove_dir_all(&temp_dir);
    }
}
