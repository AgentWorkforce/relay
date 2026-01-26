//! relay-pty: PTY wrapper for reliable agent message injection
//!
//! A Rust binary that wraps agent CLIs (claude, codex, etc.) in a PTY
//! and provides a Unix socket interface for reliable message injection.
//!
//! Usage:
//!   relay-pty --name myagent -- claude --model opus

// Allow dead code - this binary has public API components that may not be used internally
#![allow(dead_code)]

mod inject;
mod outbox_monitor;
mod parser;
mod protocol;
mod pty;
mod queue;
mod socket;

use anyhow::{Context, Result};
use clap::Parser;
use inject::Injector;
use outbox_monitor::OutboxMonitor;
use parser::OutputParser;
use protocol::Config;
use pty::{AsyncPty, Pty};
use queue::MessageQueue;
use socket::{SocketServer, StatusInfo, StatusQuery};
use std::fs::{File, OpenOptions};
use std::io::{self, Read, Write as IoWrite};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::AsyncWriteExt;
use tokio::select;
use tokio::signal::unix::{signal, SignalKind};
use tokio::sync::{broadcast, mpsc, Mutex};
use tracing::{debug, error, info, warn};
use tracing_subscriber::EnvFilter;

/// Find the nearest character boundary at or before the given byte index.
/// This is needed because Rust strings are UTF-8 and slicing at arbitrary
/// byte positions can panic if the position is in the middle of a multi-byte character.
fn floor_char_boundary(s: &str, index: usize) -> usize {
    if index >= s.len() {
        return s.len();
    }
    // Walk backwards from index to find a valid char boundary
    let mut i = index;
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

/// PTY wrapper for reliable agent message injection
#[derive(Parser, Debug)]
#[command(name = "relay-pty")]
#[command(about = "PTY wrapper for reliable agent message injection")]
#[command(version)]
struct Args {
    /// Agent name/identifier
    #[arg(short, long)]
    name: String,

    /// Unix socket path (default: /tmp/relay-pty-{name}.sock or /tmp/relay/{WORKSPACE_ID}/sockets/{name}.sock)
    #[arg(short, long)]
    socket: Option<String>,

    /// Regex pattern to detect agent prompt
    #[arg(long, default_value = r"^[>$%#] $")]
    prompt_pattern: String,

    /// Milliseconds of silence before considering idle
    #[arg(long, default_value = "500")]
    idle_timeout: u64,

    /// Maximum messages in queue before backpressure
    /// Increased from 50 to 200 to handle slow MCP responses during long Claude thinking periods
    #[arg(long, default_value = "200")]
    queue_max: usize,

    /// Output parsed relay commands as JSON to stderr
    #[arg(long)]
    json_output: bool,

    /// Maximum injection retries
    #[arg(long, default_value = "3")]
    max_retries: u32,

    /// Delay between retries in milliseconds
    #[arg(long, default_value = "300")]
    retry_delay: u64,

    /// Log level (error, warn, info, debug, trace)
    #[arg(long, default_value = "info")]
    log_level: String,

    /// Terminal rows (for headless mode)
    #[arg(long)]
    rows: Option<u16>,

    /// Terminal columns (for headless mode)
    #[arg(long)]
    cols: Option<u16>,

    /// Log file path for agent output (tees stdout to file)
    #[arg(long)]
    log_file: Option<String>,

    /// Outbox directory for file-based relay messages (default: /tmp/relay/{WORKSPACE_ID}/outbox/{name} when set)
    #[arg(long)]
    outbox: Option<String>,

    /// Timeout in seconds before an outbox file is considered stale (default: 60)
    /// A stale file indicates the agent wrote a message but forgot to trigger it.
    /// Set to 0 to disable stale file detection.
    #[arg(long, default_value = "60")]
    stale_outbox_timeout: u64,

    /// TTL in seconds for seen message IDs before they can be reused (default: 300 = 5 minutes)
    /// Lower values free memory faster but may allow duplicate messages if retried quickly.
    /// For long sessions with 200+ agents, consider 120-180 seconds.
    #[arg(long, default_value = "300")]
    seen_ttl: u64,

    /// Interval in seconds for cleaning up expired seen IDs (default: 60)
    /// More frequent cleanup reduces memory but adds slight overhead.
    /// For high-volume sessions, consider 30 seconds.
    #[arg(long, default_value = "60")]
    cleanup_interval: u64,

    /// Timeout in seconds before auto-sending Enter when agent is stuck at INSERT prompt (default: 10)
    /// Claude Code sometimes waits at "-- INSERT --" prompt for user to press Enter.
    /// Set to 0 to disable auto-Enter detection.
    #[arg(long, default_value = "10")]
    auto_enter_timeout: u64,

    /// Command to run (after --)
    #[arg(last = true, required = true)]
    command: Vec<String>,
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();

    // Initialize logging
    let filter = EnvFilter::try_new(&args.log_level).unwrap_or_else(|_| EnvFilter::new("info"));

    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .with_writer(io::stderr)
        .init();

    info!("relay-pty v{}", env!("CARGO_PKG_VERSION"));
    info!("Agent: {}", args.name);
    info!("Command: {:?}", args.command);

    // Build configuration
    let workspace_id = std::env::var("WORKSPACE_ID")
        .ok()
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty());

    let socket_path = args.socket.unwrap_or_else(|| {
        if let Some(ref workspace_id) = workspace_id {
            format!("/tmp/relay/{}/sockets/{}.sock", workspace_id, args.name)
        } else {
            format!("/tmp/relay-pty-{}.sock", args.name)
        }
    });

    let outbox_path = args.outbox.or_else(|| {
        workspace_id
            .as_ref()
            .map(|id| format!("/tmp/relay/{}/outbox/{}", id, args.name))
    });

    let config = Config {
        name: args.name.clone(),
        socket_path: socket_path.clone(),
        prompt_pattern: args.prompt_pattern,
        idle_timeout_ms: args.idle_timeout,
        queue_max: args.queue_max,
        json_output: args.json_output,
        command: args.command.clone(),
        max_retries: args.max_retries,
        retry_delay_ms: args.retry_delay,
    };

    info!("Socket: {}", socket_path);
    if let (Some(r), Some(c)) = (args.rows, args.cols) {
        info!("Terminal size: {}x{}", c, r);
    }

    // Open log file if specified
    let log_file: Option<Arc<Mutex<File>>> = if let Some(ref log_path) = args.log_file {
        // Create parent directory if needed
        if let Some(parent) = Path::new(log_path).parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                warn!("Failed to create log directory {:?}: {}", parent, e);
            }
        }
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(log_path)
            .context(format!("Failed to open log file: {}", log_path))?;
        info!("Logging output to: {}", log_path);
        Some(Arc::new(Mutex::new(file)))
    } else {
        None
    };

    // Create PTY and spawn agent
    let pty = Pty::spawn(&args.command, args.rows, args.cols).context("Failed to spawn agent")?;

    // Set raw mode for transparent terminal passthrough (if TTY available)
    let is_interactive = Pty::set_raw_mode().context("Failed to set raw mode")?;
    if is_interactive {
        info!("Running in interactive mode (TTY)");
    } else {
        info!("Running in headless mode (no TTY)");
    }

    // Wrap in async PTY
    let mut async_pty = AsyncPty::new(pty);

    // Create channels
    // Broadcast channel for response notifications (socket server subscribes to this)
    let (response_tx, _response_rx) = broadcast::channel(64);
    let (status_tx, mut status_rx) = mpsc::channel::<StatusQuery>(16);
    let (shutdown_tx, mut shutdown_rx) = mpsc::channel::<()>(1);
    let (inject_tx, mut inject_rx) = mpsc::channel::<Vec<u8>>(64);

    // Create message queue with broadcast sender and configurable TTL
    let queue = Arc::new(MessageQueue::with_ttl(
        config.queue_max,
        response_tx,
        args.seen_ttl,
        args.cleanup_interval,
    ));

    // Create injector (clone inject_tx since we also need it for SocketServer)
    let injector = Arc::new(Injector::new(
        inject_tx.clone(),
        Arc::clone(&queue),
        config.clone(),
    ));

    // Create output parser
    let mut parser = if let Some(ref outbox) = outbox_path {
        let outbox_path = std::path::PathBuf::from(outbox);
        // Create outbox directory if needed
        if !outbox_path.exists() {
            if let Err(e) = std::fs::create_dir_all(&outbox_path) {
                warn!("Failed to create outbox directory {:?}: {}", outbox_path, e);
            }
        }
        info!("File-based relay enabled, outbox: {}", outbox);
        OutputParser::with_outbox(config.name.clone(), &config.prompt_pattern, outbox_path)
    } else {
        OutputParser::new(config.name.clone(), &config.prompt_pattern)
    };

    // Create outbox monitor for stale file detection
    let mut outbox_monitor: Option<OutboxMonitor> = if let Some(ref outbox) = outbox_path {
        if args.stale_outbox_timeout > 0 {
            let outbox_pathbuf = std::path::PathBuf::from(outbox);
            let mut monitor = outbox_monitor::create_outbox_monitor(
                args.name.clone(),
                &outbox_pathbuf,
                args.stale_outbox_timeout,
            );
            if let Err(e) = monitor.start() {
                warn!("Failed to start outbox monitor: {}", e);
                None
            } else {
                // Initialize tracking for existing files
                monitor.init().await;
                info!(
                    "Stale outbox detection enabled (timeout: {}s)",
                    args.stale_outbox_timeout
                );
                Some(monitor)
            }
        } else {
            info!("Stale outbox detection disabled (timeout set to 0)");
            None
        }
    } else {
        None
    };

    // Interval for checking stale outbox files
    let mut stale_check_interval = tokio::time::interval(std::time::Duration::from_secs(10));

    // Start socket server
    let socket_server = SocketServer::new(
        socket_path.clone(),
        Arc::clone(&queue),
        status_tx,
        shutdown_tx,
        inject_tx.clone(), // For SendEnter requests
    );

    let socket_handle = tokio::spawn(async move {
        if let Err(e) = socket_server.run().await {
            error!("Socket server error: {}", e);
        }
    });

    // Start injector
    let injector_clone = Arc::clone(&injector);
    let injector_handle = tokio::spawn(async move {
        if let Err(e) = injector_clone.run().await {
            error!("Injector error: {}", e);
        }
    });

    // Set up signal handlers
    let mut sigint = signal(SignalKind::interrupt())?;
    let mut sigterm = signal(SignalKind::terminate())?;
    let mut sigwinch = signal(SignalKind::window_change())?;

    // Create stdin reader (always - for both interactive and piped input)
    let (stdin_tx, mut stdin_rx) = mpsc::channel::<Vec<u8>>(32);
    std::thread::spawn(move || {
        let mut stdin = io::stdin();
        let mut buf = [0u8; 1024];
        loop {
            match stdin.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if stdin_tx.blocking_send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    // Main event loop
    let json_output = config.json_output;
    let mut stdout = tokio::io::stdout();

    // Track MCP approval state to prevent duplicate approvals
    let mcp_approved = AtomicBool::new(false);
    // Buffer recent output to handle fragmented prompt detection
    // Increased buffer size (2500 chars) to handle fragmented output across read boundaries
    let mut mcp_detection_buffer = String::new();
    // Track when we first detected partial MCP prompt match for timeout-based approval
    let mut mcp_partial_match_since: Option<Instant> = None;
    // Timeout duration for partial match approval (5 seconds)
    const MCP_APPROVAL_TIMEOUT: Duration = Duration::from_secs(5);

    // Auto-Enter detection for stuck agents
    // After injecting a message, if agent becomes idle for too long, send Enter
    // This handles cases where the CLI is waiting for user confirmation
    let auto_enter_timeout_ms = args.auto_enter_timeout * 1000; // Convert to ms
    let auto_enter_enabled = args.auto_enter_timeout > 0;
    let mut last_auto_enter_time: Option<Instant> = None;
    // Cooldown between auto-Enter sends to avoid spamming
    const AUTO_ENTER_COOLDOWN: Duration = Duration::from_secs(5);

    loop {
        select! {
            // Handle shutdown signal
            _ = shutdown_rx.recv() => {
                info!("Shutdown requested");
                break;
            }

            // Handle SIGINT
            _ = sigint.recv() => {
                info!("SIGINT received");
                // Forward to child
                let _ = async_pty.signal(nix::sys::signal::Signal::SIGINT);
            }

            // Handle SIGTERM
            _ = sigterm.recv() => {
                info!("SIGTERM received");
                break;
            }

            // Handle SIGWINCH (terminal resize)
            _ = sigwinch.recv() => {
                debug!("SIGWINCH received");
                if let Some((rows, cols)) = get_terminal_size() {
                    let _ = async_pty.resize(rows, cols);
                }
            }

            // Handle stdin (user input)
            Some(data) = stdin_rx.recv() => {
                debug!("Received {} bytes from stdin", data.len());
                if let Err(e) = async_pty.send(data).await {
                    error!("Failed to send to PTY: {}", e);
                }
            }

            // Handle injected messages from injector
            Some(data) = inject_rx.recv() => {
                if let Err(e) = async_pty.send(data).await {
                    error!("Failed to inject to PTY: {}", e);
                }
            }

            // Handle PTY output
            result = async_pty.recv() => {
                if let Some(data) = result {
                    // Check for cursor position query (CSI 6n) and respond
                    // Codex CLI sends this query and waits for response - without it, Codex times out
                    // Pattern: ESC [ 6 n or ESC [ ? 6 n
                    let text = String::from_utf8_lossy(&data);
                    if text.contains("\x1b[6n") || text.contains("\x1b[?6n") {
                        debug!("Detected cursor position query (CSI 6n), sending response");
                        // Respond with cursor at position (1, 1): ESC [ 1 ; 1 R
                        let response = b"\x1b[1;1R";
                        if let Err(e) = async_pty.send(response.to_vec()).await {
                            warn!("Failed to send cursor position response: {}", e);
                        }
                    }

                    // Auto-approve MCP servers for Claude/Cursor CLI
                    // Shows approval prompt on first run - auto-send 'a' to approve all
                    // Uses buffer + flag to handle fragmented output and prevent duplicate approvals
                    // Enhanced detection:
                    //   - Larger buffer (2500 chars) for fragmented output across read boundaries
                    //   - ANSI stripping for robust pattern matching
                    //   - Timeout-based approval (5s) as fallback for edge cases
                    //   - Partial match logging for debugging
                    if !mcp_approved.load(Ordering::SeqCst) {
                        // Accumulate recent output for fragment handling
                        mcp_detection_buffer.push_str(&text);
                        // Keep buffer bounded (increased from 1000 to handle fragmented prompts)
                        if mcp_detection_buffer.len() > 2500 {
                            // Use floor_char_boundary to avoid panicking on multi-byte UTF-8 chars
                            let start = floor_char_boundary(&mcp_detection_buffer, mcp_detection_buffer.len() - 2000);
                            mcp_detection_buffer = mcp_detection_buffer[start..].to_string();
                        }

                        // Strip ANSI codes for robust pattern matching
                        let clean_buffer = strip_ansi(&mcp_detection_buffer);

                        // Check for partial matches (for debugging and timeout-based approval)
                        let has_header = clean_buffer.contains("MCP Server Approval Required")
                            || clean_buffer.contains("MCP server approval");
                        let has_approve_option = clean_buffer.contains("[a] Approve all servers")
                            || clean_buffer.contains("Approve all")
                            || clean_buffer.contains("[a]");

                        // Log partial matches for debugging
                        if has_header && !has_approve_option {
                            debug!("MCP detection: Found header but not approve option (buffer len: {})", mcp_detection_buffer.len());
                        } else if !has_header && has_approve_option {
                            debug!("MCP detection: Found approve option but not header (buffer len: {})", mcp_detection_buffer.len());
                        }

                        // Full match: both patterns detected
                        let full_match = has_header && has_approve_option;

                        // Timeout-based approval: if we have a partial match for 5+ seconds, approve anyway
                        // This handles edge cases where prompt text changes or fragments are missed
                        let timeout_approval = if has_header || has_approve_option {
                            match mcp_partial_match_since {
                                None => {
                                    // First time seeing partial match, start timer
                                    mcp_partial_match_since = Some(Instant::now());
                                    debug!("MCP detection: Starting timeout timer for partial match");
                                    false
                                }
                                Some(since) => {
                                    let elapsed = since.elapsed();
                                    if elapsed >= MCP_APPROVAL_TIMEOUT {
                                        info!("MCP detection: Timeout reached ({:?}), approving based on partial match", elapsed);
                                        true
                                    } else {
                                        debug!("MCP detection: Partial match timer at {:?}", elapsed);
                                        false
                                    }
                                }
                            }
                        } else {
                            // No partial match, reset timer
                            if mcp_partial_match_since.is_some() {
                                debug!("MCP detection: Resetting timeout timer (no partial match)");
                                mcp_partial_match_since = None;
                            }
                            false
                        };

                        // Approve if full match or timeout reached
                        if full_match || timeout_approval {
                            if full_match {
                                info!("Detected MCP approval prompt (full match), auto-approving");
                            }
                            mcp_approved.store(true, Ordering::SeqCst);
                            // Small delay to ensure prompt is fully rendered
                            tokio::time::sleep(Duration::from_millis(100)).await;
                            if let Err(e) = async_pty.send(b"a".to_vec()).await {
                                warn!("Failed to send MCP approval: {}", e);
                            }
                            // Clear buffer and reset state after approval
                            mcp_detection_buffer.clear();
                            mcp_partial_match_since = None;
                        }
                    }

                    // Auto-Enter detection for stuck agents (CLI-agnostic)
                    // If we recently injected a message and agent has been idle too long,
                    // send Enter in case CLI is waiting for confirmation
                    if auto_enter_enabled {
                        let silence = injector.silence_ms();
                        let is_idle = injector.check_idle();
                        // Check if we had an injection in the last 60 seconds
                        let had_recent_injection = injector.had_recent_injection(60_000);

                        // Check cooldown (don't spam Enter)
                        let cooldown_ok = match last_auto_enter_time {
                            None => true,
                            Some(last) => last.elapsed() >= AUTO_ENTER_COOLDOWN,
                        };

                        // Send Enter if:
                        // 1. Agent is idle
                        // 2. Silence exceeds timeout
                        // 3. We had a recent injection (so we expect a response)
                        // 4. Cooldown period has passed
                        if is_idle && silence > auto_enter_timeout_ms && had_recent_injection && cooldown_ok {
                            info!(
                                "Agent idle for {}ms after injection - auto-sending Enter",
                                silence
                            );
                            if let Err(e) = async_pty.send(vec![0x0d]).await {
                                warn!("Failed to send auto-Enter: {}", e);
                            } else {
                                last_auto_enter_time = Some(Instant::now());
                            }
                        }
                    }

                    // Write to stdout
                    stdout.write_all(&data).await?;
                    stdout.flush().await?;

                    // Write to log file if configured
                    if let Some(ref log) = log_file {
                        let mut file = log.lock().await;
                        let _ = file.write_all(&data);
                        let _ = file.flush();
                    }

                    // Parse output
                    let parse_result = parser.process(&data);

                    // Update injector state
                    injector.record_output(&text).await;
                    injector.update_from_parse(&parse_result);

                    // Output parsed commands as JSON if enabled
                    if json_output {
                        for cmd in parse_result.commands {
                            let json = serde_json::to_string(&cmd)?;
                            eprintln!("{}", json);
                        }
                        for cmd in parse_result.continuity_commands {
                            let json = serde_json::to_string(&cmd)?;
                            eprintln!("{}", json);
                        }
                    }
                } else {
                    // PTY closed
                    info!("PTY closed");
                    break;
                }
            }

            // Handle status queries
            Some(query) = status_rx.recv() => {
                let info = StatusInfo {
                    agent_idle: injector.check_idle(),
                    queue_length: queue.len().await,
                    cursor_position: None, // Would need terminal query
                    last_output_ms: injector.silence_ms(),
                };
                let _ = query.response_tx.send(info);
            }

            // Check for stale outbox files periodically
            _ = stale_check_interval.tick() => {
                if let Some(ref mut monitor) = outbox_monitor {
                    let stale_files = monitor.check_stale().await;
                    for stale in stale_files {
                        // Always emit stale file events to stderr as JSON
                        // (regardless of --json-output flag since this is important)
                        if let Ok(json) = serde_json::to_string(&stale) {
                            eprintln!("{}", json);
                        }
                    }
                }
            }

            // Note: Response notifications are handled by the socket server
            // which subscribes to the queue's broadcast channel directly
        }

        // Check if child is still running
        if !async_pty.is_running() {
            info!("Child process exited");
            break;
        }
    }

    // Cleanup
    info!("Shutting down...");

    // Terminate child and reap
    let _ = async_pty.shutdown();

    // Restore terminal
    Pty::restore_terminal();

    // Clean up socket
    let _ = std::fs::remove_file(&socket_path);

    // Abort background tasks
    socket_handle.abort();
    injector_handle.abort();

    info!("Goodbye!");
    Ok(())
}

/// Get current terminal size
fn get_terminal_size() -> Option<(u16, u16)> {
    use nix::libc;
    use nix::pty::Winsize;

    let mut winsize = Winsize {
        ws_row: 0,
        ws_col: 0,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };

    unsafe {
        if libc::ioctl(libc::STDOUT_FILENO, libc::TIOCGWINSZ, &mut winsize) == 0 {
            Some((winsize.ws_row, winsize.ws_col))
        } else {
            None
        }
    }
}

/// Strip ANSI escape sequences from text for robust pattern matching
/// Handles CSI sequences (ESC[...), OSC sequences (ESC]...), and other common escapes
fn strip_ansi(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();

    while let Some(c) = chars.next() {
        if c == '\x1b' {
            // ESC character - start of escape sequence
            match chars.peek() {
                Some('[') => {
                    // CSI sequence: ESC [ ... final_byte
                    chars.next();
                    // Skip until we hit a letter (final byte of CSI is 0x40-0x7E)
                    while let Some(&nc) = chars.peek() {
                        chars.next();
                        if nc.is_ascii_alphabetic() || nc == '@' || nc == '`' {
                            break;
                        }
                    }
                }
                Some(']') => {
                    // OSC sequence: ESC ] ... (ST or BEL)
                    chars.next();
                    // Skip until ST (ESC \) or BEL (\x07)
                    while let Some(nc) = chars.next() {
                        if nc == '\x07' {
                            break;
                        }
                        if nc == '\x1b' && chars.peek() == Some(&'\\') {
                            chars.next();
                            break;
                        }
                    }
                }
                Some('(') | Some(')') | Some('*') | Some('+') => {
                    // Character set designation: ESC ( X, ESC ) X, etc.
                    chars.next(); // consume the character
                    chars.next(); // consume the set designator
                }
                Some(c) if *c >= '0' && *c <= '~' => {
                    // Simple escape: ESC + single char
                    chars.next();
                }
                _ => {
                    // Unknown escape, skip just the ESC
                }
            }
        } else {
            result.push(c);
        }
    }

    result
}
